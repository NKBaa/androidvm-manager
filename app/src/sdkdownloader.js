// Android SDK 在线下载器
//
// 直接从官方仓库或其镜像（dl.google.com / 腾讯云）拉取组件 zip 并解压，
// 不需要 Java / sdkmanager。实测总下载量约 1.9 GB（解压后约 5.4 GB）。
//
// 两个关键能力：
//   1. 镜像源切换 —— 国内访问 dl.google.com 慢时可切到腾讯云镜像，
//      两边清单里的文件名 / 大小 / SHA-1 完全一致（已验证）。
//   2. 断点续传 —— 下载中的文件先写成 <name>.part，中断后下次带 Range 头续传；
//      服务端不支持 Range（返回 200）时自动从头重下。
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

/** 可用镜像源。base 末尾必须带 / */
const MIRRORS = [
  {
    id: 'google',
    name: 'Google 官方（dl.google.com）',
    base: 'https://dl.google.com/android/repository/',
  },
  {
    id: 'tencent',
    name: '腾讯云镜像（国内加速）',
    base: 'https://mirrors.cloud.tencent.com/AndroidSDK/',
  },
];

const DEFAULT_MIRROR = 'google';

function getMirror(id) {
  return MIRRORS.find((m) => m.id === id) || MIRRORS.find((m) => m.id === DEFAULT_MIRROR);
}

/** 各清单相对于镜像 base 的路径 */
const MANIFEST_PATHS = {
  tools: 'repository2-3.xml',
  'system-images;android-34;google_apis': 'sys-img/google_apis/sys-img2-3.xml',
  'system-images;android-34;google_apis_playstore': 'sys-img/google_apis_playstore/sys-img2-3.xml',
  'system-images;android-34;google_atd': 'sys-img/google_atd/sys-img2-3.xml',
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
function request(url, { headers = {}, redirect = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'AndroidVM-Manager', ...headers } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirect > 0) {
        res.resume();
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).toString();
        return request(next, { headers, redirect: redirect - 1 }).then(resolve, reject);
      }
      resolve(res);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('连接超时')));
  });
}

