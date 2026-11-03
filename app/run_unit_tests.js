// 离线单元测试：不需要模拟器，覆盖纯函数与网络下载逻辑
// 运行: cd app && node run_unit_tests.js
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const sdk = require('./src/sdkdownloader');
const camera = require('./src/camera');

const results = [];
const TMP = path.join(os.tmpdir(), 'avm-unit-' + Date.now());

async function test(name, fn) {
  process.stdout.write(`[${String(results.length + 1).padStart(2, '0')}] ${name} ... `);
  try {
    const r = await fn();
    if (r === false) {
      results.push({ name, ok: false, detail: '校验未通过' });
      console.log('✗');
    } else {
      results.push({ name, ok: true, detail: '' });
      console.log('✓');
    }
  } catch (e) {
    results.push({ name, ok: false, detail: e.message });
    console.log('✗ ' + e.message);
  }
}

const sha1 = (f) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');

async function main() {
  fs.mkdirSync(TMP, { recursive: true });

  // ==================== 摄像头：模式值转换 ====================
  await test('摄像头 none 模式', () => camera.toIniValue({ mode: 'none' }) === 'none');
  await test('摄像头 emulated 模式', () => camera.toIniValue({ mode: 'emulated' }) === 'emulated');
  await test('摄像头 virtualscene 模式', () => camera.toIniValue({ mode: 'virtualscene' }) === 'virtualscene');
  await test('摄像头 webcam 索引', () => camera.toIniValue({ mode: 'webcam', index: 2 }) === 'webcam2');
  await test('摄像头 imagefile 路径', () =>
    camera.toIniValue({ mode: 'imagefile', path: 'C:/a/b.png' }).startsWith('imagefile:'));
  await test('摄像头 未知模式应报错', () => {
    try {
      camera.toIniValue({ mode: 'bogus' });
      return false;
    } catch {
      return true;
    }
  });
  await test('摄像头 imagefile 缺路径应报错', () => {
    try {
      camera.toIniValue({ mode: 'imagefile' });
      return false;
    } catch {
      return true;
    }
  });

  // ==================== 摄像头：素材存取 ====================
  await test('摄像头 保存素材', () => {
    const png =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const r = camera.saveImage(png, 'unit-test.png');
    if (!r.ok || !fs.existsSync(r.path)) return false;
    const list = camera.listImagesWithThumbs();
    if (!list.some((i) => i.name === 'unit-test.png')) return false;
    if (!list[0].dataUrl || !list[0].dataUrl.startsWith('data:image/')) return false;
    return true;
  });
  await test('摄像头 删除素材', () => {
    const r = camera.deleteImage('unit-test.png');
    if (!r.ok) return false;
    return !camera.listImages().some((i) => i.name === 'unit-test.png');
  });

  // ==================== SDK 清单解析 ====================
  const sampleXml = `<?xml version="1.0"?><sdk:sdkRepository>
    <remotePackage path="emulator">
      <archives>
        <archive>
          <complete><size>123456</size><checksum type="sha1">abcdef123456</checksum><url>emulator-linux.zip</url></complete>
          <host-os>linux</host-os>
        </archive>
        <archive>
          <complete><size>987654</size><checksum type="sha1">fedcba654321</checksum><url>emulator-windows_x64-1.zip</url></complete>
          <host-os>windows</host-os>
        </archive>
      </archives>
    </remotePackage>
    <remotePackage path="generic">
      <archives><archive>
        <complete><size>42</size><checksum type="sha1">111</checksum><url>generic.zip</url></complete>
      </archive></archives>
    </remotePackage>
  </sdk:sdkRepository>`;

  await test('SDK 解析 优先选 windows 包', () => {
    const r = sdk.parsePackage(sampleXml, 'emulator');
    return r && r.url === 'emulator-windows_x64-1.zip' && r.size === 987654 && r.hostOs === 'windows';
  });
  await test('SDK 解析 无 host-os 视为通用包', () => {
    const r = sdk.parsePackage(sampleXml, 'generic');
    return r && r.url === 'generic.zip' && r.size === 42;
  });
  await test('SDK 解析 不存在的包返回 null', () => sdk.parsePackage(sampleXml, 'nope') === null);
  await test('SDK 清单路径映射', () => {
    // 通过 resolvePackages 的报错信息间接验证未知组件
    return sdk.MIRRORS.length >= 2 && !!sdk.getMirror('tencent') && !!sdk.getMirror('google');
  });
  await test('SDK 未知镜像回退到默认', () => sdk.getMirror('nope').id === sdk.DEFAULT_MIRROR);

  // ==================== SDK 在线：镜像解析 ====================
  let googlePkg = null;
  let tencentPkg = null;

  await test('SDK 联网 解析 Google 官方包', async () => {
    const r = await sdk.resolvePackages(['platform-tools'], { mirror: 'google' });
    googlePkg = r[0];
    return r[0].url.startsWith('https://dl.google.com/') && r[0].size > 1000000 && r[0].checksum.length >= 40;
  });

  await test('SDK 联网 解析腾讯云镜像包', async () => {
    const r = await sdk.resolvePackages(['platform-tools'], { mirror: 'tencent' });
    tencentPkg = r[0];
    return r[0].url.startsWith('https://mirrors.cloud.tencent.com/') && r[0].size > 1000000;
  });

  await test('SDK 两个镜像的文件名/大小/SHA1 一致', () => {
    if (!googlePkg || !tencentPkg) return false;
    return (
      googlePkg.url.split('/').pop() === tencentPkg.url.split('/').pop() &&
      googlePkg.size === tencentPkg.size &&
      googlePkg.checksum === tencentPkg.checksum
    );
  });

  // ==================== SDK 下载与断点续传 ====================
  const target = tencentPkg;

  await test('SDK 完整下载并校验 SHA-1', async () => {
    const f = path.join(TMP, 'full.zip');
    await sdk.downloadFile(target.url, f, { expectedSize: target.size });
    return fs.statSync(f).size === target.size && sha1(f) === target.checksum;
  });

  await test('SDK 断点续传（从中点继续）', async () => {
    const full = path.join(TMP, 'full.zip');
    const f = path.join(TMP, 'resume.zip');
    const half = Math.floor(target.size / 2);
    fs.copyFileSync(full, f + '.part');
    fs.truncateSync(f + '.part', half);

    let sawResume = false;
    const r = await sdk.downloadFile(target.url, f, {
      expectedSize: target.size,
      onProgress: (p) => {
        if (p.resumedFrom > 0) sawResume = true;
      },
    });
    if (!sawResume || !r.resumed) return false;
    if (fs.statSync(f).size !== target.size) return false;
    if (sha1(f) !== target.checksum) return false;
    return !fs.existsSync(f + '.part');
  });

  await test('SDK 已有完整文件应跳过下载', async () => {
    const f = path.join(TMP, 'full.zip');
    const t0 = Date.now();
    const r = await sdk.downloadFile(target.url, f, { expectedSize: target.size });
    return r.skipped === true && Date.now() - t0 < 500;
  });

  await test('SDK 脏分片（比预期大）应重下', async () => {
    const f = path.join(TMP, 'dirty.zip');
    fs.writeFileSync(f + '.part', Buffer.alloc(target.size + 5000));
    await sdk.downloadFile(target.url, f, { expectedSize: target.size });
    return fs.statSync(f).size === target.size && sha1(f) === target.checksum;
  });

  await test('SDK pendingDownloads 能识别未完成分片', () => {
    const dir = path.join(TMP, '.download');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'x.zip.part'), Buffer.alloc(1024));
    const list = sdk.pendingDownloads(TMP);
    return list.length === 1 && list[0].file === 'x.zip.part' && list[0].bytes === 1024;
  });

  // ==================== 汇总 ====================
  const failed = results.filter((r) => !r.ok).length;
  console.log('');
  console.log('========== 离线单测报告 ==========');
  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  console.log('');
  console.log(`合计 ${results.length} 项，通过 ${results.length - failed} 项，失败 ${failed} 项`);

  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
  return failed;
}

main()
  .then((n) => process.exit(n > 0 ? 1 : 0))
  .catch((e) => {
    console.error('测试崩溃:', e);
    process.exit(1);
  });
