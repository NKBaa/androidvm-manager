// 摄像头管理
//
// 模拟器支持的摄像头模式（`emulator -help-all` 确认）：
//   none          关闭
//   emulated      软件合成画面（彩条/动态图案）
//   virtualscene  3D 虚拟场景，可用鼠标在模拟器窗口里转视角
//   webcam<N>     宿主机真实摄像头
//   imagefile:<f> 渲染指定图片文件
//
// 实测结论（Android Emulator 37.3.5.0 / google_apis android-34）：
//   - emulated  ✅ 正常，出彩条图案
//   - webcamN   ✅ 标准能力（本会话无摄像头访问权限，未做画面验证）
//   - virtualscene / imagefile  ⚠️ 在 -no-window 后台模式下会**静默回退成 emulated**。
//     imagefile 用绝对路径、相对 AVD 路径、命令行参数三种方式都试过，均无效且无报错。
//     因此界面里把「图片 / 屏幕区域」标为实验性。
//
// 注意：模式写在 AVD 的 config.ini 里，**必须重启模拟器才生效**。
const fs = require('node:fs');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { conf } = require('./config');

const IMAGE_DIR = () => path.join(conf.vmRoot, '_data', 'camera');

/** 当前活动实例的 AVD 名（多开时每个实例有独立 config.ini） */
function currentAvdName() {
  try {
    const inst = require('./instances').active();
    if (inst && inst.avdName) return inst.avdName;
  } catch {}
  return conf.avdName;
}

function avdConfigFile() {
  return path.join(conf.avdHome, currentAvdName() + '.avd', 'config.ini');
}

// ---------------- 宿主机摄像头枚举 ----------------
/**
 * 优先用 `emulator -webcam-list` 拿官方索引（webcamN 的 N 就是这里的顺序），
 * 拿不到就退回 WMI 枚举（名称可能与 N 不完全对应，仅作兜底）。
 */
async function listHostCameras() {
  // 1) 官方方式
  const viaEmulator = await new Promise((resolve) => {
    execFile(conf.emulator, ['-webcam-list'], { timeout: 15000, windowsHide: true }, (err, so, se) => {
      const text = String(so || '') + String(se || '');
      const cams = [];
      // 常见格式： "webcam0: Integrated Camera" 或 "Name: xxx\n  webcam0"
      const re1 = /webcam(\d+)\s*[:=]\s*(.+)/gi;
      let m;
      while ((m = re1.exec(text))) cams.push({ index: Number(m[1]), name: m[2].trim(), mode: 'webcam' + m[1] });
      if (!cams.length) {
        const re2 = /(?:Name|name)\s*[:=]\s*(.+)\r?\n\s*webcam(\d+)/g;
        while ((m = re2.exec(text))) cams.push({ index: Number(m[2]), name: m[1].trim(), mode: 'webcam' + m[2] });
      }
      resolve(cams);
    });
  });
  if (viaEmulator.length) return viaEmulator;

  // 2) WMI 兜底
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "Get-CimInstance Win32_PnPEntity | Where-Object { $_.PNPClass -eq 'Camera' -or $_.PNPClass -eq 'Image' } | Select-Object -ExpandProperty Name",
      ],
      { timeout: 20000, windowsHide: true, encoding: 'utf8' }
    );
    return String(out)
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((name, i) => ({ index: i, name, mode: 'webcam' + i, approximate: true }));
  } catch {
    return [];
  }
}

// ---------------- 当前配置 ----------------
function getStatus() {
  const file = avdConfigFile();
  let ini = '';
  try {
    ini = fs.readFileSync(file, 'utf8');
  } catch {
    return { back: 'emulated', front: 'emulated', images: listImages(), error: '读不到 config.ini' };
  }
  const pick = (k) => {
    const m = ini.match(new RegExp('^' + k + '=(.*)$', 'm'));
    return m ? m[1].trim() : '';
  };
  return {
    back: pick('hw\\.camera\\.back') || 'emulated',
    front: pick('hw\\.camera\\.front') || 'emulated',
    backOrientation: pick('hw\\.camera\\.back\\.orientation') || '90',
    frontOrientation: pick('hw\\.camera\\.front\\.orientation') || '90',
    images: listImages(),
    avdName: currentAvdName(),
    avdConfig: file,
  };
}