async function fetchText(url) {
  const res = await request(url);
  if (res.statusCode !== 200) {
    res.resume();
    throw new Error(`HTTP ${res.statusCode}: ${url}`);
  }
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

function manifestPathFor(pkgPath) {
  if (MANIFEST_PATHS[pkgPath]) return MANIFEST_PATHS[pkgPath];
  if (pkgPath.startsWith('system-images;')) {
    const parts = pkgPath.split(';');
    return MANIFEST_PATHS[`system-images;${parts[1]};${parts[2]}`] || null;
  }
  return MANIFEST_PATHS.tools;
}

/** 解析一组包的下载信息（含完整 URL 与大小） */
async function resolvePackages(pkgs, opts = {}) {
  const { mirror, onProgress } = opts;
  const m = getMirror(mirror);
  const cache = new Map();
  const out = [];
  for (const p of pkgs) {
    const rel = manifestPathFor(p);
    if (!rel) throw new Error('未知组件: ' + p);
    const mUrl = m.base + rel;
    if (!cache.has(mUrl)) {
      if (onProgress) onProgress({ phase: 'manifest', message: '读取清单 ' + rel.split('/').pop() });
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
function statSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * 下载文件，支持断点续传。
 *   - 已存在 <file>.part 时带 Range 头续传
 *   - 服务端返回 200（不支持 Range）时自动从头重下
 *   - 下完把 .part 改名为最终文件
 * 返回 { file, size, resumed, resumedFrom }
 */
function downloadFile(url, file, { onProgress, expectedSize } = {}) {
  const partFile = file + '.part';

  // 已有完整文件（大小匹配）直接复用
  if (expectedSize > 0 && statSize(file) === expectedSize) {
    return Promise.resolve({ file, size: expectedSize, resumed: true, resumedFrom: expectedSize, skipped: true });
  }

  let startAt = statSize(partFile);
  // 已经下完但没来得及改名
  if (expectedSize > 0 && startAt === expectedSize) {
    fs.rmSync(file, { force: true });
    fs.renameSync(partFile, file);
    return Promise.resolve({ file, size: expectedSize, resumed: true, resumedFrom: expectedSize, skipped: true });
  }
  // .part 比预期还大，说明是脏数据，重来
  if (expectedSize > 0 && startAt > expectedSize) {
    fs.rmSync(partFile, { force: true });
    startAt = 0;
  }

  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });

    const headers = startAt > 0 ? { Range: `bytes=${startAt}-` } : {};

    request(url, { headers })
      .then((res) => {
        // 206 = 服务端接受了 Range；200 = 忽略了 Range，只能从头来
        let append = false;
        if (res.statusCode === 206) {
          append = startAt > 0;
        } else if (res.statusCode === 200) {
          append = false;
          startAt = 0;
        } else {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}: ${url}`));
        }

        const contentLen = Number(res.headers['content-length'] || 0);
        const total = contentLen ? contentLen + startAt : expectedSize || 0;

        const out = fs.createWriteStream(partFile, append ? { flags: 'a' } : { flags: 'w' });
        let received = startAt;
        let lastTick = 0;

        res.on('data', (chunk) => {
          received += chunk.length;
          const now = Date.now();
          if (onProgress && now - lastTick > 200) {
            lastTick = now;
            onProgress({
              received,
              total,
              percent: total ? (received / total) * 100 : 0,
              resumedFrom: startAt,
            });
          }
        });

        res.pipe(out);

        out.on('finish', () => {
          out.close(() => {
            // 完整性检查：已知总长时必须对得上
            const got = statSize(partFile);
            if (total > 0 && got !== total) {
              return reject(new Error(`下载不完整：期望 ${total} 字节，实际 ${got} 字节`));
            }
            fs.rmSync(file, { force: true });
            fs.renameSync(partFile, file);
            resolve({ file, size: got, resumed: startAt > 0, resumedFrom: startAt });
          });
        });

        out.on('error', reject);
        res.on('error', reject);
        res.on('aborted', () => reject(new Error('连接中断')));
      })
      .catch(reject);
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
 * @param {string} opts.mirror     镜像源 id（google / tencent）
 * @param {function} opts.onProgress 进度回调
 * @param {function} opts.isCancelled 返回 true 则中止
 */
async function install({ sdkRoot, packages, mirror, onProgress, isCancelled } = {}) {
  const pkgs = packages && packages.length ? packages : PRESETS.minimal;
  const m = getMirror(mirror);
  const emit = (o) => { if (onProgress) onProgress(o); };
  const check = () => { if (isCancelled && isCancelled()) throw new Error('已取消'); };

  emit({ phase: 'resolve', message: `解析组件清单（${m.name}）…`, mirror: m.id });
  const resolved = await resolvePackages(pkgs, { mirror: m.id, onProgress: emit });
  const totalBytes = resolved.reduce((s, r) => s + (r.size || 0), 0);
  emit({
    phase: 'resolved',
    mirror: m.id,
    mirrorName: m.name,
    packages: resolved.map((r) => ({ path: r.path, size: r.size })),
    totalBytes,
  });

  const tmpDir = path.join(sdkRoot, '.download');
  fs.mkdirSync(tmpDir, { recursive: true });

  let doneBytes = 0;
  for (const r of resolved) {
    check();
    const zipName = r.url.split('/').pop();
    const zipPath = path.join(tmpDir, zipName);

    // 已存在未下完的 .part → 告诉界面可以续传
    const partSize = statSize(zipPath + '.part');
    emit({
      phase: 'download-start',
      package: r.path,
      file: zipName,
      size: r.size,
      resumable: partSize > 0,
      resumedFrom: partSize,
      overallPercent: totalBytes ? (doneBytes / totalBytes) * 100 : 0,
    });

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
          resumedFrom: p.resumedFrom,
          overallPercent: totalBytes ? ((doneBytes + p.received) / totalBytes) * 100 : 0,
        });
      },
    });

    check();
    if (r.checksum) {
      emit({ phase: 'verify', package: r.path, message: '校验 SHA-1…' });
      const sum = await sha1File(zipPath);
      if (sum.toLowerCase() !== String(r.checksum).toLowerCase()) {
        // 校验失败多半是续传拼接坏了，删掉下次重下
        fs.rmSync(zipPath, { force: true });
        throw new Error(`校验失败: ${r.path}（期望 ${r.checksum}，实际 ${sum}）`);
      }
    }

    check();
    const t = extractTarget(r.path);
    const dest = path.join(sdkRoot, t.to);
    emit({ phase: 'extract', package: r.path, dest });
    await extractZip(zipPath, dest);

    if (t.dir && !fs.existsSync(path.join(dest, t.dir))) {
      throw new Error(`解压后缺少目录 ${t.dir}（${r.path}）`);
    }

    doneBytes += r.size || 0;
    fs.rmSync(zipPath, { force: true });
    emit({ phase: 'package-done', package: r.path, overallPercent: totalBytes ? (doneBytes / totalBytes) * 100 : 100 });
  }

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  const ok = {
    emulator: fs.existsSync(path.join(sdkRoot, 'emulator', 'emulator.exe')),
    adb: fs.existsSync(path.join(sdkRoot, 'platform-tools', 'adb.exe')),
  };
  emit({ phase: 'done', sdkRoot, mirror: m.id, ok });
  return { ok: true, sdkRoot, mirror: m.id, ...ok };
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

/** 列出 .download 里未下完的分片，供界面显示「可续传」 */
function pendingDownloads(sdkRoot) {
  const dir = path.join(sdkRoot, '.download');
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.part'))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return { file: f, bytes: st.size, mtime: st.mtimeMs };
      });
  } catch {
    return [];
  }
}

module.exports = {
  MIRRORS,
  DEFAULT_MIRROR,
  PRESETS,
  getMirror,
  resolvePackages,
  downloadFile,
  extractZip,
  install,
  checkSdk,
  pendingDownloads,
  parsePackage,
};
