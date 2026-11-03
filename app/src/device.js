// 设备设置：root 开关 / 磁盘 / 显示 / 声音 / 摄像头 / 扬声器 / 机型
const fs = require('node:fs');
const path = require('node:path');
const adbmod = require('./adb');
const { conf } = require('./config');

// ---------- root ----------
async function setRoot(enabled) {
  if (enabled) {
    const out = await adbmod.adb(['root'], { allowFail: true, timeout: 15000 });
    return { ok: !out.stderr.includes('cannot'), raw: (out.stdout + out.stderr).trim() };
  }
  // 关闭 root：断开 root shell，回到普通 shell
  await adbmod.adb(['unroot'], { allowFail: true, timeout: 15000 }).catch(() => {});
  const id = await adbmod.shell('id -u').catch(() => '');
  return { ok: id.trim() !== '0', uid: id.trim() };
}

async function getRootStatus() {
  const uid = (await adbmod.shell('id -u').catch(() => '')).trim();
  const dbg = (await adbmod.shell('getprop ro.debuggable').catch(() => '')).trim();
  const selinux = (await adbmod.shell('getenforce').catch(() => '')).trim();
  return { root: uid === '0', uid, debuggable: dbg === '1', selinux };
}

// ---------- 磁盘 ----------
async function getDisk() {
  const out = await adbmod.rootShell('df -h /data /sdcard /system 2>/dev/null').catch(() => '');
  const ini = fs.readFileSync(path.join(conf.avdHome, conf.avdName + '.avd', 'config.ini'), 'utf8');
  const m = ini.match(/disk\.dataPartition\.size=(\S+)/);
  return { raw: out.trim(), configuredSize: m ? m[1] : '未设置' };
}

async function getSdcard() {
  const out = await adbmod.rootShell('df -h /sdcard 2>/dev/null; ls /sdcard').catch(() => '');
  return out.trim();
}

// ---------- 显示 ----------
async function setDisplay({ width, height, density }) {
  const results = {};
  if (width && height) {
    results.size = await adbmod.shell(`wm size ${width}x${height}`);
  }
  if (density) {
    results.density = await adbmod.shell(`wm density ${density}`);
  }
  return results;
}

async function getDisplay() {
  const size = await adbmod.shell('wm size').catch(() => '');
  const density = await adbmod.shell('wm density').catch(() => '');
  return { size: size.trim(), density: density.trim() };
}

async function resetDisplay() {
  await adbmod.shell('wm size reset');
  await adbmod.shell('wm density reset');
}

