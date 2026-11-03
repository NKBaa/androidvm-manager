// electron-builder afterPack 钩子
//
// 为什么需要这个钩子：
//   本机是非管理员环境，7-Zip 无法创建 winCodeSign 包里的 macOS 符号链接，
//   electron-builder 内置的 rcedit 步骤因此失败。我们用 signAndEditExecutable:false
//   跳过它，然后在这里自己调用 rcedit 补上图标与版本信息。
//   （resedit 纯 JS 方案试过，能写图标和文件版本号，但字符串表写不进去，故用 rcedit。）
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  const exePath = path.join(context.appOutDir, 'AndroidVM.exe');
  const icoPath = path.join(__dirname, 'icon.ico');
  const manifestPath = path.join(__dirname, 'app.manifest');
  const rcedit = path.join(__dirname, 'rcedit-x64.exe');

  if (!fs.existsSync(exePath)) {
    console.warn('[afterPack] 找不到 exe: ' + exePath);
    return;
  }
  if (!fs.existsSync(rcedit)) {
    console.warn('[afterPack] 缺少 rcedit-x64.exe，跳过图标/版本写入');
    return;
  }

  const pkg = require(path.join(context.packager.projectDir, 'package.json'));
  const ver = (pkg.version || '1.0.0') + '.0';

  const args = [
    exePath,
    '--set-file-version', ver,
    '--set-product-version', ver,
    '--set-version-string', 'ProductName', 'AndroidVM',
    '--set-version-string', 'FileDescription', 'Android 14 虚拟机管理器',
    '--set-version-string', 'CompanyName', 'local',
    '--set-version-string', 'LegalCopyright', 'Android 14 虚拟机管理器',
    '--set-version-string', 'OriginalFilename', 'AndroidVM.exe',
  ];
  if (fs.existsSync(icoPath)) args.push('--set-icon', icoPath);
  // 关键：替换成 requireAdministrator 清单，程序启动时由用户点 UAC 同意
  if (fs.existsSync(manifestPath)) args.push('--application-manifest', manifestPath);
  else console.warn('[afterPack] 找不到 app.manifest，exe 将不会强制提权');

  try {
    execFileSync(rcedit, args, { stdio: 'inherit', windowsHide: true });
    console.log('[afterPack] 已写入图标、版本信息与管理员权限清单: ' + exePath);
  } catch (e) {
    // 清单写失败不能让图标和版本也丢掉 —— 去掉清单参数重试一次
    console.warn('[afterPack] 带清单写入失败（' + e.message + '），改为只写图标与版本');
    const fallback = args.filter((a, i) => a !== '--application-manifest' && args[i - 1] !== '--application-manifest');
    try {
      execFileSync(rcedit, fallback, { stdio: 'inherit', windowsHide: true });
      console.warn('[afterPack] 已写入图标与版本，但**没有**应用管理员权限清单');
    } catch (e2) {
      console.warn('[afterPack] rcedit 失败: ' + e2.message);
    }
  }
};
