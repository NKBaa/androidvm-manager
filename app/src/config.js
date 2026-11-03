// 全局配置：SDK 路径、AVD 路径、默认值
//
// 目录布局有两种运行形态：
//   源码运行： <vmRoot>/app/  ← 代码在这里
//             <vmRoot>/android-sdk/  <vmRoot>/avd/  <vmRoot>/_data/  <vmRoot>/home/
//   安装包运行：<安装目录>/AndroidVM.exe        ← 便携根目录 = exe 同级 AndroidVM/
//             <安装目录>/AndroidVM/android-sdk/  avd/  _data/  home/
//             resources/app.asar 里是代码
// 用环境变量 AVM_ROOT / AVM_SDK_ROOT 可以强制指定。
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// 代码目录：源码时 = <vmRoot>/app；打包后 = <resources>/app.asar
const APP_DIR = path.resolve(__dirname, '..');
const IN_ASAR = APP_DIR.includes('app.asar');

/** 数据根目录：avd / _data / home / logs 都放这里 */
function resolveVmRoot() {
  if (process.env.AVM_ROOT) return path.resolve(process.env.AVM_ROOT);
  if (IN_ASAR) {
    // 便携版：electron-builder 会把 exe 解压到临时目录再运行，
    // 数据必须放在**用户放 portable exe 的位置**，否则会写进 %TEMP% 被清掉。
    // PORTABLE_EXECUTABLE_DIR 由 portable 启动器注入。
    const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
    if (portableDir) {
      const p = path.join(portableDir, 'AndroidVM');
      try {
        fs.mkdirSync(p, { recursive: true });
        fs.accessSync(p, fs.constants.W_OK);
        return p;
      } catch {}
    }
    // 安装版：exe 同级的 AndroidVM 目录；不可写则退回 LOCALAPPDATA
    const exeDir = path.dirname(process.execPath);
    const near = path.join(exeDir, 'AndroidVM');
    try {
      fs.mkdirSync(near, { recursive: true });
      fs.accessSync(near, fs.constants.W_OK);
      return near;
    } catch {
      return path.join(process.env.LOCALAPPDATA || os.homedir(), 'AndroidVM');
    }
  }
  return path.resolve(APP_DIR, '..');
}

/** Android SDK 目录：环境变量 > 用户设置 > 数据根下 android-sdk > 系统常见位置 */
function resolveSdkRoot(vmRoot) {
  if (process.env.AVM_SDK_ROOT) return path.resolve(process.env.AVM_SDK_ROOT);
  // 用户在界面里手动指定的路径
  let fromSettings = null;
  try {
    const s = JSON.parse(fs.readFileSync(path.join(vmRoot, '_data', 'settings.json'), 'utf8'));
    if (s && s.sdkRoot) fromSettings = s.sdkRoot;
  } catch {}
  const cands = [
    fromSettings,
    path.join(vmRoot, 'android-sdk'),
    process.env.ANDROID_SDK_ROOT,
    process.env.ANDROID_HOME,
    path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk'),
  ];
  for (const c of cands) {
    if (!c) continue;
    try {
      if (fs.existsSync(path.join(c, 'emulator', 'emulator.exe'))) return path.resolve(c);
    } catch {}
  }
  return fromSettings ? path.resolve(fromSettings) : path.join(vmRoot, 'android-sdk');
}

const VM_ROOT = resolveVmRoot();
const SDK_ROOT = resolveSdkRoot(VM_ROOT);

// 日志目录：源码布局沿用 <vmRoot>/app/logs，打包后用 <vmRoot>/logs
const LOG_DIR = fs.existsSync(path.join(VM_ROOT, 'app'))
  ? path.join(VM_ROOT, 'app', 'logs')
  : path.join(VM_ROOT, 'logs');

