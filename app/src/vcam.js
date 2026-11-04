// 虚拟摄像头（Softcam 驱动 + 喂帧工具）
//
// 为什么需要它：
//   Android 模拟器的摄像头只支持 4 种来源：emulated / virtualscene / imagefile / webcamN。
//   前三种实测都不可用（imagefile 与 virtualscene 会静默回退成 emulated）。
//   唯一可靠的路子是 webcamN —— 即 DirectShow 透传，MuMu / BlueStacks 也是这么做的。
//
// 组成（都随包附带）：
//   softcam.dll       DirectShow 视频输入滤镜，注册后系统里出现 "DirectShow Softcam" 摄像头
//                     （tshino/softcam，MIT）
//   vcam_feeder.exe   喂帧工具，读取 BGR24 原始帧并调用 scSendFrame 推给虚拟摄像头
//
// 安装位置用 %ProgramData%\AndroidVM\vcam —— 机器级 COM 注册绝不能指向用户可写目录，
// 否则同用户下的其它进程可以替换 DLL。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile, spawn } = require('node:child_process');

const { conf } = require('./config');

const FILTER_NAME = 'DirectShow Softcam';
const FILTER_CLSID = '{AEF3B972-5FA5-4647-9571-358EB472BC9E}';
const REG_KEY = 'HKLM\\Software\\AndroidVM\\VirtualCamera';

function binDir() {
  return path.join(process.env.ProgramData || 'C:\\ProgramData', 'AndroidVM', 'vcam');
}

/** 随包文件位置（开发模式在 app/build/vcam，打包后在 resources/vcam） */
function sourceDir() {
  const cands = [];
  if (conf.packaged && conf.resourcesPath) cands.push(path.join(conf.resourcesPath, 'vcam'));
  cands.push(path.join(conf.appDir, 'build', 'vcam'));
  for (const p of cands) {
    try {
      if (fs.existsSync(path.join(p, 'softcam.dll'))) return p;
    } catch {}
  }
  return null;
}

function run(file, args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? err.code : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || (err ? err.message : '')),
      });
    });
  });
}

function queryReg(key, value) {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, ...(value ? ['/v', value] : [])], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      resolve(err ? '' : String(stdout || ''));
    });
  });
}

/** 是否已安装并注册 */
async function status() {
  const dll = path.join(binDir(), 'softcam.dll');
  const feeder = path.join(binDir(), 'vcam_feeder.exe');
  const hasFiles = fs.existsSync(dll) && fs.existsSync(feeder);

  const clsid = await queryReg(`HKLM\\Software\\Classes\\CLSID\\${FILTER_CLSID}`);
  const registered = !!clsid;
  const rec = await queryReg(REG_KEY, 'DllPath');
  const recorded = (rec.match(/DllPath\s+REG_SZ\s+(.+)/) || [])[1];

  return {
    installed: hasFiles && registered,
    hasFiles,
    registered,
    dllPath: dll,
    feederPath: feeder,
    recordedPath: recorded ? recorded.trim() : '',
    binDir: binDir(),
    filterName: FILTER_NAME,
    clsid: FILTER_CLSID,
    sourceDir: sourceDir(),
  };
}

/** 安装：复制文件到 ProgramData → regsvr32 注册 → 记录路径 */
async function install() {
  const src = sourceDir();
  if (!src) return { ok: false, message: '安装包里缺少 vcam 文件（softcam.dll / vcam_feeder.exe）' };

  const dst = binDir();
  fs.mkdirSync(dst, { recursive: true });
  for (const f of ['softcam.dll', 'vcam_feeder.exe']) {
    fs.copyFileSync(path.join(src, f), path.join(dst, f));
  }
  // 许可证一起带上，便于审计
  try {
    fs.copyFileSync(path.join(src, 'LICENSE-softcam.txt'), path.join(dst, 'LICENSE-softcam.txt'));
  } catch {}

  const dll = path.join(dst, 'softcam.dll');
  const reg = await run('regsvr32', ['/s', dll]);
  if (!reg.ok) {
    return { ok: false, message: 'regsvr32 注册失败：' + (reg.stderr || reg.stdout || '未知错误') };
  }

  await run('reg', [
    'add', REG_KEY, '/v', 'DllPath', '/t', 'REG_SZ', '/d', dll, '/f',
  ]);
  await run('reg', [
    'add', REG_KEY, '/v', 'FilterName', '/t', 'REG_SZ', '/d', FILTER_NAME, '/f',
  ]);

  const st = await status();
  return { ok: st.installed, message: st.installed ? '' : '注册后仍检测不到滤镜，可能需要重启系统', status: st };
}