async function screenshot() {
  // 使用 screencap 输出到 sdcard 再拉回
  const tmp = `/data/local/tmp/shot_${Date.now()}.png`;
  await adbmod.shell(`screencap -p ${tmp}`);
  const buf = await new Promise((resolve, reject) => {
    const { execFile } = require('node:child_process');
    execFile(
      conf.adb,
      ['-s', adbmod.SERIAL, 'exec-out', 'screencap', '-p'],
      { env: adbmod.adbEnv(), encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    );
  });
  await adbmod.shell(`rm -f ${tmp}`).catch(() => {});
  return buf;
}

// ---------- 声音 ----------
async function setVolume({ music, ring, alarm, call }) {
  const map = { music: 3, ring: 2, alarm: 4, call: 0 };
  const out = {};
  for (const [k, stream] of Object.entries(map)) {
    if (v(k) === undefined) continue;
    const val = Math.max(0, Math.min(15, Number(v(k))));
    out[k] = await adbmod.shell(`media volume --stream ${stream} --set ${val}`);
  }
  function v(k) { return k === 'music' ? music : k === 'ring' ? ring : k === 'alarm' ? alarm : call; }
  return out;
}

async function getAudio() {
  const vol = await adbmod.shell('dumpsys audio | grep -m6 -E "STREAM_|streamVolume" ').catch(() => '');
  const devices = await adbmod.shell('dumpsys audio | grep -m5 "Devices:"').catch(() => '');
  return { volume: vol.trim(), devices: devices.trim() };
}

async function setMute(mute) {
  return adbmod.shell(`media volume --stream 3 --set ${mute ? 0 : 8}`);
}

// ---------- 摄像头 ----------
async function setCamera({ back, front }) {
  const avdFile = path.join(conf.avdHome, conf.avdName + '.avd', 'config.ini');
  let ini = fs.readFileSync(avdFile, 'utf8');
  if (back) ini = ini.replace(/^hw\.camera\.back=.*$/m, `hw.camera.back=${back}`);
  if (front) ini = ini.replace(/^hw\.camera\.front=.*$/m, `hw.camera.front=${front}`);
  fs.writeFileSync(avdFile, ini, 'utf8');
  return { ok: true, needRestart: true };
}

async function getCamera() {
  const avdFile = path.join(conf.avdHome, conf.avdName + '.avd', 'config.ini');
  const ini = fs.readFileSync(avdFile, 'utf8');
  const back = (ini.match(/hw\.camera\.back=(.*)/) || [])[1];
  const front = (ini.match(/hw\.camera\.front=(.*)/) || [])[1];
  return { back: (back || '').trim(), front: (front || '').trim() };
}

// ---------- 机型 ----------
async function setDevice(deviceKey, { width, height, density }) {
  const dev = conf.devices[deviceKey];
  if (!dev) throw new Error('未知机型: ' + deviceKey);
  const avdFile = path.join(conf.avdHome, conf.avdName + '.avd', 'config.ini');
  let ini = fs.readFileSync(avdFile, 'utf8');
  const w = width || dev.width, h = height || dev.height, d = density || dev.density;
  ini = ini
    .replace(/^hw\.device\.name=.*$/m, `hw.device.name=${dev.profile}`)
    .replace(/^hw\.device\.manufacturer=.*$/m, `hw.device.manufacturer=${dev.brand}`)
    .replace(/^hw\.lcd\.width=.*$/m, `hw.lcd.width=${w}`)
    .replace(/^hw\.lcd\.height=.*$/m, `hw.lcd.height=${h}`)
    .replace(/^hw\.lcd\.density=.*$/m, `hw.lcd.density=${d}`);
  fs.writeFileSync(avdFile, ini, 'utf8');
  // 运行中直接改分辨率
  const live = {};
  if (await adbmod.isOnline().catch(() => false)) {
    live.size = await adbmod.shell(`wm size ${w}x${h}`).catch(() => '');
    live.density = await adbmod.shell(`wm density ${d}`).catch(() => '');
    // 修改机型标识（供部分应用读取）
    await adbmod.rootShell(
      `setprop ro.product.model '${dev.model}'; setprop ro.product.brand '${dev.brand}'; true`
    ).catch(() => {});
  }
  return { ok: true, device: dev, resolution: { width: w, height: h, density: d }, live, needRestart: true };
}

async function getDeviceInfo() {
  if (!(await adbmod.isOnline().catch(() => false))) {
    const avdFile = path.join(conf.avdHome, conf.avdName + '.avd', 'config.ini');
    const ini = fs.readFileSync(avdFile, 'utf8');
    return { offline: true, raw: ini.match(/hw\.device\.name=.*/)?.[0] || '' };
  }
  const out = await adbmod.shell(
    'getprop ro.product.model; getprop ro.product.brand; getprop ro.product.manufacturer; ' +
    'getprop ro.product.device; getprop ro.build.version.release; getprop ro.build.version.sdk; ' +
    'wm size | tail -1; wm density | tail -1'
  ).catch(() => '');
  const [model, brand, manufacturer, device, release, sdk, size, density] = out.split('\n');
  return { model, brand, manufacturer, device, release, sdk, size, density };
}

// ---------- 扬声器 ----------
async function setSpeaker({ enabled, level }) {
  const results = {};
  if (level !== undefined) results.volume = await adbmod.shell(`media volume --stream 3 --set ${level}`);
  if (enabled !== undefined) {
    results.mute = await adbmod.shell(`media volume --stream 3 --set ${enabled ? 8 : 0}`);
  }
  return results;
}

module.exports = {
  setRoot, getRootStatus, getDisk, getSdcard, setDisplay, getDisplay, resetDisplay, screenshot,
  setVolume, getAudio, setMute, setCamera, getCamera, setDevice, getDeviceInfo, setSpeaker,
};
