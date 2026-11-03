// Minimal sdkmanager replacement: resolves + downloads SDK packages via Node TLS.
// usage: node sdkfetch.mjs <sdkRoot> <outDir> <packagePath> [<packagePath> ...]
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const REPO = 'https://dl.google.com/android/repository/';
const [dlDir, sdkRoot, ...wanted] = process.argv.slice(2);

function get(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 60000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString(), redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} ${url}`)); }
      resolve(res);
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout ' + url)); });
  });
}
async function getText(url) {
  const res = await get(url);
  const chunks = [];
  for await (const c of res) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}
async function download(url, dest, base = '') {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.part';
  let res;
  try { res = await get(url); }
  catch (e) {
    if (!String(e.message).includes('404')) throw e;
    const alt = url.startsWith('http') ? url : REPO + base + path.basename(url);
    console.log('  404, trying sys-img root:', alt);
    res = await get(alt);
  }
  const total = Number(res.headers['content-length'] || 0);
  let got = 0, lastPct = -5;
  const out = fs.createWriteStream(tmp);
  await new Promise((resolve, reject) => {
    res.on('data', (c) => {
      got += c.length;
      if (total) { const pct = Math.floor(got / total * 100); if (pct >= lastPct + 5) { lastPct = pct; process.stdout.write(`  ${pct}% (${(got / 1048576).toFixed(1)}MB)\n`); } }
    });
    res.pipe(out);
    out.on('finish', resolve); out.on('error', reject); res.on('error', reject);
  });
  fs.renameSync(tmp, dest);
  return dest;
}

function parseXml(xml) {
  const pkgs = [];
  for (const m of xml.matchAll(/<remotePackage\b([^>]*)>([\s\S]*?)<\/remotePackage>/g)) {
    const attrs = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map(a => [a[1], a[2]]));
    const body = m[2];
    const rev = body.match(/<revision>([\s\S]*?)<\/revision>/);
    const rv = {};
    if (rev) for (const a of rev[1].matchAll(/<(\w+)>(\d+)<\/\1>/g)) rv[a[1]] = +a[2];
    const archives = [...body.matchAll(/<archive>([\s\S]*?)<\/archive>/g)].map(a => {
      const host = (a[1].match(/<host-os>([^<]*)<\/host-os>/) || [])[1];
      return {
        hostOs: host,
        url: (a[1].match(/<url>([^<]*)<\/url>/) || [])[1],
        size: +((a[1].match(/<size>(\d+)<\/size>/) || [])[1] || 0),
        checksum: (a[1].match(/<checksum[^>]*>([^<]*)<\/checksum>/) || [])[1],
      };
    });
    pkgs.push({ path: attrs.path, obsolete: attrs.obsolete === 'true', rev: rv, archives, body });
  }
  return pkgs;
}

function compareRev(a = {}, b = {}) {
  return (a.major || 0) - (b.major || 0) || (a.minor || 0) - (b.minor || 0) || (a.micro || 0) - (b.micro || 0);
}

function unzip2(zipFile, dest) {
  fs.mkdirSync(dest, { recursive: true });
  // bsdtar (Windows built-in) handles zip archives
  const r = spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zipFile, '-C', dest], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('tar extract failed ' + zipFile);
}
const repoXml = await getText(REPO + 'repository2-3.xml');
const addonXmlFiles = ['addon2-3.xml', 'sys-img/android/sys-img2-3.xml', 'sys-img/google_apis/sys-img2-3.xml', 'sys-img/google_apis_playstore/sys-img2-3.xml', 'sys-img/aosp_atd/sys-img2-3.xml', 'sys-img/google_atd/sys-img2-3.xml'];
const allPkgs = parseXml(repoXml);
for (const f of addonXmlFiles) {
  try { const p = parseXml(await getText(REPO + f)); for (const x of p) x.base = path.posix.dirname('/' + f).slice(1) + (f.includes('/') ? '/' : ''); allPkgs.push(...p); } catch (e) { console.log('skip', f, e.message); }
}
for (const p of allPkgs) if (!p.base) p.base = '';
// system images: resolve from top-level list of sys-img repos is handled above; also scan repo for sys-img dirs
console.log('packages in index:', allPkgs.length);

for (const want of wanted) {
  const hits = allPkgs.filter(p => p.path === want && !p.obsolete);
  if (!hits.length) { console.log('NOT FOUND in index:', want); continue; }
  hits.sort((a, b) => compareRev(b.rev, a.rev));
  const p = hits[0];
  const arc = p.archives.find(a => !a.hostOs || a.hostOs === 'windows') || p.archives[0];
  if (!arc) { console.log('no archive for', want); continue; }
  const zip = path.join(dlDir, path.basename(arc.url));
  console.log(`\n== ${want} rev ${JSON.stringify(p.rev)} -> ${arc.url} (${(arc.size / 1048576).toFixed(1)}MB)`);
  if (!fs.existsSync(zip)) await download(REPO + (p.base || '') + arc.url, zip, p.base);
  if (arc.checksum) {
    const h = crypto.createHash('sha1').update(fs.readFileSync(zip)).digest('hex');
    console.log('  sha1', h === arc.checksum ? 'OK' : `MISMATCH got=${h} want=${arc.checksum}`);
  }
  unzip2(zip, sdkRoot);
  console.log('  extracted ->', sdkRoot);
}