const conf = {
  vmRoot: VM_ROOT,
  sdkRoot: SDK_ROOT,
  emulator: path.join(SDK_ROOT, 'emulator', 'emulator.exe'),
  adb: path.join(SDK_ROOT, 'platform-tools', 'adb.exe'),
  avdHome: path.join(VM_ROOT, 'avd'),
  avdName: 'A14_Root',
  consolePort: 5554,
  serial: 'emulator-5554',
  userHome: os.homedir(),
  logDir: LOG_DIR,
  appDir: APP_DIR,
  packaged: IN_ASAR,
  // process.resourcesPath 是 Electron 专有；纯 Node 环境（脚本/测试）回退按 exe 位置推算
  resourcesPath: IN_ASAR
    ? process.resourcesPath || path.join(path.dirname(process.execPath), 'resources')
    : null,
};

/** SDK 是否就绪（emulator + adb 都在） */
conf.sdkReady = (() => {
  try {
    return fs.existsSync(conf.emulator) && fs.existsSync(conf.adb);
  } catch {
    return false;
  }
})();

// 常用可切换机型（AVD 模板）
conf.devices = {
  pixel_7: { name: 'Pixel 7', brand: 'google', model: 'Pixel 7', width: 1080, height: 2400, density: 420, profile: 'pixel_7' },
  pixel_8_pro: { name: 'Pixel 8 Pro', brand: 'google', model: 'Pixel 8 Pro', width: 1344, height: 2992, density: 480, profile: 'pixel_8_pro' },
  pixel_5: { name: 'Pixel 5', brand: 'google', model: 'Pixel 5', width: 1080, height: 2340, density: 440, profile: 'pixel_5' },
  s23_ultra: { name: 'Galaxy S23 Ultra', brand: 'samsung', model: 'SM-S918B', width: 1440, height: 3088, density: 500, profile: 'Galaxy S23 Ultra' },
  mi13: { name: 'Xiaomi 13', brand: 'Xiaomi', model: '2211133C', width: 1080, height: 2400, density: 440, profile: 'pixel_7' },
  tablet: { name: '平板 (Pixel Tablet)', brand: 'google', model: 'Pixel Tablet', width: 2560, height: 1600, density: 320, profile: 'pixel_tablet' },
};

conf.netProfiles = {
  offline: { label: '离线（无网络）', speed: 'gsm', delay: 'none', offline: true },
  gsm: { label: '2G / EDGE', speed: 'gsm', delay: 'gprs', offline: false },
  gprs: { label: '2G / GPRS', speed: 'gprs', delay: 'gprs', offline: false },
  hscsd: { label: '3G / HSCSD', speed: 'hscsd', delay: 'gprs', offline: false },
  edge: { label: '2.5G / EDGE', speed: 'edge', delay: 'edge', offline: false },
  umts: { label: '3G / UMTS', speed: 'umts', delay: 'umts', offline: false },
  hsdpa: { label: '3.5G / HSPA', speed: 'hsdpa', delay: 'umts', offline: false },
  lte: { label: '4G / LTE', speed: 'lte', delay: 'lte', offline: false },
  'full-lte': { label: '4G+ / LTE-A', speed: 'full', delay: 'lte', offline: false },
  wifi: { label: 'WiFi', speed: 'full', delay: 'none', offline: false },
  '5g': { label: '5G', speed: 'full', delay: 'none', offline: false },
};

// Google ATD (Android 14, API 34) 支持的网络制式
conf.radioTypes = ['GSM', 'EDGE', 'UMTS', 'HSDPA', 'HSPA', 'LTE', '5G'];

conf.netSpeeds = ['gsm', 'gprs', 'hscsd', 'edge', 'umts', 'hsdpa', 'lte', 'evdo', 'full'];
conf.netDelays = ['none', 'gprs', 'edge', 'umts'];

