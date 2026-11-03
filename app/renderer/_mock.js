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
    onTaskProgress: () => () => {},
    windows: { arrange: () => ok({ ok: true, arranged: 2, running: 2 }) },
    update: {
      check: () => ok({ phase: 'available', message: '发现新版本 1.1.0', info: { version: '1.1.0', notes: '修复若干问题' }, packaged: true }),
      download: () => ok({ phase: 'downloading', message: '下载中 0%' }),
      install: () => ok({ ok: true }),
      state: () => ok({ phase: 'idle', packaged: true }),
      onStatus: () => () => {},
    },
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
        { file: 'main-20261103210000.img', path: 'a', bytes: 4.2 * 1024 * 1024 * 1024, mtime: Date.now() - 3600e3 },
        { file: 'main-20261102153000.img', path: 'b', bytes: 3.9 * 1024 * 1024 * 1024, mtime: Date.now() - 86400e3 },
      ]),
      deleteBackup: () => ok({ ok: true }),
      restore: () => ok({ ok: true }),
      shortcut: () => ok({ ok: true, file: 'C:\\Users\\me\\Desktop\\主实例.lnk' }),
      thumb: () => ok({ dataUrl: 'data:image/png;base64,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', width: 1080, height: 2400 }),
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
      liveStart: () => ok({ ok: true, file: 'C:\\x\\live-region.png', intervalMs: 2000 }),
      liveStop: () => ok({ ok: true }),
      liveStatus: () => ok({ on: false }),
      onLiveFrame: () => () => {},
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
      suppressCrash: () => ok({ ok: true }), restore: () => ok({ ok: true }),
    },
    cell: {
      signal: () => ok({ ok: true }), rssi: () => ok({ ok: true }), data: () => ok({ ok: true }),
      voice: () => ok({ ok: true }), meter: () => ok({ ok: true }), operator: () => ok({ ok: true }),
      nettype: () => ok({ ok: true }), roaming: () => ok({ ok: true }),
      status: () => ok({ operator: '中国移动', networkType: 'LTE', signalLevel: '4', simState: 'LOADED', roaming: false, subscriptions: [{}, {}] }),
    },
  };
})();
