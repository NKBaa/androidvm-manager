// 预览用 mock：给 renderer.js 提供 window.api，并填充真实感数据
//   ?sdkready=0  模拟「找不到 SDK」的状态（用于截 SDK 下载提示条）
(() => {
  const ok = (data) => Promise.resolve({ ok: true, data });
  const q = new URLSearchParams(location.search);
  const SDK_READY = q.get('sdkready') !== '0';
  const cfg = {
    deviceKey: 'pixel_7', ram: 4096, cores: 4, diskGB: 6,
    root: true, writableSystem: true, snapshot: false,
    audio: { host: true },
    resolution: { width: 1080, height: 2400, density: 420 },
    proxy: { enabled: false, type: 'http', host: '', port: 8080, system: true },
    network: { profile: 'wifi', downloadKbps: 0, uploadKbps: 0, latencyMs: 0, packetLoss: 0, radioType: 'LTE' },
    phone: { number: '+15555210001', operator: '中国移动', iccid: '8944500000000000001', country: 'us' },
    camera: { back: 'virtualscene', front: 'emulated' },
  };
  const status = {
    running: true, online: true, booting: false, booted: true, postBootDone: true,
    id: 'main', name: '主实例', avdName: 'A14_Root',
    pid: 46512, serial: 'emulator-5554', consolePort: 5554, uptime: 3672,
    props: { release: '14', sdk: '34', model: 'SM-S918B', brand: 'samsung', root: true },
  };
  window.api = {
    info: () =>
      ok({
        version: '1.0.0',
        sdkReady: SDK_READY,
        sdkRoot: 'C:\\Users\\me\\AppData\\Local\\Programs\\AndroidVM\\AndroidVM\\android-sdk',
        packaged: true,
        vmRoot: 'C:\\Users\\me\\AppData\\Local\\Programs\\AndroidVM\\AndroidVM',
      }),
    config: { get: () => ok(cfg), save: (c) => ok(c) },
    vm: {
      start: () => ok({}), stop: () => ok({}), restart: () => ok({}),
      status: () => ok(status), log: () => ok('INFO | Boot completed'),
      devices: () => ok([]), openLogDir: () => ok(true),
    },
    instances: {
      list: () => ok({
        activeId: 'main',
        list: [
          { id: 'main', name: '主实例', avdName: 'A14_Root', port: 5554, serial: 'emulator-5554', active: true, online: true, listening: true, summary: { ram: 4096, cores: 4, diskGB: 6, width: 1080, height: 2400, density: 420, root: true } },
          { id: 'work', name: '工作机', avdName: 'A14_Root_2', port: 5556, serial: 'emulator-5556', active: false, online: true, listening: true, summary: { ram: 6144, cores: 6, diskGB: 8, width: 1440, height: 3200, density: 560, root: true } },
          { id: 'test', name: '测试实例', avdName: 'A14_Root_3', port: 5558, serial: 'emulator-5558', active: false, online: false, listening: false, summary: { ram: 2048, cores: 2, diskGB: 4, width: 720, height: 1280, density: 320, root: false } },
        ],
      }),
      create: () => ok({ id: 'x', name: '新实例', avdName: 'A14_Root_4', port: 5560 }),
      remove: () => ok({}), rename: () => ok({}),
      setActive: (id) => ok({ id, name: id === 'work' ? '工作机' : '主实例' }),
      active: () => ok({ id: 'main', name: '主实例' }),
      clean: () => ok({ ok: true, output: '' }),
      backup: () => ok({ ok: true, file: 'x.img', bytes: 4.2 * 1024 * 1024 * 1024 }),
      backups: () => ok([
        { file: 'main-20261103210000.img', path: 'a', bytes: 4.2 * 1024 * 1024 * 1024, mtime: Date.now() },
      ]),
      restore: () => ok({ ok: true }),
      shortcut: () => ok({ ok: true, file: 'C:\\Users\\me\\Desktop\\主实例.lnk' }),
    },
    net: {
      apply: () => ok({ speed: 'OK' }), status: () => ok({ console: 'full speed', networkType: 'LTE' }),
      test: () => ok({ ping: '3/3 received', dns: 'ok' }), offline: () => ok('OK'),
    },
    proxy: { apply: () => ok({}), status: () => ok({ enabled: false }) },
    phone: {
      set: () => ok({ ok: true }), status: () => ok({ number: '+15555210001', operator: '中国移动' }),
      call: () => ok({ ok: true }), signal: () => ok({ ok: true }), data: () => ok({ ok: true }),
      sms: () => ok({ ok: true }), listSms: () => ok([]),
    },
    dev: {
      root: () => ok({}), rootStatus: () => ok({ root: true }), disk: () => ok({ raw: '/data 6G' }),
      sdcard: () => ok('ok'), display: () => ok({}), displayStatus: () => ok({}), displayReset: () => ok({}),
      screenshot: () => ok('_shot.png'),
      volume: () => ok({}), audio: () => ok({}), speaker: () => ok({}),
      camera: () => ok({}), cameraStatus: () => ok({ back: 'virtualscene', front: 'emulated' }),
      setDevice: () => ok({ resolution: cfg.resolution }), info: () => ok({ model: 'SM-S918B' }),
      shell: () => ok('ok'), rootShell: () => ok('ok'), console: () => ok('OK'),
      key: () => ok({}), rotate: () => ok({}),
    },
    camera: {
      hosts: () => ok([{ index: 0, name: 'USB2.0 HD UVC WebCam', mode: 'webcam0' }]),
      status: () => ok({ back: 'virtualscene', front: 'emulated', images: [] }),
      set: () => ok({ ok: true, needRestart: true }),
      images: () =>
        ok([
          { name: 'region-20261103-210500.png', path: 'a', size: 128000, dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAPAAAACWCAIAAABvmpKCAAAB+klEQVR4nO3csW0CQRBAUbAoA1kWEZFFYFMGDVAf1ZAQEiICR5ZrcAcOrNOt9O+9dIOb4GuSW+36/XhaQcXL6AFgSoImRdCkCJoUQZMiaFIETYqgSRE0KYImRdCkCJoUQZMiaFIETYqgSRE0KYImRdCkCJoUQZMiaFI2P99fo2eAydjQpAiaFEGTImhSBE2KoEkRNCmCJkXQpAiaFEGTImhSNn8fH87XuSbpu10+R4/QZ0OTImhSBE2KoEkRNCmCJkXQpAiaFEGTImhSBE2KoEkRNCmCJkXQpAiaFEGTImhSBE2KoEkRNCmCJmW93X2MngEmY0OTImhSBE2KoEkRNCmCJkXQpAiaJb0P/fq2n2sSap6P+/wftaFJETQpgiZF0KQImhRBkyJoUgRNiqBJETQpgiZF0KQImhRBkyJoUgTNki74D7mjDf9mQ5MiaFIETYqgSRE0KYImRdCkCJoULyf1PZf0d8yGJkXQpAiaFEGTImhSBE2KoEkRNCmCJkXQpAiaFEGTImhSBE2KoEkRNCleTiLFhiZF0KQImhRBkyJoUgRNiqBJETQpgiZF0KQImhRBkyJoUgRNiqBJETQpgiZF0KQImhRBkyJoUgRNiqBJETQpgiZF0KQImhRBkyJoUgRNiqBJETQpgiZF0KQImhRBkyJoUgTNquQXK80TTwznvBgAAAAASUVORK5CYII=' },
          { name: 'avatar.jpg', path: 'b', size: 24000, dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAHgAAAB4CAIAAAC2BqGFAAACJElEQVR4nO3cwU3EQAxA0TBKHZxTBEVQBCVwoAhKoAjKoASfqQSJ6yqIw863Pfn/vGycJzMbJODh6+1ps/kN4BomNJcbDSU0lNBQQkMJDSU0lNBQQkMJDSU0lNBQQkMJDSU0lNBQQkMJDSU0lNBQ+9ah4/nl7xfE58dWu70v7tmLa6Lv3YnPvrwa976M79m7FREfSyoz79xso4/5EBUOk+SNPsB1y13tTOgDv/NE6zToI+mes66bA32kfhenXD0B+ijwGMDPMC6onDLJuKYyP8+4rDI8VZWfDJdvXHmdydnGxZWxCT06oIReBbr+ucHM6UZDzYXuss7AtG40lNBQQveH7nVAz57ZjYYSGkpoKKGhhIYSGkpoKKGhhIYSuj90kd8ALzKzGw0lNJTQS0D3OqZj5rRuNNR06C5LHZPndKOhhF4IOsqfHsCE0EZHYWtmNo8OKA46Si41NhW60VHMmpyHPjqijDU8ScIZHQWs+RlyPgwj1Trl6mlPHZFknXXdzMe7wO858Tsp+Tk6wDvPPa/y/9VP/N7/1N/xrfDxW+Unw5hmUUG5xEbfitxlu4v4VoS+12FSjbgu9K2X/5sUKkouacsPw+UTutsZ/frd74/d/tn74x0OLjcaSmgooaGEhhIaSmgooaGEhhIaSmgooaGEhhIaSmgooaGEhhIaSmgooaGEhhIaSmgooaGEhhIaSmgooaGEhhIaSmgooaGEhhJ6Y/oBvdaCpsJWBsYAAAAASUVORK5CYII=' },
        ]),
      deleteImage: () => ok({ ok: true }),
      captureScreen: () => ok(null),
      crop: () => ok({ ok: true, name: 'region-x.png', path: 'c' }),
      pickImage: () => ok(null),
    },
    sdk: {
      check: () => ok({ ready: SDK_READY }),
      mirrors: () =>
        ok({
          mirrors: [
            { id: 'google', name: 'Google 官方（dl.google.com）' },
            { id: 'tencent', name: '腾讯云镜像（国内加速）' },
          ],
          default: 'google',
        }),
      pending: () => ok([{ file: 'x86_64-34_r14.zip.part', bytes: 812000000, mtime: 0 }]),
      download: () => ok({ started: true }),
      cancel: () => ok({ ok: true }),
      onProgress: () => () => {},
    },
    ui: { pickApk: () => ok(null), installApk: () => ok('Success') },
    profile: {
      db: () => ok({ devices: 54328, brands: 3879 }), search: () => ok([]),
      list: () => ok([{ file: 'samsung_s23_ultra_arm.json', brand: 'samsung', device: 'dm3q', model: 'SM-S918B' }]),
      identity: () => ok({ brand: 'samsung', device: 'dm3q', model: 'SM-S918B' }),
      active: () => ok({ model: 'SM-S918B' }), canSpoof: () => ok({ ok: true }),
      apply: () => ok({ ok: true }), revert: () => ok({ ok: true }),
    },
    engine: { set: () => ok({}), current: () => ok('google_apis') },
    wifi: {
      enable: () => ok({ ok: true }), connect: () => ok({ ok: true }), add: () => ok({ ok: true }),
      list: () => ok([{ id: 0, ssid: 'AndroidWifi', security: 'open' }]),
      forget: () => ok({ ok: true }), scan: () => ok([]),
      status: () => ok({ enabled: true, connected: true, ssid: 'AndroidWifi', bssid: '00:13:10:85:fe:01', mac: '02:15:b2:00:00:00', rssi: '-50', supplicantState: 'COMPLETED' }),
    },
    bt: {
      enable: () => ok({ ok: false, blocked: true }), name: () => ok({ ok: true }),
      paired: () => ok([]), status: () => ok({ state: 'OFF', enabled: false, note: 'netsimd 不可用' }),
    },
    cell: {
      signal: () => ok({ ok: true }), rssi: () => ok({ ok: true }), data: () => ok({ ok: true }),
      voice: () => ok({ ok: true }), meter: () => ok({ ok: true }), operator: () => ok({ ok: true }),
      nettype: () => ok({ ok: true }), roaming: () => ok({ ok: true }),
      status: () => ok({ operator: '中国移动', networkType: 'LTE', signalLevel: '4', simState: 'LOADED', roaming: false, subscriptions: [{}, {}] }),
    },
  };
})();