// 系统镜像：
//   google_apis  = GMS + 完整 UI + userdebug（可 root，能改属性）★ 推荐用于真机模拟
//   playstore    = GMS + Play 商店，user 版本（不可 root，不能改属性）
//   atd          = 精简无 UI，userdebug（可 root，仅自动化测试用）
conf.images = {
  google_apis: {
    id: 'system-images;android-34;google_apis;x86_64',
    dir: 'system-images\\android-34\\google_apis\\x86_64\\',
    tag: 'google_apis',
    tagDisplay: 'Google APIs',
    engine: 'google_apis',
    playStore: 'yes',
    label: 'Google APIs 镜像（GMS + 完整 UI + 可 root）—— 支持真机属性改写',
    adbSecure: false,
  },
  playstore: {
    id: 'system-images;android-34;google_apis_playstore;x86_64',
    dir: 'system-images\\android-34\\google_apis_playstore\\x86_64\\',
    tag: 'google_apis_playstore',
    tagDisplay: 'Google Play',
    engine: 'playstore',
    playStore: 'yes',
    label: 'Google Play 镜像（完整 UI + Play 商店，user 版本不可 root）',
    // user 版本：adb 需先授权（已自动写入本机 adbkey）
    adbSecure: true,
  },
  atd: {
    id: 'system-images;android-34;google_atd;x86_64',
    dir: 'system-images\\android-34\\google_atd\\x86_64\\',
    tag: 'google_atd',
    tagDisplay: 'Google APIs ATD',
    engine: 'atd',
    playStore: 'yes',
    label: 'Google ATD 镜像（精简，无桌面 UI / 无设置），主要用于自动化测试',
    adbSecure: false,
  },
};

conf.defaultConfig = {
  name: 'Android 14 虚拟机',
  avdName: 'A14_Root',
  engine: 'playstore',
  image: conf.images.playstore.id,
  deviceKey: 'pixel_7',
  ram: 4096,
  cores: 4,
  diskGB: 6,
  resolution: { width: 1080, height: 2400, density: 420 },
  // host = 使用宿主机 GPU（实测唯一能稳定出画面的模式）
  gpu: { mode: 'host', renderer: 'host', enabled: true },
  // 窗口模式：visible=显示模拟器画面窗口；hidden=隐藏运行（仅通过控制台操作）
  window: 'visible',
  audio: { input: true, output: true, host: true },
  camera: { back: 'virtualscene', front: 'emulated' },
  root: true,
  writableSystem: true,
  snapshot: false,
  network: { profile: 'wifi', downloadKbps: 0, uploadKbps: 0, latencyMs: 0, packetLoss: 0, radioType: 'LTE' },
  proxy: { enabled: false, type: 'http', host: '', port: 8080, username: '', password: '', system: true },
  phone: { number: '+1 555 521 0001', imsi: '310260000000001', iccid: '8944500000000000001', operator: 'T-Mobile', country: 'us' },
};

function copyDirSync(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

/**
 * 安装包首次运行时，把随包附带的 _data（真机库 + 档案）复制到数据根目录。
 * 用 .seeded 标记文件判断，避免每次启动都重复复制 4.6MB 的真机库。
 * 源码运行时不做事（_data 本来就在根目录下）。
 */
function seedData() {
  if (!conf.packaged || !conf.resourcesPath) return { seeded: false };
  const seed = path.join(conf.resourcesPath, 'seed', '_data');
  const dst = path.join(conf.vmRoot, '_data');
  const marker = path.join(dst, '.seeded');
  if (!fs.existsSync(seed)) return { seeded: false, reason: '包内没有 seed/_data' };
  if (fs.existsSync(marker)) return { seeded: false, reason: '已播种' };
  try {
    copyDirSync(seed, dst);
    fs.writeFileSync(marker, new Date().toISOString(), 'utf8');
    return { seeded: true, to: dst };
  } catch (e) {
    return { seeded: false, reason: e.message };
  }
}

function ensureDirs() {
  for (const d of [conf.logDir, conf.avdHome, path.join(conf.vmRoot, '_data'), path.join(conf.vmRoot, 'home')]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch {}
  }
  try { seedData(); } catch {}
}

module.exports = { conf, ensureDirs, seedData };