/** 把「模式 + 参数」拼成 config.ini 里的值 */
function toIniValue(spec) {
  if (!spec) return null;
  if (typeof spec === 'string') return spec;
  switch (spec.mode) {
    case 'none':
    case 'emulated':
    case 'virtualscene':
      return spec.mode;
    case 'webcam':
      return 'webcam' + (Number.isFinite(spec.index) ? spec.index : 0);
    case 'imagefile': {
      if (!spec.path) throw new Error('imagefile 模式需要图片路径');
      // 路径不能带换行；反斜杠在 ini 里无需转义
      return 'imagefile:' + path.resolve(spec.path);
    }
    default:
      throw new Error('未知摄像头模式: ' + spec.mode);
  }
}

/**
 * 设置摄像头来源。只写 config.ini，需重启模拟器生效。
 * @param {{back?:object|string, front?:object|string}} src
 */
function setSource({ back, front } = {}) {
  const file = avdConfigFile();
  let ini = fs.readFileSync(file, 'utf8');

  const apply = (key, spec) => {
    const val = toIniValue(spec);
    if (val == null) return;
    // key 里的点要转义成正则字面量，但替换文本里必须用原始 key
    const re = new RegExp('^' + key.replace(/\./g, '\\.') + '=.*$', 'm');
    if (re.test(ini)) ini = ini.replace(re, `${key}=${val}`);
    else ini += `\n${key}=${val}\n`;
  };

  apply('hw.camera.back', back);
  apply('hw.camera.front', front);
  fs.writeFileSync(file, ini, 'utf8');
  return { ok: true, needRestart: true, ...getStatus() };
}

