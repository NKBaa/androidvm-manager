// ADB / 模拟器控制台封装
const { execFile, spawn } = require('node:child_process');
const { AsyncLocalStorage } = require('node:async_hooks');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { conf } = require('./config');

const ADB = conf.adb;

// ---------------------------------------------------------------
// 多开支持：每个虚拟机实例有独立的 adb 序列号与控制台端口。
// 用 AsyncLocalStorage 绑定"当前实例"，这样后台正在引导的实例 A
// 不会因为用户切到实例 B 而把命令发到 B 上（普通模块变量做不到）。
// ---------------------------------------------------------------
const als = new AsyncLocalStorage();
let defaultTarget = { serial: conf.serial, port: conf.consolePort };

function setTarget(serial, port) {
  defaultTarget = {
    serial: serial || defaultTarget.serial,
    port: Number(port) || defaultTarget.port,
  };
}

function currentTarget() {
  return als.getStore() || defaultTarget;
}

/** 在指定实例的上下文里执行 fn（异步安全） */
function withTarget(serial, port, fn) {
  return als.run({ serial, port: Number(port) }, fn);
}

function getTarget() {
  return currentTarget();
}

// 使用项目内的 android 用户目录（adbkey 就在这里生成），
// 而不是系统 $HOME\.android —— 两者密钥不同会导致设备一直 unauthorized。
const AUTH_HOME = path.join(conf.vmRoot, 'home', '.android');

function adbEnv() {
  const env = {
    ...process.env,
    ANDROID_HOME: conf.sdkRoot,
    ANDROID_SDK_ROOT: conf.sdkRoot,
    ANDROID_AVD_HOME: conf.avdHome,
    ANDROID_USER_HOME: AUTH_HOME,
    ADB_VENDOR_KEYS: AUTH_HOME,
  };
  // adb 在 Windows 上会往 %TEMP%\adb.log 写日志；若 TEMP 不可写会导致
  // "cannot open adb.log: Permission denied" 进而 adb server 起不来。
  const tmp = path.join(conf.vmRoot, 'home', 'adbhome');
  try {
    fs.mkdirSync(tmp, { recursive: true });
    env.TEMP = tmp;
    env.TMP = tmp;
  } catch {}
  return env;
}

let serverStarted = false;

function adb(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const serial = opts.serial || currentTarget().serial;
    const full = opts.deviceId === false ? args : ['-s', serial, ...args];
    execFile(ADB, full, { env: adbEnv(), timeout: opts.timeout || 20000, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err && !opts.allowFail) return reject(Object.assign(err, { stdout, stderr }));
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function shell(cmd, opts = {}) {
  const r = await adb(['shell', cmd], { allowFail: true, ...opts });
  // 统一换行符，避免 \r 污染解析
  return r.stdout.replace(/\r\n/g, '\n').replace(/\r/g, '').trim();
}

async function shellRoot(cmd) {
  // userdebug 镜像可直接 su 0
  return shell(`su 0 sh -c ${JSON.stringify(cmd)}`);
}

async function startAdbServer(force = false) {
  if (serverStarted && !force) return;
  if (force) {
    await new Promise((res) => {
      execFile(ADB, ['kill-server'], { env: adbEnv(), timeout: 15000, windowsHide: true }, () => res());
    });
  }
  await new Promise((res) => {
    execFile(ADB, ['start-server'], { env: adbEnv(), timeout: 15000, windowsHide: true }, () => res());
  });
  serverStarted = true;
}

async function devices() {
  await startAdbServer();
  const r = await adb(['devices'], { deviceId: false, allowFail: true });
  return r.stdout
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [id, state] = l.split(/\s+/);
      return { id, state };
    });
}

async function isOnline(serial) {
  const want = serial || currentTarget().serial;
  const list = await devices();
  return list.some((d) => d.id === want && d.state === 'device');
}

