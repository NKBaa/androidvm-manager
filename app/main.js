// Electron 主进程
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { conf } = require('./src/config');
const { VmManager } = require('./src/vm');
const adbmod = require('./src/adb');
const net = require('./src/network');
const prox = require('./src/proxy');
const phone = require('./src/phone');
const dev = require('./src/device');
const dp = require('./src/deviceprofile');
const wifi = require('./src/wifi');
const bt = require('./src/bluetooth');
const cell = require('./src/cellular');
const instances = require('./src/instances');
const sdkdownloader = require('./src/sdkdownloader');
const cameramod = require('./src/camera');

// ---------------------------------------------------------------
// 多开：每个实例一个 VmManager，按需创建并缓存。
// 所有 IPC 执行前把 adb 默认目标切到"当前实例"；
// 后台正在引导的实例用 AsyncLocalStorage 绑定，互不干扰。
// ---------------------------------------------------------------
const managers = new Map();

function managerFor(inst) {
  if (!inst) throw new Error('没有可用实例');
  let m = managers.get(inst.id);
  if (!m) {
    m = new VmManager({
      id: inst.id,
      name: inst.name,
      avdName: inst.avdName,
      port: inst.port,
      stateFile: instances.stateFile(inst.id),
      logFile: path.join(conf.logDir, `emulator-${inst.id}.log`),
    });
    managers.set(inst.id, m);
  }
  return m;
}

function activeVm() {
  const inst = instances.active();
  if (!inst) throw new Error('没有可用实例');
  adbmod.setTarget(instances.serialOf(inst.port), inst.port);
  return managerFor(inst);
}

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: '#080b11',
    title: 'Android 14 虚拟机管理器',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
}

app.whenReady().then(async () => {
  // 安装包首次运行：创建数据目录并从 resources/seed 播种真机库与档案
  try {
    const { ensureDirs } = require('./src/config');
    ensureDirs();
  } catch (e) {
    console.error('初始化数据目录失败:', e.message);
  }
  createWindow();
  await adbmod.startAdbServer().catch(() => {});
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 安全包装：每次 IPC 执行前把 adb 默认目标切到当前实例
function wrap(fn) {
  return async (_e, ...args) => {
    try {
      const inst = instances.active();
      if (inst) adbmod.setTarget(instances.serialOf(inst.port), inst.port);
      const data = await fn(...args);
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err), stack: err && err.stack };
    }
  };
}

// ---------------- IPC ----------------
ipcMain.handle('app:info', wrap(async () => {
  const inst = instances.active();
  return {
    version: app.getVersion(),
    configPath: instances.stateFile(inst.id),
    sdkRoot: conf.sdkRoot,
    vmRoot: conf.vmRoot,
    packaged: conf.packaged,
    sdkReady: sdkdownloader.checkSdk(conf.sdkRoot).ready,
    emulatorPath: conf.emulator,
    adbPath: conf.adb,
    avdName: inst.avdName,
    instance: inst,
  };
}));

// 让用户手动指定 SDK 目录（写入环境变量级别不现实，存到 _data/settings.json）
ipcMain.handle('app:setSdkRoot', wrap(async (dir) => {
  const file = path.join(conf.vmRoot, '_data', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let s = {};
  try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  s.sdkRoot = dir || null;
  fs.writeFileSync(file, JSON.stringify(s, null, 2), 'utf8');
  return { ok: true, note: '已保存，重启应用后生效' };
}));
ipcMain.handle('ui:pickSdkDir', wrap(async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: '选择 Android SDK 目录（应包含 emulator 与 platform-tools）' });
  return r.canceled ? null : r.filePaths[0];
}));

// ---------- SDK 在线下载 ----------
let sdkCancel = false;
ipcMain.handle('sdk:check', wrap(async () => {
  const r = sdkdownloader.checkSdk(conf.sdkRoot);
  conf.sdkReady = r.ready;
  return r;
}));

ipcMain.handle('sdk:cancel', wrap(async () => { sdkCancel = true; return { ok: true }; }));

