// Android SDK 在线下载器
//
// 直接从 Google 官方仓库（dl.google.com）拉取组件 zip 并解压，
// 不需要 Java / sdkmanager。实测总下载量约 1.9 GB（解压后约 5.4 GB）。
//
// 清单文件（XML）里列出了每个包的当前版本、下载地址、大小与 SHA-1，
// 解析后即可拿到最新版本，不用硬编码版本号。
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const BASE = 'https://dl.google.com/android/repository/';

// 各包所在清单
const MANIFESTS = {
  tools: BASE + 'repository2-3.xml',
  'system-images;android-34;google_apis': BASE + 'sys-img/google_apis/sys-img2-3.xml',
  'system-images;android-34;google_apis_playstore': BASE + 'sys-img/google_apis_playstore/sys-img2-3.xml',
  'system-images;android-34;google_atd': BASE + 'sys-img/google_atd/sys-img2-3.xml',
};

/** 推荐安装的组件集合 */
const PRESETS = {
  minimal: ['emulator', 'platform-tools', 'system-images;android-34;google_apis;x86_64'],
  playstore: ['emulator', 'platform-tools', 'system-images;android-34;google_apis_playstore;x86_64'],
};

/** 每个包装完之后解压到哪（相对 SDK 根目录） */
function extractTarget(pkgPath) {
  if (pkgPath === 'emulator') return { to: '', dir: 'emulator' };
  if (pkgPath === 'platform-tools') return { to: '', dir: 'platform-tools' };
  const m = pkgPath.match(/^system-images;([^;]+);([^;]+);([^;]+)$/);
  if (m) {
    // zip 里是 <abi>/ 目录，解到 .../<api>/<tag>/ 下
    return { to: path.join('system-images', m[1], m[2]), dir: m[3] };
  }
  return { to: '', dir: path.basename(pkgPath) };
}

// ---------------- HTTP ----------------
function get(url, { redirect = 5 } = {}) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'AndroidVM-Manager' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirect > 0) {
          res.resume();
          return get(res.headers.location, { redirect: redirect - 1 }).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}: ${url}`));
        }
        resolve(res);
      })
      .on('error', reject);
  });
}

async function fetchText(url) {
  const res = await get(url);
  const chunks = [];
  for await (const c of res) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

// ---------------- 清单解析 ----------------
/**
 * 从清单 XML 里解析出指定包的下载信息。
 * 结构：<remotePackage path="..."><archives><archive>
 *         <complete><size/><checksum/><url/></complete><host-os>windows</host-os>
 *       </archive></archives></remotePackage>
 */
function parsePackage(xml, pkgPath) {
  const esc = pkgPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<remotePackage path="${esc}">([\\s\\S]*?)</remotePackage>`);
  const m = xml.match(re);
  if (!m) return null;
  const body = m[1];

  const archRe = /<archive>([\s\S]*?)<\/archive>/g;
  let a;
  let fallback = null;
  while ((a = archRe.exec(body))) {
    const b = a[1];
    const url = (b.match(/<url>([^<]+)<\/url>/) || [])[1];
    if (!url) continue;
    const size = Number((b.match(/<size>(\d+)<\/size>/) || [])[1] || 0);
    const checksum = (b.match(/<checksum[^>]*>([^<]+)<\/checksum>/) || [])[1] || '';
    const hostOs = (b.match(/<host-os>([^<]+)<\/host-os>/) || [])[1] || '';
    const info = { url, size, checksum, hostOs };
    // 优先取 windows 包；没有 host-os 的视为通用包
    if (hostOs === 'windows') return info;
    if (!hostOs) fallback = info;
  }
  return fallback;
}

function manifestUrlFor(pkgPath) {
  if (MANIFESTS[pkgPath]) return MANIFESTS[pkgPath];
  if (pkgPath.startsWith('system-images;')) {
    const parts = pkgPath.split(';');
    const key = `system-images;${parts[1]};${parts[2]}`;
    return MANIFESTS[key] || null;
  }
  return MANIFESTS.tools;
}

/** 解析一组包的下载信息（含完整 URL 与大小） */
async function resolvePackages(pkgs, onProgress) {
  const cache = new Map();
  const out = [];
  for (const p of pkgs) {
    const mUrl = manifestUrlFor(p);
    if (!mUrl) throw new Error('未知组件: ' + p);
    if (!cache.has(mUrl)) {
      if (onProgress) onProgress({ phase: 'manifest', message: '读取清单 ' + mUrl.split('/').pop() });
      cache.set(mUrl, await fetchText(mUrl));
    }
    const info = parsePackage(cache.get(mUrl), p);
    if (!info) throw new Error('清单里找不到组件: ' + p);
    const fullUrl = /^https?:/.test(info.url) ? info.url : mUrl.replace(/[^/]+$/, '') + info.url;
    out.push({ path: p, url: fullUrl, size: info.size, checksum: info.checksum });
  }
  return out;
}

