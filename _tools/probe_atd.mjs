import https from 'node:https';
const bases = [
  'https://dl.google.com/android/repository/sys-img/android/sys-img2-3.xml',
  'https://dl.google.com/android/repository/sys-img/google_apis/sys-img2-3.xml',
];
const get = (u) => new Promise((res, rej) => https.get(u, r => { let d = ''; r.setEncoding('utf8'); r.on('data', c => d += c); r.on('end', () => res(d)); }).on('error', rej));
for (const b of bases) {
  try {
    const d = await new Promise((res, rej) => {
      https.get(b, (r) => { let s = ''; r.setEncoding('utf8'); r.on('data', c => s += c); r.on('end', () => res(s)); }).on('error', rej);
    });
    const blocks = d.split('<remotePackage ').slice(1);
    console.log('===', b, 'packages', blocks.length);
    for (const bl of blocks) {
      const p = (bl.match(/path="([^"]*)"/) || [])[1] || '';
      const u = (bl.match(/<url>([^<]*)<\/url>/) || [])[1] || '';
      const sz = +((bl.match(/<size>(\d+)<\/size>/) || [])[1] || 0);
      if (/android-34/.test(p)) console.log('  ', p, '=>', u, (sz / 1048576).toFixed(0) + 'MB');
    }
  } catch (e) { console.log(b, 'ERR', e.message); }
}