// 可用镜像源
ipcMain.handle('sdk:mirrors', wrap(async () => ({
  mirrors: sdkdownloader.MIRRORS,
  default: sdkdownloader.DEFAULT_MIRROR,
})));

// 未下完的分片（用于界面提示「可续传」）
ipcMain.handle('sdk:pending', wrap(async () => sdkdownloader.pendingDownloads(conf.sdkRoot)));

ipcMain.handle('sdk:download', wrap(async (opts) => {
  sdkCancel = false;
  const sdkRoot = (opts && opts.sdkRoot) || conf.sdkRoot;
  const packages = (opts && opts.packages) || sdkdownloader.PRESETS.minimal;
  const mirror = (opts && opts.mirror) || sdkdownloader.DEFAULT_MIRROR;

  const send = (o) => {
    try { if (win && !win.isDestroyed()) win.webContents.send('sdk:progress', o); } catch {}
  };

  // 后台跑，立即返回，进度通过 sdk:progress 事件推给界面
  sdkdownloader
    .install({
      sdkRoot,
      packages,
      mirror,
      onProgress: send,
      isCancelled: () => sdkCancel,
    })
    .then((r) => {
      conf.sdkReady = !!(r && r.ok);
      send({ phase: 'complete', result: r });
    })
    .catch((e) => send({ phase: 'error', message: e && e.message ? e.message : String(e) }));

  return { started: true, sdkRoot, packages, mirror };
}));

// ---------- 摄像头 ----------
ipcMain.handle('camera:hosts', wrap(async () => cameramod.listHostCameras()));
ipcMain.handle('camera:status', wrap(async () => cameramod.getStatus()));
ipcMain.handle('camera:set', wrap(async (src) => cameramod.setSource(src || {})));
ipcMain.handle('camera:images', wrap(async () => cameramod.listImagesWithThumbs()));
ipcMain.handle('camera:deleteImage', wrap(async (name) => cameramod.deleteImage(name)));
ipcMain.handle('camera:captureScreen', wrap(async () => cameramod.captureScreen()));
ipcMain.handle('camera:crop', wrap(async (o) => cameramod.cropAndSave(o.dataUrl, o.rect, o.name)));
ipcMain.handle('camera:pickImage', wrap(async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择作为摄像头画面的图片',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg'] }],
  });
  if (r.canceled || !r.filePaths.length) return null;
  const src = r.filePaths[0];
  const buf = fs.readFileSync(src);
  const ext = path.extname(src).toLowerCase() === '.png' ? 'png' : 'jpg';
  return cameramod.saveImage(`data:image/${ext};base64,${buf.toString('base64')}`, path.basename(src));
}));

// ---------- 多开实例 ----------
ipcMain.handle('instances:list', wrap(async () => {
  const list = await instances.list();
  // 交叉校验：adb devices 里在线的才算真正就绪
  const online = await adbmod.devices().catch(() => []);
  for (const it of list) {
    it.online = online.some((d) => d.id === it.serial && d.state === 'device');
    it.booting = !!it.listening && !it.online;
    // 设备卡片要展示的摘要信息
    try {
      const cfg = instances.loadState(it.id) || {};
      it.summary = {
        ram: cfg.ram || 4096,
        cores: cfg.cores || 4,
        diskGB: cfg.diskGB || 6,
        width: (cfg.resolution && cfg.resolution.width) || 1080,
        height: (cfg.resolution && cfg.resolution.height) || 2400,
        density: (cfg.resolution && cfg.resolution.density) || 420,
        image: cfg.image || 'google_apis',
        root: !!cfg.root,
        deviceKey: cfg.deviceKey || '',
      };
    } catch {
      it.summary = null;
    }
  }
  return { activeId: instances.load().activeId, list };
}));

// 磁盘清理：清掉应用缓存，释放空间
ipcMain.handle('instances:clean', wrap(async (id) => {
  await instances.setActive(id);
  const out = await adbmod.shell('pm trim-caches 999G').catch((e) => '失败: ' + e.message);
  return { ok: true, output: String(out || '') };
}));