// ---------------- 下载 / 校验 / 解压 ----------------
function downloadFile(url, file, { onProgress, expectedSize } = {}) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const out = fs.createWriteStream(file);
    let received = 0;
    let lastTick = 0;

    get(url)
      .then((res) => {
        const total = Number(res.headers['content-length'] || expectedSize || 0);
        res.on('data', (chunk) => {
          received += chunk.length;
          const now = Date.now();
          if (onProgress && now - lastTick > 200) {
            lastTick = now;
            onProgress({ received, total, percent: total ? (received / total) * 100 : 0 });
          }
        });
        res.pipe(out);
        out.on('finish', () => {
          out.close(() => resolve({ file, size: received }));
        });
        res.on('error', reject);
      })
      .catch((e) => {
        try { out.close(); } catch {}
        try { fs.rmSync(file, { force: true }); } catch {}
        reject(e);
      });
  });
}

function sha1File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    const s = fs.createReadStream(file);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

/** 用系统自带的 bsdtar 解压（Windows 10 1803+ 自带，支持 zip） */
function extractZip(zip, destDir) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(destDir, { recursive: true });
    execFile('tar', ['-xf', zip, '-C', destDir], { windowsHide: true, timeout: 30 * 60 * 1000 }, (err, so, se) => {
      if (err) return reject(new Error('解压失败: ' + (se || err.message)));
      resolve(true);
    });
  });
}

/**
 * 安装 SDK。
 * @param {object} opts
 * @param {string} opts.sdkRoot    目标 SDK 根目录
 * @param {string[]} opts.packages 组件列表（默认 PRESETS.minimal）
 * @param {function} opts.onProgress 进度回调
 * @param {function} opts.isCancelled 返回 true 则中止
 */
async function install({ sdkRoot, packages, onProgress, isCancelled } = {}) {
  const pkgs = packages && packages.length ? packages : PRESETS.minimal;
  const emit = (o) => { if (onProgress) onProgress(o); };
  const check = () => { if (isCancelled && isCancelled()) throw new Error('已取消'); };

  emit({ phase: 'resolve', message: '解析组件清单…' });
  const resolved = await resolvePackages(pkgs, emit);
  const totalBytes = resolved.reduce((s, r) => s + (r.size || 0), 0);
  emit({ phase: 'resolved', packages: resolved.map((r) => ({ path: r.path, size: r.size })), totalBytes });

  const tmpDir = path.join(sdkRoot, '.download');
  fs.mkdirSync(tmpDir, { recursive: true });

  let doneBytes = 0;
  for (const r of resolved) {
    check();
    const zipName = r.url.split('/').pop();
    const zipPath = path.join(tmpDir, zipName);
    emit({ phase: 'download-start', package: r.path, file: zipName, size: r.size, overallPercent: totalBytes ? (doneBytes / totalBytes) * 100 : 0 });

    if (!(fs.existsSync(zipPath) && fs.statSync(zipPath).size === r.size)) {
      await downloadFile(r.url, zipPath, {
        expectedSize: r.size,
        onProgress: (p) => {
          emit({
            phase: 'download',
            package: r.path,
            file: zipName,
            received: p.received,
            total: p.total,
            percent: p.percent,
            overallPercent: totalBytes ? ((doneBytes + p.received) / totalBytes) * 100 : 0,
          });
        },
      });
    }

    check();
    if (r.checksum) {
      emit({ phase: 'verify', package: r.path, message: '校验 SHA-1…' });
      const sum = await sha1File(zipPath);
      if (sum.toLowerCase() !== String(r.checksum).toLowerCase()) {
        fs.rmSync(zipPath, { force: true });
        throw new Error(`校验失败: ${r.path}（期望 ${r.checksum}，实际 ${sum}）`);
      }
    }

    check();
    const t = extractTarget(r.path);
    const dest = path.join(sdkRoot, t.to);
    emit({ phase: 'extract', package: r.path, dest });
    await extractZip(zipPath, dest);

    // 确认解压出了预期目录
    if (t.dir && !fs.existsSync(path.join(dest, t.dir))) {
      throw new Error(`解压后缺少目录 ${t.dir}（${r.path}）`);
    }

    doneBytes += r.size || 0;
    fs.rmSync(zipPath, { force: true });
    emit({ phase: 'package-done', package: r.path, overallPercent: totalBytes ? (doneBytes / totalBytes) * 100 : 100 });
  }

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  // 基本自检
  const ok = {
    emulator: fs.existsSync(path.join(sdkRoot, 'emulator', 'emulator.exe')),
    adb: fs.existsSync(path.join(sdkRoot, 'platform-tools', 'adb.exe')),
  };
  emit({ phase: 'done', sdkRoot, ok });
  return { ok: true, sdkRoot, ...ok };
}

/** 检查 SDK 是否已具备运行条件 */
function checkSdk(sdkRoot) {
  const has = (p) => { try { return fs.existsSync(path.join(sdkRoot, p)); } catch { return false; } };
  return {
    sdkRoot,
    emulator: has('emulator/emulator.exe'),
    adb: has('platform-tools/adb.exe'),
    images: fs.existsSync(path.join(sdkRoot, 'system-images'))
      ? fs.readdirSync(path.join(sdkRoot, 'system-images')).filter((d) => /^android-/.test(d))
      : [],
    ready: has('emulator/emulator.exe') && has('platform-tools/adb.exe'),
  };
}

module.exports = { PRESETS, resolvePackages, downloadFile, extractZip, install, checkSdk, parsePackage };
