// 预加载脚本：暴露安全的 IPC 桥
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  info: () => invoke('app:info'),
  setSdkRoot: (d) => invoke('app:setSdkRoot', d),
  pickSdkDir: () => invoke('ui:pickSdkDir'),
  sdk: {
    check: () => invoke('sdk:check'),
    mirrors: () => invoke('sdk:mirrors'),
    pending: () => invoke('sdk:pending'),
    download: (o) => invoke('sdk:download', o),
    cancel: () => invoke('sdk:cancel'),
    onProgress: (cb) => {
      const h = (_e, data) => cb(data);
      ipcRenderer.on('sdk:progress', h);
      return () => ipcRenderer.removeListener('sdk:progress', h);
    },
  },
  // 通用任务进度（备份 / 还原）
  onTaskProgress: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('task:progress', h);
    return () => ipcRenderer.removeListener('task:progress', h);
  },
  windows: {
    arrange: (layout) => invoke('windows:arrange', layout),
  },
  camera: {
    hosts: () => invoke('camera:hosts'),
    status: () => invoke('camera:status'),
    set: (src) => invoke('camera:set', src),
    images: () => invoke('camera:images'),
    deleteImage: (n) => invoke('camera:deleteImage', n),
    captureScreen: () => invoke('camera:captureScreen'),
    crop: (o) => invoke('camera:crop', o),
    pickImage: () => invoke('camera:pickImage'),
  },
  config: {
    get: () => invoke('config:get'),
    save: (c) => invoke('config:save', c),
  },
  vm: {
    start: (o) => invoke('vm:start', o),
    stop: () => invoke('vm:stop'),
    restart: () => invoke('vm:restart'),
    status: () => invoke('vm:status'),
    log: (n) => invoke('vm:log', n),
    devices: () => invoke('vm:devices'),
    openLogDir: () => invoke('vm:openLogDir'),
  },
  instances: {
    list: () => invoke('instances:list'),
    create: (o) => invoke('instances:create', o),
    remove: (id) => invoke('instances:remove', id),
    rename: (id, name) => invoke('instances:rename', id, name),
    setActive: (id) => invoke('instances:setActive', id),
    active: () => invoke('instances:active'),
    clean: (id) => invoke('instances:clean', id),
    backup: (id) => invoke('instances:backup', id),
    backups: (id) => invoke('instances:backups', id),
    deleteBackup: (id, file) => invoke('instances:deleteBackup', id, file),
    restore: (id, file) => invoke('instances:restore', id, file),
    shortcut: (id) => invoke('instances:shortcut', id),
    thumb: (id) => invoke('instances:thumb', id),
  },
  net: {
    apply: (n) => invoke('net:apply', n),
    status: () => invoke('net:status'),
    test: () => invoke('net:test'),
    offline: (v) => invoke('net:offline', v),
  },
  proxy: {
    apply: (p) => invoke('proxy:apply', p),
    status: () => invoke('proxy:status'),
  },
  phone: {
    set: (p) => invoke('phone:set', p),
    status: () => invoke('phone:status'),
    call: (a, n) => invoke('phone:call', a, n),
    signal: (l) => invoke('phone:signal', l),
    data: (a) => invoke('phone:data', a),
    sms: (from, text) => invoke('phone:sms', from, text),
    listSms: (n) => invoke('phone:listSms', n),
  },
  dev: {
    root: (v) => invoke('dev:root', v),
    rootStatus: () => invoke('dev:rootStatus'),
    disk: () => invoke('dev:disk'),
    sdcard: () => invoke('dev:sdcard'),
    display: (d) => invoke('dev:display', d),
    displayStatus: () => invoke('dev:displayStatus'),
    displayReset: () => invoke('dev:displayReset'),
    screenshot: () => invoke('dev:screenshot'),
    volume: (v) => invoke('dev:volume', v),
    audio: () => invoke('dev:audio'),
    speaker: (s) => invoke('dev:speaker', s),
    camera: (c) => invoke('dev:camera', c),
    cameraStatus: () => invoke('dev:cameraStatus'),
    setDevice: (k, o) => invoke('dev:setDevice', k, o),
    info: () => invoke('dev:info'),
    shell: (c) => invoke('dev:shell', c),
    rootShell: (c) => invoke('dev:rootShell', c),
    console: (c) => invoke('dev:console', c),
    key: (n) => invoke('dev:key', n),
    rotate: (d) => invoke('dev:rotate', d),
  },
  ui: {
    pickApk: () => invoke('ui:pickApk'),
    installApk: (f) => invoke('ui:installApk', f),
  },
  profile: {
    db: () => invoke('profile:db'),
    search: (kw, n) => invoke('profile:search', kw, n),
    list: () => invoke('profile:list'),
    identity: () => invoke('profile:identity'),
    active: () => invoke('profile:active'),
    canSpoof: () => invoke('profile:canSpoof'),
    apply: (name) => invoke('profile:apply', name),
    revert: () => invoke('profile:revert'),
  },
  engine: {
    set: (e) => invoke('engine:set', e),
    current: () => invoke('engine:current'),
  },
  wifi: {
    enable: (on) => invoke('wifi:enable', on),
    connect: (s, sec, pw) => invoke('wifi:connect', s, sec, pw),
    add: (s, sec, pw) => invoke('wifi:add', s, sec, pw),
    list: () => invoke('wifi:list'),
    forget: (id) => invoke('wifi:forget', id),
    scan: () => invoke('wifi:scan'),
    status: () => invoke('wifi:status'),
  },
  bt: {
    enable: (on, force) => invoke('bt:enable', on, force),
    name: (n) => invoke('bt:name', n),
    paired: () => invoke('bt:paired'),
    status: () => invoke('bt:status'),
    suppressCrash: () => invoke('bt:suppressCrash'),
    restore: () => invoke('bt:restore'),
  },
  cell: {
    signal: (lv) => invoke('cell:signal', lv),
    rssi: (r, b) => invoke('cell:rssi', r, b),
    data: (s) => invoke('cell:data', s),
    voice: (s) => invoke('cell:voice', s),
    meter: (m) => invoke('cell:meter', m),
    operator: (n) => invoke('cell:operator', n),
    nettype: (t) => invoke('cell:nettype', t),
    roaming: (on) => invoke('cell:roaming', on),
    status: () => invoke('cell:status'),
  },
});