// 备份：把该实例的 userdata 镜像复制一份
ipcMain.handle('instances:backup', wrap(async (id) => {
  const inst = instances.get(id);
  if (!inst) throw new Error('实例不存在');
  const avdDir = path.join(conf.avdHome, inst.avdName + '.avd');
  const src = path.join(avdDir, 'userdata-qemu.img');
  if (!fs.existsSync(src)) throw new Error('没有可备份的数据镜像（虚拟机可能还没运行过）');
  const dstDir = path.join(conf.vmRoot, '_data', 'backups');
  fs.mkdirSync(dstDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const dst = path.join(dstDir, `${inst.id}-${stamp}.img`);
  fs.copyFileSync(src, dst);
  return { ok: true, file: dst, bytes: fs.statSync(dst).size };
}));

ipcMain.handle('instances:backups', wrap(async (id) => {
  const dir = path.join(conf.vmRoot, '_data', 'backups');
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(id + '-') && f.endsWith('.img'))
      .map((f) => ({ file: f, path: path.join(dir, f), bytes: fs.statSync(path.join(dir, f)).size, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}));

ipcMain.handle('instances:restore', wrap(async (id, file) => {
  const inst = instances.get(id);
  if (!inst) throw new Error('实例不存在');
  const src = path.join(conf.vmRoot, '_data', 'backups', path.basename(file));
  if (!fs.existsSync(src)) throw new Error('备份文件不存在');
  const dst = path.join(conf.avdHome, inst.avdName + '.avd', 'userdata-qemu.img');
  fs.copyFileSync(src, dst);
  return { ok: true, file: dst };
}));

// 创建桌面快捷方式
ipcMain.handle('instances:shortcut', wrap(async (id) => {
  const inst = instances.get(id);
  if (!inst) throw new Error('实例不存在');
  const desktop = path.join(os.homedir(), 'Desktop');
  if (!fs.existsSync(desktop)) throw new Error('找不到桌面目录');
  const target = process.execPath;
  const workDir = path.dirname(target);
  const lnk = path.join(desktop, `${inst.name}.lnk`);
  const ps = [
    '$s=(New-Object -ComObject WScript.Shell).CreateShortcut(' + JSON.stringify(lnk) + ');',
    '$s.TargetPath=' + JSON.stringify(target) + ';',
    '$s.WorkingDirectory=' + JSON.stringify(workDir) + ';',
    '$s.IconLocation=' + JSON.stringify(target + ',0') + ';',
    '$s.Description=' + JSON.stringify('Android 14 虚拟机 · ' + inst.name) + ';',
    '$s.Save();',
  ].join(' ');
  await new Promise((resolve, reject) => {
    execFile('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true, timeout: 20000 }, (err, so, se) =>
      err ? reject(new Error(se || err.message)) : resolve(true)
    );
  });
  return { ok: true, file: lnk };
}));
ipcMain.handle('instances:create', wrap(async (opts) => {
  const inst = await instances.create(opts || {});
  return inst;
}));
ipcMain.handle('instances:remove', wrap(async (id) => {
  const inst = instances.get(id);
  if (!inst) throw new Error('实例不存在');
  const m = managers.get(id);
  const running = m ? !!(await m.status()).running : await instances.portInUse(inst.port);
  if (running) throw new Error('实例正在运行，请先停止再删除');
  managers.delete(id);
  instances.remove(id);
  return instances.load();
}));
ipcMain.handle('instances:rename', wrap(async (id, name) => instances.rename(id, name)));
ipcMain.handle('instances:setActive', wrap(async (id) => {
  const inst = instances.setActive(id);
  adbmod.setTarget(instances.serialOf(inst.port), inst.port);
  return inst;
}));
ipcMain.handle('instances:active', wrap(async () => instances.active()));

ipcMain.handle('config:get', wrap(async () => activeVm().getConfig()));
ipcMain.handle('config:save', wrap(async (cfg) => { const m = activeVm(); m.saveState(cfg); return m.getConfig(); }));

ipcMain.handle('vm:start', wrap(async (opts) => activeVm().start(opts || {})));
ipcMain.handle('vm:stop', wrap(async () => activeVm().stop()));
ipcMain.handle('vm:restart', wrap(async () => activeVm().restart()));
ipcMain.handle('vm:status', wrap(async () => activeVm().status()));
ipcMain.handle('vm:log', wrap(async (n) => activeVm().readLog(n)));
ipcMain.handle('vm:devices', wrap(async () => adbmod.devices()));
ipcMain.handle('vm:openLogDir', wrap(async () => { shell.openPath(conf.logDir); return true; }));

ipcMain.handle('net:apply', wrap(async (n) => net.setNetwork(n)));
ipcMain.handle('net:status', wrap(async () => net.getNetworkStatus()));
ipcMain.handle('net:test', wrap(async () => net.testConnectivity()));
ipcMain.handle('net:offline', wrap(async (v) => net.setOffline(v)));

ipcMain.handle('proxy:apply', wrap(async (p) => prox.setProxy(p)));
ipcMain.handle('proxy:status', wrap(async () => prox.getProxyStatus()));

ipcMain.handle('phone:set', wrap(async (p) => phone.setPhoneNumber(p)));
ipcMain.handle('phone:status', wrap(async () => phone.getPhoneNumber()));
ipcMain.handle('phone:call', wrap(async (a, n) => phone.call(a, n)));
ipcMain.handle('phone:signal', wrap(async (l) => phone.signal(l)));
ipcMain.handle('phone:data', wrap(async (a) => phone.networkStatus(a)));
ipcMain.handle('phone:sms', wrap(async (from, text) => phone.receiveSms(from, text)));
ipcMain.handle('phone:listSms', wrap(async (n) => phone.listSms(n)));

ipcMain.handle('dev:root', wrap(async (v) => dev.setRoot(v)));
ipcMain.handle('dev:rootStatus', wrap(async () => dev.getRootStatus()));
ipcMain.handle('dev:disk', wrap(async () => dev.getDisk()));
ipcMain.handle('dev:sdcard', wrap(async () => dev.getSdcard()));
ipcMain.handle('dev:display', wrap(async (d) => dev.setDisplay(d)));
ipcMain.handle('dev:displayStatus', wrap(async () => dev.getDisplay()));
ipcMain.handle('dev:displayReset', wrap(async () => dev.resetDisplay()));
ipcMain.handle('dev:screenshot', wrap(async () => {
  const buf = await dev.screenshot();
  return 'data:image/png;base64,' + buf.toString('base64');
}));
ipcMain.handle('dev:volume', wrap(async (v) => dev.setVolume(v)));
ipcMain.handle('dev:audio', wrap(async () => dev.getAudio()));
ipcMain.handle('dev:speaker', wrap(async (s) => dev.setSpeaker(s)));
ipcMain.handle('dev:camera', wrap(async (c) => dev.setCamera(c)));
ipcMain.handle('dev:cameraStatus', wrap(async () => dev.getCamera()));
ipcMain.handle('dev:setDevice', wrap(async (k, o) => dev.setDevice(k, o || {})));
ipcMain.handle('dev:info', wrap(async () => dev.getDeviceInfo()));
ipcMain.handle('dev:shell', wrap(async (cmd) => adbmod.shell(cmd)));
ipcMain.handle('dev:rootShell', wrap(async (cmd) => adbmod.rootShell(cmd)));
ipcMain.handle('dev:console', wrap(async (cmds) => adbmod.consoleCmd(cmds)));

// 快捷操作：导航键 / 音量 / 电源 / 旋转
const KEYCODES = {
  back: 4, home: 3, recents: 187, menu: 82,
  volume_up: 24, volume_down: 25, power: 26,
  wakeup: 224, sleep: 223,
};
ipcMain.handle('dev:key', wrap(async (name) => {
  const code = KEYCODES[String(name)] || Number(name);
  if (!code) throw new Error('未知按键: ' + name);
  await adbmod.shell(`input keyevent ${code}`);
  return { key: name, code };
}));

ipcMain.handle('dev:rotate', wrap(async (deg) => {
  const map = { 0: 0, 90: 1, 180: 2, 270: 3 };
  const rot = map[Number(deg)] !== undefined ? map[Number(deg)] : 0;
  await adbmod.rootShell(
    `settings put system accelerometer_rotation 0; settings put system user_rotation ${rot}; true`
  );
  return { rotation: Number(deg) || 0, userRotation: rot };
}));

// ---------- WiFi / 蓝牙 / 移动网络 ----------
ipcMain.handle('wifi:enable', wrap(async (on) => wifi.setEnabled(on)));
ipcMain.handle('wifi:connect', wrap(async (s, sec, pw) => wifi.connect(s, sec, pw)));
ipcMain.handle('wifi:add', wrap(async (s, sec, pw) => wifi.addNetwork(s, sec, pw)));
ipcMain.handle('wifi:list', wrap(async () => wifi.listNetworks()));
ipcMain.handle('wifi:forget', wrap(async (id) => wifi.forgetNetwork(id)));
ipcMain.handle('wifi:scan', wrap(async () => wifi.listScanResults()));
ipcMain.handle('wifi:status', wrap(async () => wifi.getStatus()));

ipcMain.handle('bt:enable', wrap(async (on, force) => bt.setEnabled(on, { force: !!force })));
ipcMain.handle('bt:name', wrap(async (n) => bt.setName(n)));
ipcMain.handle('bt:paired', wrap(async () => bt.listPaired()));
ipcMain.handle('bt:status', wrap(async () => bt.getStatus()));

ipcMain.handle('cell:signal', wrap(async (lv) => cell.setSignal(lv)));
ipcMain.handle('cell:rssi', wrap(async (r, b) => cell.setRssi(r, b)));
ipcMain.handle('cell:data', wrap(async (s) => cell.setData(s)));
ipcMain.handle('cell:voice', wrap(async (s) => cell.setVoice(s)));
ipcMain.handle('cell:meter', wrap(async (m) => cell.setMeter(m)));
ipcMain.handle('cell:operator', wrap(async (n) => cell.setOperator(n)));
ipcMain.handle('cell:nettype', wrap(async (t) => cell.setNetworkType(t)));
ipcMain.handle('cell:roaming', wrap(async (on) => cell.setRoaming(on)));
ipcMain.handle('cell:status', wrap(async () => cell.getStatus()));

// ---------- 真机档案 ----------
ipcMain.handle('profile:db', wrap(async () => dp.dbStats()));
ipcMain.handle('profile:search', wrap(async (kw, n) => dp.searchDevices(kw, n || 20)));
ipcMain.handle('profile:list', wrap(async () => dp.listProfiles()));
ipcMain.handle('profile:identity', wrap(async () => dp.readIdentity()));
ipcMain.handle('profile:active', wrap(async () => dp.getActiveProfile()));
ipcMain.handle('profile:canSpoof', wrap(async () => dp.canSpoof()));
ipcMain.handle('profile:apply', wrap(async (name) => {
  let profile;
  try {
    profile = dp.loadProfile(name);
  } catch {
    const rows = dp.searchDevices(name, 50);
    if (!rows.length) throw new Error(`档案 "${name}" 不存在`);
    profile = dp.profileFromDevice(rows[0]);
  }
  await dp.backupProps();
  return dp.applyProfile(profile);
}));
ipcMain.handle('profile:revert', wrap(async () => dp.revertProfile()));
ipcMain.handle('engine:set', wrap(async (engine) => activeVm().setEngine(engine)));
ipcMain.handle('engine:current', wrap(async () => activeVm().getConfig().engine));

ipcMain.handle('ui:pickApk', wrap(async () => {  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'APK', extensions: ['apk'] }] });
  return r.canceled ? null : r.filePaths[0];
}));
ipcMain.handle('ui:installApk', wrap(async (file) => {
  const r = await adbmod.adb(['install', '-r', file], { timeout: 180000, allowFail: true });
  return (r.stdout + r.stderr).trim();
}));