async function waitForBoot(timeoutMs = 300000, onProgress, serial) {
  const want = serial || currentTarget().serial;
  const t0 = Date.now();
  let lastReconnect = 0;
  while (Date.now() - t0 < timeoutMs) {
    const list = await devices().catch(() => []);
    const dev = list.find((d) => d.id === want);
    if (dev && dev.state === 'device') {
      const boot = await shell('getprop sys.boot_completed', { serial: want });
      if (boot === '1') return true;
    } else if (dev && dev.state === 'unauthorized') {
      // Play 商店镜像（user 版本）adbd 以 ro.adb.secure=1 运行，
      // 首次连接需要密钥授权。本机 adbkey 已写入镜像的 /data/misc/adb/adb_keys，
      // 若仍卡在 unauthorized，重新启动 adb server 让 VENDOR_KEYS 生效。
      if (Date.now() - lastReconnect > 20000) {
        lastReconnect = Date.now();
        await adb(['kill-server'], { deviceId: false, allowFail: true, timeout: 8000 });
        serverStarted = false;
        await startAdbServer();
      }
    }
    if (onProgress) onProgress(Math.round((Date.now() - t0) / 1000));
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

/** 设备连接状态：offline / unauthorized / device / 不存在 */
async function connectionState(serial) {
  const want = serial || currentTarget().serial;
  const list = await devices().catch(() => []);
  const d = list.find((x) => x.id === want);
  return d ? d.state : 'absent';
}

/**
 * 确保当前 adb shell 是 root。
 * 很多命令（cmd wifi connect-network / sqlite3 改系统库 / remount 等）
 * 以 shell(2000) 执行会直接抛 SecurityException 且 stdout 为空，
 * 只靠"输出里有没有 Permission denied"来判断会漏掉，所以这里显式升权。
 */
async function ensureRoot() {
  // 先多试几次：adb 偶尔会瞬时返回空串，若直接据此判定「没 root」，
  // 就会多余地执行 adb root（重启 adbd），把后续命令全部打断。
  for (let i = 0; i < 3; i++) {
    const uid = (await shell('id -u').catch(() => '')).trim();
    if (uid === '0') return true;
    if (uid !== '') break; // 拿到了明确的非 0 结果，确实不是 root
    await new Promise((r) => setTimeout(r, 400));
  }

  // adb root 会重启 adbd，连接会短暂断开；必须等设备回来再判断。
  await adb(['root'], { allowFail: true, timeout: 15000 }).catch(() => {});
  await adb(['wait-for-device'], { allowFail: true, timeout: 30000 }).catch(() => {});

  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 800));
    const u = (await shell('id -u').catch(() => '')).trim();
    if (u === '0') return true;
  }
  return false;
}

async function rootShell(cmd) {
  // 先确保是 root（userdebug 镜像 adb root 后 uid=0），失败再退回 su
  const isRoot = await ensureRoot().catch(() => false);
  if (isRoot) return shell(cmd);
  const direct = await shell(cmd);
  if (!/Permission denied|not found|Operation not permitted/i.test(direct)) return direct;
  const out = await shell(`su 0 sh -c ${JSON.stringify(cmd)} 2>&1`);
  const parts = out.split('\n');
  const markers = parts.filter((l) => /^(EXIT|RC)=/.test(l.trim()));
  if (markers.length > 1) return parts.slice(parts.lastIndexOf(markers[0])).join('\n');
  return out;
}

// ---------- 模拟器控制台 (telnet 5554) ----------
function consoleToken() {
  const p = path.join(conf.userHome, '.emulator_console_auth_token');
  try {
    return fs.readFileSync(p, 'utf8').trim();
  } catch {
    try {
      fs.writeFileSync(p, 'androidvm_' + Math.random().toString(36).slice(2), 'utf8');
      return fs.readFileSync(p, 'utf8').trim();
    } catch {
      return '';
    }
  }
}

function consoleCmd(commands, timeout = 6000) {
  return new Promise((resolve) => {
    const cmds = Array.isArray(commands) ? commands : [commands];
    const port = currentTarget().port || conf.consolePort;
    const sock = net.createConnection(port, '127.0.0.1');
    let buf = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { sock.end(); } catch {}
      // 去掉鉴权与帮助等噪声行，只保留真实响应
      const clean = buf
        .split(/\r?\n/)
        .filter((l) => !/^Android Console:|^'C:\\|auth <auth_token>|type 'help'/.test(l.trim()))
        .join('\n')
        .trim();
      resolve(clean);
    };
    sock.setTimeout(timeout, finish);
    sock.on('connect', () => {
      setTimeout(() => sock.write(`auth ${consoleToken()}\r\n`), 300);
      let delay = 800;
      for (const c of cmds) {
        setTimeout(() => sock.write(c + '\r\n'), delay);
        delay += 450;
      }
      setTimeout(finish, delay + 700);
    });
    sock.on('data', (d) => (buf += d.toString()));
    sock.on('error', () => finish());
    sock.on('close', finish);
  });
}

function findEmulatorPid() {
  // 通过监听端口反查进程（不依赖 wmic）
  return null;
}

module.exports = {
  adb,
  shell,
  shellRoot,
  rootShell,
  ensureRoot,
  startAdbServer,
  devices,
  isOnline,
  waitForBoot,
  connectionState,
  consoleCmd,
  consoleToken,
  adbEnv,
  setTarget,
  getTarget,
  withTarget,
  currentTarget,
  findEmulatorPid,
  // 兼容旧写法 adbmod.SERIAL（动态取当前实例）
  get SERIAL() {
    return currentTarget().serial;
  },
};