/** 卸载：注销 → 删文件 → 删注册表记录 */
async function uninstall() {
  const dll = path.join(binDir(), 'softcam.dll');
  if (fs.existsSync(dll)) {
    await run('regsvr32', ['/u', '/s', dll]);
  }
  // 即使 dll 已不在也要清理注册表
  await run('reg', ['delete', REG_KEY, '/f']);

  try {
    fs.rmSync(binDir(), { recursive: true, force: true });
  } catch (e) {
    return { ok: false, message: '注销成功，但删除文件失败：' + e.message };
  }
  const st = await status();
  return { ok: !st.registered, status: st };
}

// ---------------------------------------------------------------
// 喂帧
// ---------------------------------------------------------------
let feeder = null;
let frameFile = null;
let readyFile = null;

function framesDir() {
  const d = path.join(conf.vmRoot, '_data', 'vcam');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/**
 * 启动喂帧进程。
 * @param {{width:number, height:number, fps:number}} opts
 */
async function startFeeder({ width = 640, height = 480, fps = 10 } = {}) {
  await stopFeeder();
  const st = await status();
  if (!st.installed) return { ok: false, message: '虚拟摄像头尚未安装' };

  const dir = framesDir();
  frameFile = path.join(dir, 'frame.bgr');
  readyFile = path.join(dir, 'ready.flag');
  try {
    fs.rmSync(readyFile, { force: true });
    fs.rmSync(frameFile, { force: true });
  } catch {}

  feeder = spawn(
    st.feederPath,
    [
      '--width', String(width),
      '--height', String(height),
      '--fps', String(fps),
      '--file', frameFile,
      '--ready', readyFile,
      '--parent', String(process.pid),
    ],
    { windowsHide: true, detached: false, stdio: 'ignore' }
  );

  feeder.on('exit', () => {
    feeder = null;
  });
  feeder.on('error', (e) => {
    console.error('[vcam] 喂帧进程启动失败:', e.message);
    feeder = null;
  });

  // 等它就绪（最多 5 秒）
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (fs.existsSync(readyFile)) return { ok: true, width, height, fps, frameFile };
    if (!feeder) break;
  }
  const alive = !!feeder;
  if (!alive) return { ok: false, message: '喂帧进程已退出（可能已有另一个实例在占用虚拟摄像头）' };
  return { ok: true, width, height, fps, frameFile, slow: true };
}

async function stopFeeder() {
  if (feeder) {
    try {
      feeder.kill();
    } catch {}
    feeder = null;
  }
  await new Promise((r) => setTimeout(r, 150));
  return { ok: true };
}

function feederAlive() {
  return !!feeder;
}

/**
 * 写入一帧（BGR24 原始数据）。
 * 先写临时文件再原子改名，避免喂帧进程读到半截数据。
 */
function writeFrame(bgrBuffer) {
  if (!frameFile) return false;
  const tmp = frameFile + '.tmp';
  try {
    fs.writeFileSync(tmp, bgrBuffer);
    fs.renameSync(tmp, frameFile);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  FILTER_NAME,
  FILTER_CLSID,
  status,
  install,
  uninstall,
  startFeeder,
  stopFeeder,
  feederAlive,
  writeFrame,
  binDir,
  framesDir,
};