// ---------------- 图片源管理 ----------------
function listImages() {
  const dir = IMAGE_DIR();
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /\.(png|jpg|jpeg)$/i.test(f))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return { name: f, path: path.join(dir, f), size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

/** 列表附带 dataURL 缩略图，供界面预览 */
function listImagesWithThumbs() {
  return listImages().map((it) => {
    let dataUrl = null;
    try {
      if (it.size <= 8 * 1024 * 1024) {
        const buf = fs.readFileSync(it.path);
        const mime = /\.png$/i.test(it.name) ? 'png' : 'jpeg';
        dataUrl = `data:image/${mime};base64,${buf.toString('base64')}`;
      }
    } catch {}
    return { ...it, dataUrl };
  });
}

function ensureImageDir() {
  fs.mkdirSync(IMAGE_DIR(), { recursive: true });
  return IMAGE_DIR();
}

/** 把 base64/dataURL 图片存进相机图片目录 */
function saveImage(dataUrl, name) {
  const dir = ensureImageDir();
  const b64 = String(dataUrl).replace(/^data:image\/\w+;base64,/, '');
  const safe = (name || 'camera-' + Date.now()).replace(/[^\w.-]/g, '_');
  const file = path.join(dir, safe.endsWith('.png') ? safe : safe + '.png');
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  return { ok: true, path: file, name: path.basename(file), size: fs.statSync(file).size };
}

function deleteImage(name) {
  const file = path.join(IMAGE_DIR(), path.basename(name));
  try {
    fs.rmSync(file, { force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---------------- 屏幕区域抓取 ----------------
/**
 * 抓取整块屏幕，返回 dataURL 与尺寸。
 * 由渲染进程显示出来让用户框选区域。
 */
async function captureScreen() {
  const { desktopCapturer, screen } = require('electron');
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.size;
  const scale = display.scaleFactor || 1;

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) },
  });
  if (!sources.length) throw new Error('没有可用的屏幕源');
  const src = sources[0];
  const size = src.thumbnail.getSize();
  return {
    dataUrl: src.thumbnail.toDataURL(),
    width: size.width,
    height: size.height,
    display: { width, height, scale },
  };
}

/** 从整屏截图里裁剪出选定区域并保存 */
function cropAndSave(dataUrl, rect, name) {
  const { nativeImage } = require('electron');
  const img = nativeImage.createFromDataURL(dataUrl);
  const size = img.getSize();
  const x = Math.max(0, Math.round(rect.x));
  const y = Math.max(0, Math.round(rect.y));
  const w = Math.min(size.width - x, Math.round(rect.w));
  const h = Math.min(size.height - y, Math.round(rect.h));
  if (w <= 0 || h <= 0) throw new Error('选区太小');
  const cropped = img.crop({ x, y, width: w, height: h });
  return saveImage(cropped.toDataURL(), name);
}

// ---------------- 实时跟随屏幕区域 ----------------
//
// 说明：Android 模拟器的摄像头**无法接收实时帧流**。
//   实测 `imagefile:` 与 `virtualscene` 在本机都会静默回退成 `emulated`，
//   控制台的 `virtualscene-image` 命令返回 OK 但画面不变。
//   真正把任意画面喂进摄像头需要 Windows 虚拟摄像头驱动（DirectShow 源滤镜）。
//
// 所以这里做的是「尽可能接近实时」的方案：
//   定时抓取屏幕区域 → 覆盖写入同一个 png → 供 imagefile 模式读取，
//   同时把每一帧推给界面做实时预览。
//   在支持 imagefile 的模拟器/机器上，这就是真的跟随；
//   不支持时至少用户能在界面里看到实时的画面源。

let liveTimer = null;
let liveState = { on: false, rect: null, intervalMs: 2000, file: null };

function liveFilePath() {
  return path.join(ensureImageDir(), 'live-region.png');
}

/**
 * 开始实时跟随。
 * @param {{rect:{x,y,w,h}, intervalMs:number, onFrame:function}} opts
 */
async function startLive({ rect, intervalMs = 2000, onFrame, onBgr } = {}) {
  stopLive();
  const file = liveFilePath();
  const interval = Math.max(500, Math.min(10000, Number(intervalMs) || 2000));
  liveState = { on: true, rect, intervalMs: interval, file };

  const tick = async () => {
    if (!liveState.on) return;
    try {
      const { nativeImage } = require('electron');
      const shot = await captureScreen();
      const img = nativeImage.createFromDataURL(shot.dataUrl);
      const size = img.getSize();
      const r = liveState.rect || { x: 0, y: 0, w: size.width, h: size.height };
      const x = Math.max(0, Math.round(r.x));
      const y = Math.max(0, Math.round(r.y));
      const w = Math.min(size.width - x, Math.round(r.w));
      const h = Math.min(size.height - y, Math.round(r.h));
      if (w <= 0 || h <= 0) throw new Error('选区无效');

      const cropped = img.crop({ x, y, width: w, height: h });
      const png = cropped.toPNG();
      fs.writeFileSync(file, png);

      // 虚拟摄像头模式：额外输出 BGR24 原始帧（Softcam 要的格式）
      if (liveState.on && typeof onBgr === 'function') {
        try {
          const bgra = cropped.toBitmap(); // Windows 下是 BGRA
          const need = w * h * 3;
          const bgr = Buffer.allocUnsafe(need);
          for (let i = 0, j = 0; j < need; i += 4, j += 3) {
            bgr[j] = bgra[i];
            bgr[j + 1] = bgra[i + 1];
            bgr[j + 2] = bgra[i + 2];
          }
          onBgr(bgr);
        } catch {}
      }

      if (liveState.on && typeof onFrame === 'function') {
        onFrame({ dataUrl: cropped.toDataURL(), bytes: png.length, at: Date.now(), file });
      }
    } catch (e) {
      if (liveState.on && typeof onFrame === 'function') onFrame({ error: e.message });
    }
  };

  await tick();
  liveTimer = setInterval(tick, interval);
  return { ok: true, file, intervalMs: interval };
}

function stopLive() {
  if (liveTimer) {
    clearInterval(liveTimer);
    liveTimer = null;
  }
  liveState = { ...liveState, on: false };
  return { ok: true };
}

function liveStatus() {
  return { ...liveState, timer: !!liveTimer };
}

module.exports = {
  listHostCameras,
  getStatus,
  setSource,
  toIniValue,
  listImages,
  listImagesWithThumbs,
  saveImage,
  deleteImage,
  captureScreen,
  cropAndSave,
  ensureImageDir,
  startLive,
  stopLive,
  liveStatus,
  liveFilePath,
};
