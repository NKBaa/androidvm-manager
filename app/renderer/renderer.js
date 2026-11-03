// 渲染进程：界面交互
(() => {
const $ = (id) => document.getElementById(id);
// 注意：window.api 已由 preload 注入，这里用局部别名避免全局重名
const bridge = window.api;

let config = null;
let statusTimer = null;
let rotateDeg = 0;

const NET_PRESETS = [
  ['offline', '离线（无网络）'],
  ['gsm', '2G / EDGE'],
  ['gprs', '2G / GPRS'],
  ['edge', '2.5G / EDGE'],
  ['umts', '3G / UMTS'],
  ['hsdpa', '3.5G / HSPA'],
  ['lte', '4G / LTE'],
  ['full-lte', '4G+ / LTE-A'],
  ['wifi', 'WiFi'],
  ['5g', '5G'],
];

const DEVICES = [
  ['pixel_7', 'Pixel 7（1080×2400）'],
  ['pixel_8_pro', 'Pixel 8 Pro（1344×2992）'],
  ['pixel_5', 'Pixel 5（1080×2340）'],
  ['s23_ultra', 'Galaxy S23 Ultra（1440×3088）'],
  ['mi13', 'Xiaomi 13（1080×2400）'],
  ['tablet', 'Pixel Tablet（2560×1600）'],
];

function toast(msg, kind = '') {
  const el = $('toast');
  el.textContent = msg;
  el.className = kind;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.textContent = ''; el.className = ''; }, 6000);
}

async function call(promise, label, quiet = false) {
  const r = await promise;
  if (!r.ok) {
    if (!quiet) toast(`${label}失败：${r.error}`, 'err');
    return null;
  }
  if (!quiet) toast(`${label}成功`, 'ok');
  return r.data;
}

// ---------- 标签切换 ----------
document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    $('panel-' + t.dataset.tab).classList.add('active');
  });
});

// ---------- 多开实例 ----------
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function instDotClass(it) {
  if (it.online) return 'on';
  if (it.listening || it.booting) return 'busy';
  return '';
}

async function refreshInstances() {
  const r = await call(bridge.instances.list(), '读取实例', true);
  if (!r) return;
  const wrap = $('instList');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!r.list.length) {
    wrap.innerHTML = '<div class="inst-empty">还没有实例</div>';
    return;
  }
  for (const it of r.list) {
    const el = document.createElement('div');
    el.className = 'inst-item' + (it.active ? ' active' : '');
    el.dataset.id = it.id;
    el.title = `${it.name} · ${it.serial}${it.online ? ' · 运行中' : it.listening ? ' · 启动中' : ' · 已停止'}`;
    el.innerHTML =
      `<span class="inst-dot ${instDotClass(it)}"></span>` +
      `<div class="inst-meta">` +
      `<div class="inst-name">${escapeHtml(it.name)}</div>` +
      `<div class="inst-port">${escapeHtml(it.serial)}</div>` +
      `</div>` +
      `<button class="inst-del" title="删除实例">×</button>`;
    el.addEventListener('click', async (e) => {
      if (e.target.classList.contains('inst-del')) return;
      if (it.active) return;
      await switchInstance(it.id);
    });
    el.querySelector('.inst-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      await removeInstance(it);
    });
    wrap.appendChild(el);
  }
}

async function switchInstance(id) {
  const r = await call(bridge.instances.setActive(id), '切换实例');
  if (!r) return;
  toast(`已切换到「${r.name}」`, 'ok');
  $('screen').style.display = 'none';
  $('screenHint').style.display = '';
  await loadConfig();
  await refreshStatus();
  await refreshInstances();
}

async function removeInstance(it) {
  if (!window.confirm(`确定删除实例「${it.name}」？\n其 AVD 目录与数据会被一并删除，无法恢复。`)) return;
  const r = await call(bridge.instances.remove(it.id), '删除实例');
  if (r) {
    toast(`已删除「${it.name}」`, 'ok');
    await refreshInstances();
  }
}

$('btnInstNew').addEventListener('click', async () => {
  const n = document.querySelectorAll('.inst-item').length + 1;
  const name = window.prompt('新实例名称（会克隆当前实例的机型/镜像设置，数据为全新）', `实例 ${n}`);
  if (name === null) return;
  toast('正在创建实例…');
  const r = await call(bridge.instances.create({ name: name || undefined }), '新建实例');
  if (r) {
    toast(`已创建「${r.name}」（${r.avdName} / 端口 ${r.port}）`, 'ok');
    await refreshInstances();
  }
});

// ---------- 状态轮询 ----------
function setSb(kind, text) {
  const d = $('sbDot');
  if (d) d.className = 'sb-dot ' + kind;
  const s = $('sbState');
  if (s) s.textContent = text;
}

async function refreshStatus() {
  const st = await call(bridge.vm.status(), '获取状态', true);
  if (!st) {
    $('statusDot').className = 'dot off';
    $('statusText').textContent = '服务异常';
    setSb('', '服务异常');
    return;
  }
  const dot = $('statusDot');
  const instName = st.name || st.id || '实例';
  if (st.online) {
    dot.className = 'dot on';
    $('statusText').textContent = `${instName} · 运行中 · Android ${st.props.release || '?'} · ${st.props.model || ''}`;
    setSb('on', `运行中 · ${instName}`);
  } else if (st.booting) {
    dot.className = 'dot busy';
    $('statusText').textContent = `${instName} · 启动中… ${st.bootSeconds || 0}s`;
    setSb('busy', `启动中 ${st.bootSeconds || 0}s · ${instName}`);
  } else if (st.running) {
    dot.className = 'dot busy';
    $('statusText').textContent = `${instName} · 进程运行中，等待 ADB…`;
    setSb('busy', `等待 ADB · ${instName}`);
  } else {
    dot.className = 'dot off';
    $('statusText').textContent = `${instName} · 未启动`;
    setSb('', `未启动 · ${instName}`);
  }

  const p = st.props || {};
  $('vmInfo').innerHTML = [
    ['运行状态', st.online ? '已就绪' : st.booting ? '启动中' : st.running ? '进程运行中' : '已停止'],
    ['Android 版本', p.release ? `${p.release}（API ${p.sdk}）` : '—'],
    ['设备机型', p.model ? `${p.brand || ''} ${p.model}` : '—'],
    ['Root', p.root ? '已启用（uid=0）' : '未启用'],
    ['运行时长', st.uptime ? `${Math.floor(st.uptime / 60)} 分 ${st.uptime % 60} 秒` : '—'],
    ['ADB 序列', st.serial],
    ['控制台端口', st.consolePort],
    ['PID', st.pid || '—'],
  ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');

  // 底部状态栏
  const dev = $('sbDevice');
  if (dev) dev.textContent = p.model ? `${p.brand || ''} ${p.model}` : '—';
  const and = $('sbAndroid');
  if (and) and.textContent = p.release ? `Android ${p.release}` : '—';
  const rt = $('sbRoot');
  if (rt) rt.textContent = st.online ? (p.root ? 'Root ✓' : '无 Root') : '—';

  // 按钮可用性
  const bs = $('btnStart'), bt = $('btnStop');
  if (bs) bs.disabled = !!st.running;
  if (bt) bt.disabled = !st.running;
}

// ---------- 启动 / 停止 ----------
$('btnStart').addEventListener('click', async () => {
  $('btnStart').disabled = true;
  toast('正在启动虚拟机，首次启动约需 40~90 秒…');
  const r = await call(bridge.vm.start({}), '启动');
  $('btnStart').disabled = false;
  if (r) setTimeout(refreshStatus, 1200);
});

$('btnStop').addEventListener('click', async () => {
  await call(bridge.vm.stop(), '停止');
  setTimeout(refreshStatus, 800);
});

$('btnRestart').addEventListener('click', async () => {
  $('btnRestart').disabled = true;
  toast('正在重启…');
  await call(bridge.vm.restart(), '重启');
  $('btnRestart').disabled = false;
  setTimeout(refreshStatus, 1500);
});

$('btnRefreshInfo').addEventListener('click', () => { refreshStatus(); toast('已刷新', 'ok'); });

$('btnShot').addEventListener('click', async () => {
  const data = await call(bridge.dev.screenshot(), '截屏');
  if (data) {
    $('screen').src = data;
    $('screen').style.display = 'block';
    $('screenHint').style.display = 'none';
  }
});

// ---------- 快捷操作：安装 APK / 导航键 / 音量 / 旋转 / 电源 ----------
$('btnQuickApk').addEventListener('click', async () => {
  const file = await call(bridge.ui.pickApk(), '选择 APK', true);
  if (!file) return;
  toast('正在安装 APK…');
  const r = await call(bridge.ui.installApk(file), '安装 APK');
  if (r) toast(typeof r === 'string' && /Success/i.test(r) ? 'APK 安装成功' : String(r).slice(0, 80), /Success/i.test(String(r)) ? 'ok' : 'err');
});

const NAV = [
  ['btnNavBack', 'back', '返回键'],
  ['btnNavHome', 'home', '主页键'],
  ['btnNavRecents', 'recents', '最近任务'],
  ['btnVolUp', 'volume_up', '音量 +'],
  ['btnVolDown', 'volume_down', '音量 −'],
  ['btnPower', 'power', '电源键'],
];
for (const [id, key, label] of NAV) {
  const el = $(id);
  if (el) el.addEventListener('click', async () => {
    await call(bridge.dev.key(key), label, true);
  });
}

$('btnRotate').addEventListener('click', async () => {
  rotateDeg = (rotateDeg + 90) % 360;
  const r = await call(bridge.dev.rotate(rotateDeg), '旋转屏幕', true);
  if (r) {
    toast(`已旋转到 ${rotateDeg}°`, 'ok');
    setTimeout(async () => {
      const data = await call(bridge.dev.screenshot(), '截屏', true);
      if (data) { $('screen').src = data; $('screen').style.display = 'block'; $('screenHint').style.display = 'none'; }
    }, 1200);
  }
});

// ---------- 配置 ----------
async function loadConfig() {
  config = await call(bridge.config.get(), '读取配置', true);
  if (!config) return;
  $('cfgRam').value = String(config.ram);
  $('cfgCores').value = String(config.cores);
  $('cfgDisk').value = String(config.diskGB);
  $('cfgRoot').checked = !!config.root;
  $('cfgWritable').checked = !!config.writableSystem;
  $('cfgHostAudio').checked = !!config.audio.host;
  $('cfgSnapshot').checked = !!config.snapshot;

  const sel = $('cfgDevice');
  const sel2 = $('hwDevice');
  sel.innerHTML = DEVICES.map(([k, n]) => `<option value="${k}">${n}</option>`).join('');
  sel2.innerHTML = sel.innerHTML;
  sel.value = config.deviceKey;
  sel2.value = config.deviceKey;

  const res = config.resolution;
  $('dispW').value = res.width;
  $('dispH').value = res.height;
  $('dispD').value = res.density;

  const px = config.proxy;
  $('pxEnabled').checked = !!px.enabled;
  $('pxType').value = px.type;
  $('pxHost').value = px.host || '';
  $('pxPort').value = px.port;
  $('pxUser').value = px.username || '';
  $('pxPass').value = px.password || '';
  $('pxSystem').checked = px.system !== false;

  const n = config.network;
  $('netDown').value = n.downloadKbps || 0;
  $('netUp').value = n.uploadKbps || 0;
  $('netLatency').value = n.latencyMs || 0;
  $('netLoss').value = n.packetLoss || 0;
  $('netRadio').value = n.radioType || 'LTE';
  markPreset(n.profile);

  const ph = config.phone;
  $('phNumber').value = ph.number || '';
  $('phOperator').value = ph.operator || '';
  $('phIccid').value = ph.iccid || '';
  $('phCountry').value = ph.country || '';

  const cam = config.camera;
  // 下拉框由 refreshCamData() 填充，这里先记下配置里的待选值
  camState.pendingBack = camValueOf(cam.back || 'virtualscene');
  camState.pendingFront = camValueOf(cam.front || 'emulated');
  $('hwRoot').checked = !!config.root;
}

$('btnSaveConfig').addEventListener('click', async () => {
  const cfg = {
    ...config,
    deviceKey: $('cfgDevice').value,
    ram: Number($('cfgRam').value),
    cores: Number($('cfgCores').value),
    diskGB: Number($('cfgDisk').value),
    root: $('cfgRoot').checked,
    writableSystem: $('cfgWritable').checked,
    audio: { ...config.audio, host: $('cfgHostAudio').checked },
    snapshot: $('cfgSnapshot').checked,
  };
  const r = await call(bridge.config.save(cfg), '保存配置');
  if (r) { config = r; toast('配置已保存，重启后生效', 'ok'); }
});

// ---------- 网络 ----------
function markPreset(key) {
  document.querySelectorAll('.preset').forEach((b) => b.classList.toggle('active', b.dataset.key === key));
}

function buildPresets() {
  const wrap = $('netPresets');
  wrap.innerHTML = '';
  for (const [k, label] of NET_PRESETS) {
    const b = document.createElement('button');
    b.className = 'preset';
    b.dataset.key = k;
    b.textContent = label;
    b.addEventListener('click', async () => {
      markPreset(k);
      const net = { profile: k, offline: k === 'offline', downloadKbps: 0, uploadKbps: 0, latencyMs: 0, packetLoss: 0, radioType: k === '5g' ? '5G' : k === 'lte' || k === 'full-lte' ? 'LTE' : k === 'offline' ? 'GSM' : 'UMTS' };
      const r = await call(bridge.net.apply(net), `切换到「${label}」`);
      if (r) $('netStatusOut').textContent = JSON.stringify(r, null, 2);
      config.network = net;
      await call(bridge.config.save(config), '保存网络配置', true);
      setTimeout(refreshNetStatus, 1500);
    });
    wrap.appendChild(b);
  }
}

async function refreshNetStatus() {
  const r = await call(bridge.net.status(), '查询网络', true);
  if (r) $('netStatusOut').textContent = JSON.stringify(r, null, 2);
}

$('btnOffline').addEventListener('click', async () => {
  await call(bridge.net.offline(true), '断开网络');
  await call(bridge.net.apply({ ...config.network, profile: 'offline', offline: true }), '应用离线', true);
  markPreset('offline');
});
$('btnOnline').addEventListener('click', async () => {
  await call(bridge.net.offline(false), '恢复网络');
  await call(bridge.net.apply({ ...config.network, offline: false, profile: 'wifi' }), '应用在线', true);
  markPreset('wifi');
});
$('btnNetStatus').addEventListener('click', refreshNetStatus);
$('btnNetTest').addEventListener('click', async () => {
  const r = await call(bridge.net.test(), '连通性测试');
  if (r) $('netStatusOut').textContent = `Ping:\n${r.ping}\n\nDNS:\n${r.dns}`;
});
$('btnNetApply').addEventListener('click', async () => {
  const net = {
    profile: 'custom',
    offline: false,
    downloadKbps: Number($('netDown').value) || 0,
    uploadKbps: Number($('netUp').value) || 0,
    latencyMs: Number($('netLatency').value) || 0,
    packetLoss: Number($('netLoss').value) || 0,
    radioType: $('netRadio').value,
  };
  const r = await call(bridge.net.apply(net), '应用自定义网络');
  if (r) $('netStatusOut').textContent = JSON.stringify(r, null, 2);
  config.network = net;
  await call(bridge.config.save(config), '保存', true);
});

// ---------- 代理 ----------
function gatherProxy() {
  return {
    enabled: $('pxEnabled').checked,
    type: $('pxType').value,
    host: $('pxHost').value.trim(),
    port: Number($('pxPort').value) || 8080,
    username: $('pxUser').value,
    password: $('pxPass').value,
    system: $('pxSystem').checked,
  };
}

$('btnProxyApply').addEventListener('click', async () => {
  const p = gatherProxy();
  if (p.enabled && !p.host) { toast('请填写代理主机地址', 'err'); return; }
  const r = await call(bridge.proxy.apply(p), '应用代理');
  if (r) $('proxyOut').textContent = JSON.stringify(r, null, 2);
  config.proxy = p;
  await call(bridge.config.save(config), '保存', true);
});

$('btnProxyClear').addEventListener('click', async () => {
  const r = await call(bridge.proxy.apply({ enabled: false }), '清除代理');
  if (r) $('proxyOut').textContent = '已清除代理';
  $('pxEnabled').checked = false;
  config.proxy = { ...config.proxy, enabled: false };
  await call(bridge.config.save(config), '保存', true);
});

$('btnProxyStatus').addEventListener('click', async () => {
  const r = await call(bridge.proxy.status(), '查询代理');
  if (r) $('proxyOut').textContent = JSON.stringify(r, null, 2);
});

// ---------- 电话 ----------
function phoneOut(o) { $('phoneOut').textContent = typeof o === 'string' ? o : JSON.stringify(o, null, 2); }

$('btnPhoneApply').addEventListener('click', async () => {
  const p = {
    number: $('phNumber').value,
    operator: $('phOperator').value,
    iccid: $('phIccid').value,
    country: $('phCountry').value,
  };
  const r = await call(bridge.phone.set(p), '应用号码');
  phoneOut(r || '失败');
  config.phone = { ...config.phone, ...p };
  await call(bridge.config.save(config), '保存', true);
});

$('btnPhoneStatus').addEventListener('click', async () => {
  const r = await call(bridge.phone.status(), '读取号码', true);
  phoneOut(r || '');
});

$('phSignal').addEventListener('input', async () => {
  const lv = Number($('phSignal').value);
  await call(bridge.phone.signal(lv), `信号设为 ${lv}`, true);
  toast(`信号强度已设为 ${lv}/4`, 'ok');
});
$('btnSig4').addEventListener('click', async () => { $('phSignal').value = 4; await call(bridge.phone.signal(4), '满格信号'); });
$('btnSig0').addEventListener('click', async () => { $('phSignal').value = 0; await call(bridge.phone.signal(0), '无信号'); });
$('btnDataHome').addEventListener('click', async () => { const r = await call(bridge.phone.data('home'), '蜂窝上网'); phoneOut(r || ''); });
$('btnDataRoam').addEventListener('click', async () => { const r = await call(bridge.phone.data('roaming'), '漫游上网'); phoneOut(r || ''); });

$('btnCallIn').addEventListener('click', async () => { const r = await call(bridge.phone.call('call', $('callNumber').value), '模拟来电'); phoneOut(r || ''); });
$('btnCallAccept').addEventListener('click', async () => { const r = await call(bridge.phone.call('accept', $('callNumber').value), '接听'); phoneOut(r || ''); });
$('btnCallHang').addEventListener('click', async () => { const r = await call(bridge.phone.call('cancel', $('callNumber').value), '挂断'); phoneOut(r || ''); });

$('btnSmsSend').addEventListener('click', async () => {
  const r = await call(bridge.phone.sms($('smsFrom').value, $('smsText').value), '注入短信');
  phoneOut(r || '');
});
$('btnSmsList').addEventListener('click', async () => {
  const r = await call(bridge.phone.listSms(20), '读取短信', true);
  phoneOut(r && r.length ? r.map((m) => `[${m.inbox ? '收' : '发'}] ${m.address}: ${m.body}`).join('\n') : '（无短信或需要权限）');
});

// ---------- 硬件 ----------
$('btnRootApply').addEventListener('click', async () => {
  const r = await call(bridge.dev.root($('hwRoot').checked), $('hwRoot').checked ? '开启 Root' : '关闭 Root');
  $('rootOut').textContent = JSON.stringify(r || '', null, 2);
  setTimeout(async () => {
    const s = await call(bridge.dev.rootStatus(), '检查', true);
    if (s) $('rootOut').textContent = JSON.stringify(s, null, 2);
  }, 2500);
});
$('btnRootStatus').addEventListener('click', async () => {
  const r = await call(bridge.dev.rootStatus(), '检查 Root', true);
  $('rootOut').textContent = JSON.stringify(r || '', null, 2);
  if (r) $('hwRoot').checked = r.root;
});

$('btnDisk').addEventListener('click', async () => {
  const r = await call(bridge.dev.disk(), '读取磁盘', true);
  $('diskOut').textContent = r ? `${r.raw}\n\n配置容量: ${r.configuredSize}` : '';
});
$('btnSdcard').addEventListener('click', async () => {
  const r = await call(bridge.dev.sdcard(), '读取 SD 卡', true);
  $('diskOut').textContent = r || '';
});

$('btnDispApply').addEventListener('click', async () => {
  const r = await call(bridge.dev.display({ width: Number($('dispW').value), height: Number($('dispH').value), density: Number($('dispD').value) }), '应用显示参数');
  $('dispOut').textContent = JSON.stringify(r || '', null, 2);
});
$('btnDispReset').addEventListener('click', async () => {
  await call(bridge.dev.displayReset(), '还原显示');
  $('dispOut').textContent = '已还原';
});
$('btnDispStatus').addEventListener('click', async () => {
  const r = await call(bridge.dev.displayStatus(), '读取显示', true);
  $('dispOut').textContent = JSON.stringify(r || '', null, 2);
});

$('btnVolApply').addEventListener('click', async () => {
  const r = await call(bridge.dev.volume({ music: Number($('volMusic').value), ring: Number($('volRing').value), call: Number($('volCall').value) }), '应用音量');
  $('audioOut').textContent = JSON.stringify(r || '', null, 2);
});
$('btnMute').addEventListener('click', async () => { await call(bridge.dev.speaker({ enabled: false }), '静音'); });
$('btnUnmute').addEventListener('click', async () => { await call(bridge.dev.speaker({ enabled: true }), '取消静音'); });
$('btnAudio').addEventListener('click', async () => {
  const r = await call(bridge.dev.audio(), '读取音频', true);
  $('audioOut').textContent = JSON.stringify(r || '', null, 2);
});

// ==================== 摄像头 ====================
const camState = { hosts: [], images: [], loaded: false };

/** 把配置值（如 "webcam0" / "imagefile:C:\x.png"）转成下拉框的 value */
function camValueOf(iniVal) {
  if (!iniVal) return 'emulated';
  if (/^webcam(\d+)$/i.test(iniVal)) return 'webcam:' + iniVal.match(/^webcam(\d+)$/i)[1];
  const m = iniVal.match(/^imagefile:(.+)$/i);
  if (m) return 'image:' + m[1].split(/[\\/]/).pop();
  return iniVal;
}

/** 下拉框 value 转成后端要的 spec 对象 */
function camSpecOf(value) {
  if (value === 'none' || value === 'emulated' || value === 'virtualscene') return { mode: value };
  if (value.startsWith('webcam:')) return { mode: 'webcam', index: Number(value.slice(7)) };
  if (value.startsWith('image:')) {
    const name = value.slice(6);
    const hit = camState.images.find((i) => i.name === name);
    if (!hit) throw new Error('找不到图片素材: ' + name);
    return { mode: 'imagefile', path: hit.path };
  }
  return { mode: 'emulated' };
}

function fillCamSelect(el, current) {
  const groups = [];
  groups.push(['基本', [
    ['none', '无'],
    ['emulated', '模拟画面（彩条）'],
    ['virtualscene', '虚拟场景（3D）'],
  ]]);
  if (camState.hosts.length) {
    groups.push(['宿主机摄像头', camState.hosts.map((c) => ['webcam:' + c.index, c.name + (c.approximate ? '（近似）' : '')])]);
  } else {
    groups.push(['宿主机摄像头', [['__nocam', '未检测到摄像头']]]);
  }
  if (camState.images.length) {
    groups.push(['图片 / 屏幕区域（实验性）', camState.images.map((i) => ['image:' + i.name, i.name])]);
  } else {
    groups.push(['图片 / 屏幕区域（实验性）', [['__noimg', '还没有素材，用下方按钮生成']]]);
  }

  el.innerHTML = '';
  for (const [label, opts] of groups) {
    const og = document.createElement('optgroup');
    og.label = label;
    for (const [v, t] of opts) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = t;
      if (v.startsWith('__')) o.disabled = true;
      og.appendChild(o);
    }
    el.appendChild(og);
  }
  if (current) el.value = current;
  if (!el.value) el.value = 'emulated';
}

function renderCamImages() {
  const box = $('camImgs');
  if (!box) return;
  if (!camState.images.length) {
    box.innerHTML = '<p class="hint">还没有素材。点「框选屏幕区域」或「选择图片文件」生成。</p>';
    return;
  }
  box.innerHTML = '';
  for (const it of camState.images) {
    const d = document.createElement('div');
    d.className = 'cam-img';
    d.dataset.name = it.name;
    d.innerHTML =
      (it.dataUrl ? `<img src="${it.dataUrl}" alt="">` : '') +
      `<span title="${escapeHtml(it.name)}">${escapeHtml(it.name)}</span>` +
      `<button title="删除">×</button>`;
    d.querySelector('button').addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (!window.confirm('删除素材「' + it.name + '」？')) return;
      await call(bridge.camera.deleteImage(it.name), '删除素材', true);
      await refreshCamData();
    });
    d.addEventListener('click', () => {
      // 点缩略图 = 把它设为后置摄像头
      $('camBack').value = 'image:' + it.name;
      toast('已选中 ' + it.name + ' 作为后置，点「应用并重启」生效');
    });
    box.appendChild(d);
  }
}

async function refreshCamData() {
  const [hosts, images] = await Promise.all([
    call(bridge.camera.hosts(), '枚举摄像头', true),
    call(bridge.camera.images(), '读取素材', true),
  ]);
  camState.hosts = hosts || [];
  camState.images = images || [];
  const curB = camState.loaded ? $('camBack').value : camState.pendingBack;
  const curF = camState.loaded ? $('camFront').value : camState.pendingFront;
  fillCamSelect($('camBack'), curB);
  fillCamSelect($('camFront'), curF);
  renderCamImages();
  camState.loaded = true;
}

$('btnCamApply').addEventListener('click', async () => {
  let spec;
  try {
    spec = { back: camSpecOf($('camBack').value), front: camSpecOf($('camFront').value) };
  } catch (e) {
    toast(e.message, 'err');
    return;
  }
  const r = await call(bridge.camera.set(spec), '应用摄像头设置');
  $('camOut').textContent = JSON.stringify(r || '', null, 2) + '\n（重启虚拟机后生效）';
  config.camera = {
    back: $('camBack').value,
    front: $('camFront').value,
  };
  await call(bridge.config.save(config), '保存', true);

  if (r && r.ok) {
    const restart = window.confirm('摄像头设置已写入。\n\n现在重启虚拟机让它生效吗？');
    if (restart) {
      toast('正在重启虚拟机…');
      await call(bridge.vm.restart(), '重启虚拟机', true);
    }
  }
});

$('btnCamStatus').addEventListener('click', async () => {
  const r = await call(bridge.camera.status(), '读取摄像头', true);
  $('camOut').textContent = JSON.stringify(r || '', null, 2);
  if (r) {
    $('camBack').value = camValueOf(r.back);
    $('camFront').value = camValueOf(r.front);
  }
});

$('btnCamRefreshImgs').addEventListener('click', async () => {
  await refreshCamData();
  toast('素材已刷新', 'ok');
});

$('btnCamPickFile').addEventListener('click', async () => {
  const r = await call(bridge.camera.pickImage(), '选择图片', true);
  if (!r || !r.ok) return;
  await refreshCamData();
  $('camBack').value = 'image:' + r.name;
  toast('已添加素材 ' + r.name + '，点「应用并重启」生效', 'ok');
});

// ---------- 屏幕区域框选 ----------
const regionState = { dataUrl: null, imgW: 0, imgH: 0, rect: null, dragging: false, sx: 0, sy: 0 };

function regionRectFromEvent(ev) {
  const stage = $('regionStage');
  const img = $('regionImg');
  const ir = img.getBoundingClientRect();
  const sr = stage.getBoundingClientRect();
  // 图片在 stage 里居中显示，换算成图片内坐标
  const offX = ir.left - sr.left;
  const offY = ir.top - sr.top;
  const scale = regionState.imgW / ir.width;
  const x = (ev.clientX - sr.left - offX) * scale;
  const y = (ev.clientY - sr.top - offY) * scale;
  return { x: Math.max(0, Math.min(regionState.imgW, x)), y: Math.max(0, Math.min(regionState.imgH, y)), offX, offY, scale };
}

function drawRegionSel(a, b) {
  const sel = $('regionSel');
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.abs(a.x - b.x);
  const h = Math.abs(a.y - b.y);
  sel.style.display = 'block';
  sel.style.left = (a.offX + x / a.scale) + 'px';
  sel.style.top = (a.offY + y / a.scale) + 'px';
  sel.style.width = (w / a.scale) + 'px';
  sel.style.height = (h / a.scale) + 'px';
  regionState.rect = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
  $('regionSize').textContent = `${regionState.rect.w} × ${regionState.rect.h}`;
  $('btnRegionOk').disabled = regionState.rect.w < 8 || regionState.rect.h < 8;
}

$('btnCamRegion').addEventListener('click', async () => {
  const shot = await call(bridge.camera.captureScreen(), '抓取屏幕', true);
  if (!shot) return;
  regionState.dataUrl = shot.dataUrl;
  regionState.imgW = shot.width;
  regionState.imgH = shot.height;
  regionState.rect = null;
  $('regionImg').src = shot.dataUrl;
  $('regionSel').style.display = 'none';
  $('regionSize').textContent = '';
  $('btnRegionOk').disabled = true;
  $('regionModal').style.display = 'flex';
});

$('regionStage').addEventListener('mousedown', (ev) => {
  if (ev.button !== 0) return;
  regionState.dragging = true;
  regionState.sx = regionRectFromEvent(ev);
  regionState.sy = regionState.sx;
  $('regionSel').style.display = 'block';
});

$('regionStage').addEventListener('mousemove', (ev) => {
  if (!regionState.dragging) return;
  const cur = regionRectFromEvent(ev);
  drawRegionSel(regionState.sx, cur);
});

$('regionStage').addEventListener('mouseup', (ev) => {
  if (!regionState.dragging) return;
  regionState.dragging = false;
  drawRegionSel(regionState.sx, regionRectFromEvent(ev));
});

$('btnRegionCancel').addEventListener('click', () => {
  regionState.dragging = false;
  $('regionModal').style.display = 'none';
});

$('btnRegionOk').addEventListener('click', async () => {
  if (!regionState.rect) return;
  const r = await call(
    bridge.camera.crop({
      dataUrl: regionState.dataUrl,
      rect: regionState.rect,
      name: 'region-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14),
    }),
    '保存选区'
  );
  $('regionModal').style.display = 'none';
  if (!r || !r.ok) return;
  await refreshCamData();
  $('camBack').value = 'image:' + r.name;
  toast('已保存素材 ' + r.name + '，点「应用并重启」生效', 'ok');
});

$('btnDeviceApply').addEventListener('click', async () => {
  const r = await call(bridge.dev.setDevice($('hwDevice').value, {}), '应用机型');
  $('devOut').textContent = JSON.stringify(r || '', null, 2);
  config.deviceKey = $('hwDevice').value;
  if (r) config.resolution = r.resolution;
  await call(bridge.config.save(config), '保存', true);
});
$('btnDeviceInfo').addEventListener('click', async () => {
  const r = await call(bridge.dev.info(), '读取设备信息', true);
  $('devOut').textContent = JSON.stringify(r || '', null, 2);
});

// ---------- Shell ----------
$('btnShellRun').addEventListener('click', async () => {
  const cmd = $('shellCmd').value.trim();
  if (!cmd) return;
  $('shellOut').textContent = '执行中…';
  const r = $('shellRoot').checked ? await bridge.dev.rootShell(cmd) : await bridge.dev.shell(cmd);
  $('shellOut').textContent = r.ok ? (r.data || '（无输出）') : '错误: ' + r.error;
});

$('btnLogRefresh').addEventListener('click', async () => {
  const r = await call(bridge.vm.log(200), '读取日志', true);
  $('logOut').textContent = r || '（无日志）';
  $('logOut').scrollTop = $('logOut').scrollHeight;
});
$('btnLogDir').addEventListener('click', async () => { await call(bridge.vm.openLogDir(), '打开目录'); });

// ---------- 真机档案 ----------
function profShow(v) {
  $('profOut').textContent = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
}

$('btnProfSearch').addEventListener('click', async () => {
  const kw = $('profSearch').value.trim();
  const rows = await call(bridge.profile.search(kw, 25), '搜索真机');
  if (!rows) return;
  if (!rows.length) return profShow(`没有匹配 "${kw}" 的真机`);
  profShow(
    `${rows.length} 条结果（品牌 / 型号 / 代号 / 市场名）：\n` +
      rows.map((r) => `${r.brand}  |  ${r.model}  |  ${r.device}  |  ${r.marketing}`).join('\n')
  );
});

$('btnProfList').addEventListener('click', async () => {
  const ps = await call(bridge.profile.list(), '列出档案');
  if (!ps) return;
  if (!ps.length) return profShow('还没有档案。可用命令行 node tools/profile-cli.js make 生成。');
  profShow(ps.map((p) => `${p.file}\n  ${p.brand}/${p.device}  ${p.model}`).join('\n'));
});

$('btnProfIdentity').addEventListener('click', async () => {
  profShow(await call(bridge.profile.identity(), '读取身份'));
});

$('btnProfApply').addEventListener('click', async () => {
  const name = $('profApplyName').value.trim();
  if (!name) return toast('请填写档案名或真机型号', 'err');
  profShow('应用中（需要 root + 可写 system，随后会自动重启）…');
  const r = await call(bridge.profile.apply(name), '应用真机档案');
  profShow(r || '应用失败');
  if (r && r.ok) toast('已写入，正在重启；启动后用「当前身份」验证', 'ok');
});

$('btnProfRevert').addEventListener('click', async () => {
  profShow('还原中…');
  const r = await call(bridge.profile.revert(), '还原身份');
  profShow(r || '还原失败');
  if (r && r.ok) toast('已还原并重启', 'ok');
});

// ---------- WiFi / 蓝牙 / 移动网络 ----------
function showWifi(v) { $('wifiOut').textContent = typeof v === 'string' ? v : JSON.stringify(v, null, 2); }
function showBt(v) { $('btOut').textContent = typeof v === 'string' ? v : JSON.stringify(v, null, 2); }
function showCell(v) { $('cellOut').textContent = typeof v === 'string' ? v : JSON.stringify(v, null, 2); }

$('btnWifiOn').addEventListener('click', async () => showWifi(await call(bridge.wifi.enable(true), '开启 WiFi')));
$('btnWifiOff').addEventListener('click', async () => showWifi(await call(bridge.wifi.enable(false), '关闭 WiFi')));
$('btnWifiStatus').addEventListener('click', async () => showWifi(await call(bridge.wifi.status(), '读取 WiFi')));
$('btnWifiConnect').addEventListener('click', async () => {
  showWifi(await call(bridge.wifi.connect($('wifiSsid').value.trim(), $('wifiSec').value, $('wifiPass').value), '连接 WiFi'));
});
$('btnWifiAdd').addEventListener('click', async () => {
  showWifi(await call(bridge.wifi.add($('wifiSsid').value.trim(), $('wifiSec').value, $('wifiPass').value), '保存网络'));
});
$('btnWifiList').addEventListener('click', async () => showWifi(await call(bridge.wifi.list(), '已保存网络')));
$('btnWifiScan').addEventListener('click', async () => {
  const r = await call(bridge.wifi.scan(), '扫描');
  showWifi(r && r.length ? r : '没有扫描到 AP（模拟器只有内置虚拟 AP）');
});

$('btnBtOn').addEventListener('click', async () => showBt(await call(bridge.bt.enable(true, false), '开启蓝牙')));
$('btnBtOff').addEventListener('click', async () => showBt(await call(bridge.bt.enable(false, false), '关闭蓝牙')));
$('btnBtStatus').addEventListener('click', async () => showBt(await call(bridge.bt.status(), '蓝牙状态')));
$('btnBtPaired').addEventListener('click', async () => {
  const r = await call(bridge.bt.paired(), '配对设备');
  showBt(r && r.length ? r : '没有配对设备');
});
$('btnBtName').addEventListener('click', async () => {
  const n = $('btName').value.trim();
  if (!n) return toast('请填写蓝牙名称', 'err');
  showBt(await call(bridge.bt.name(n), '设置蓝牙名称'));
});

$('btnCellApply').addEventListener('click', async () => {
  showCell('应用中…');
  const out = {};
  out.signal = await call(bridge.cell.signal(Number($('cellSignal').value)), '信号', true);
  out.data = await call(bridge.cell.data($('cellData').value), '数据', true);
  out.voice = await call(bridge.cell.voice($('cellVoice').value), '语音', true);
  out.type = await call(bridge.cell.nettype($('cellType').value), '制式', true);
  const op = $('cellOperator').value.trim();
  if (op) out.operator = await call(bridge.cell.operator(op), '运营商', true);
  out.roaming = await call(bridge.cell.roaming($('cellRoaming').checked), '漫游', true);
  out.status = await call(bridge.cell.status(), '状态', true);
  showCell(out);
  toast('移动网络参数已应用', 'ok');
});
$('btnCellStatus').addEventListener('click', async () => showCell(await call(bridge.cell.status(), '移动网络状态')));

// ---------- SDK 检查（安装包首次运行常见） ----------
let sdkMirrorsLoaded = false;
let appInfo = null;

async function loadSdkMirrors() {
  if (sdkMirrorsLoaded) return;
  const r = await call(bridge.sdk.mirrors(), '读取镜像源', true);
  const sel = $('sdkMirror');
  if (!r || !sel) return;
  sel.innerHTML = '';
  for (const m of r.mirrors || []) {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = m.name;
    sel.appendChild(o);
  }
  sel.value = r.default || 'google';
  sdkMirrorsLoaded = true;
}

async function checkSdk() {
  const info = await call(bridge.info(), '读取信息', true);
  if (!info) return;
  appInfo = info;
  const st = await call(bridge.sdk.check(), '检查 SDK', true);
  const ready = st ? st.ready : info.sdkReady;
  if (ready) return;
  const b = $('sdkBanner');
  if (!b) return;
  b.style.display = 'flex';
  await loadSdkMirrors();

  // 有未下完的分片就提示可以续传
  const pending = await call(bridge.sdk.pending(), '读取续传状态', true);
  const resumable = (pending || []).reduce((s, p) => s + (p.bytes || 0), 0);

  // 路径太长会把提示条撑爆，只显示尾部
  const full = info.sdkRoot || '';
  const short = full.length > 44 ? '…' + full.slice(-43) : full;

  const msg = $('sdkMsg');
  msg.innerHTML =
    `未找到 Android SDK（查找路径：<code>${escapeHtml(short)}</code>）` +
    (resumable > 0 ? `　可续传 <b>${fmtMB(resumable)}</b>` : '') +
    `　可在线下载，或选择已有 SDK 目录`;
  msg.title = full;
}

// ---------- SDK 在线下载 ----------
function fmtMB(n) {
  return (n / 1024 / 1024).toFixed(0) + ' MB';
}

let sdkUnsub = null;

function showSdkProgress(on) {
  const el = $('sdkProgress');
  if (!el) return;
  el.style.display = on ? 'flex' : 'none';
  if (!on) {
    $('sdkBar').style.width = '0%';
    $('sdkPct').textContent = '0%';
  }
}

function onSdkProgress(d) {
  const phase = d.phase;
  if (phase === 'error') {
    showSdkProgress(false);
    $('sdkBanner').style.display = 'flex';
    $('sdkMsg').textContent = 'SDK 下载失败：' + d.message;
    toast('SDK 下载失败：' + d.message, 'err');
    return;
  }
  if (phase === 'complete') {
    showSdkProgress(false);
    const r = d.result || {};
    if (r.ok && r.emulator && r.adb) {
      $('sdkBanner').style.display = 'none';
      toast('SDK 安装完成，可以启动虚拟机了', 'ok');
    } else {
      $('sdkBanner').style.display = 'flex';
      $('sdkMsg').textContent = 'SDK 安装不完整，请检查 emulator 与 platform-tools';
      toast('SDK 安装不完整', 'err');
    }
    return;
  }
  if (phase === 'done') {
    $('sdkPhase').textContent = '安装完成，校验中…';
    $('sdkBar').style.width = '100%';
    $('sdkPct').textContent = '100%';
    return;
  }
  if (phase === 'download') {
    const tag = d.resumedFrom > 0 ? '（续传）' : '';
    $('sdkPhase').textContent = `${d.file}${tag}  ${fmtMB(d.received)} / ${fmtMB(d.total)}`;
    const pct = d.overallPercent || 0;
    $('sdkBar').style.width = pct.toFixed(1) + '%';
    $('sdkPct').textContent = pct.toFixed(0) + '%';
    return;
  }
  if (phase === 'resolve') { $('sdkPhase').textContent = d.message || '解析组件清单…'; return; }
  if (phase === 'resolved') {
    const n = (d.packages || []).length;
    $('sdkPhase').textContent = `${d.mirrorName || ''} · 共 ${n} 个组件，合计 ${fmtMB(d.totalBytes || 0)}`;
    return;
  }
  if (phase === 'download-start') {
    $('sdkPhase').textContent = d.resumable
      ? `续传 ${d.file}（已有 ${fmtMB(d.resumedFrom)}）`
      : '开始下载 ' + d.file;
    return;
  }
  if (phase === 'verify') { $('sdkPhase').textContent = '校验 ' + d.package + ' …'; return; }
  if (phase === 'extract') { $('sdkPhase').textContent = '解压 ' + d.package + ' …'; return; }
  if (phase === 'package-done') {
    const pct = d.overallPercent || 0;
    $('sdkBar').style.width = pct.toFixed(1) + '%';
    $('sdkPct').textContent = pct.toFixed(0) + '%';
    return;
  }
}

$('btnDownloadSdk').addEventListener('click', async () => {
  await loadSdkMirrors();
  const mirror = $('sdkMirror') ? $('sdkMirror').value : 'google';
  const mirrorName = $('sdkMirror') && $('sdkMirror').selectedOptions[0]
    ? $('sdkMirror').selectedOptions[0].textContent
    : mirror;

  const pending = await call(bridge.sdk.pending(), '读取续传状态', true);
  const resumable = (pending || []).reduce((s, p) => s + (p.bytes || 0), 0);
  const resumeLine = resumable > 0 ? `\n\n检测到未下完的分片（${fmtMB(resumable)}），将自动续传。` : '';

  const ok = window.confirm(
    `将从 ${mirrorName} 下载 Android SDK：\n\n` +
      '  • emulator            约 439 MB\n' +
      '  • platform-tools      约 8 MB\n' +
      '  • Android 14 系统镜像  约 1491 MB\n\n' +
      `合计约 1.9 GB，解压后约 5.4 GB。${resumeLine}\n确定开始下载？`
  );
  if (!ok) return;
  showSdkProgress(true);
  $('sdkPhase').textContent = '准备中…';
  if (!sdkUnsub) sdkUnsub = bridge.sdk.onProgress(onSdkProgress);
  const r = await call(bridge.sdk.download({ mirror }), '开始下载', true);
  if (!r) {
    showSdkProgress(false);
    toast('无法开始下载', 'err');
  }
});

$('btnSdkCancel').addEventListener('click', async () => {
  await call(bridge.sdk.cancel(), '取消下载', true);
  showSdkProgress(false);
  toast('已取消下载');
});

$('btnPickSdk').addEventListener('click', async () => {
  const dir = await call(bridge.pickSdkDir(), '选择目录', true);
  if (!dir) return;
  const r = await call(bridge.setSdkRoot(dir), '保存 SDK 路径');
  if (r) toast('已保存 SDK 路径，重启应用后生效', 'ok');
});

// ==================== 视图切换 ====================
let currentView = 'launcher';

function switchView(v) {
  currentView = v;
  const launcher = $('viewLauncher');
  const workspace = $('viewWorkspace');
  if (!launcher || !workspace) return;
  launcher.hidden = v !== 'launcher';
  workspace.hidden = v !== 'workspace';
  document.querySelectorAll('.rail-btn[data-view]').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === v);
  });
}

document.querySelectorAll('.rail-btn[data-view]').forEach((b) => {
  b.addEventListener('click', () => switchView(b.dataset.view));
});

// ==================== 设备网格 ====================
let devCache = [];
let devActiveId = null;
let devViewMode = 'grid';
let devSortMode = 'default';
let devQuery = '';
let ctxTarget = null;

function devStatusOf(it) {
  if (it.online) return { text: '运行中', running: true };
  if (it.listening || it.booting) return { text: '启动中', running: false };
  return { text: '未开机', running: false };
}

function renderDeviceGrid() {
  const box = $('deviceGrid');
  if (!box) return;
  box.className = 'device-grid' + (devViewMode === 'list' ? ' list' : '');

  let list = devCache.slice();
  if (devQuery) {
    const q = devQuery.toLowerCase();
    list = list.filter(
      (it) => (it.name || '').toLowerCase().includes(q) || (it.serial || '').toLowerCase().includes(q)
    );
  }
  if (devSortMode === 'name') list.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  else if (devSortMode === 'status') list.sort((a, b) => Number(b.online) - Number(a.online));

  if (!list.length) {
    box.innerHTML = `<div class="dev-empty">${devQuery ? '没有匹配的设备' : '还没有设备，点左上角「＋ 新建设备」创建'}</div>`;
    return;
  }

  box.innerHTML = '';
  list.forEach((it, i) => {
    const st = devStatusOf(it);
    const s = it.summary || {};
    const el = document.createElement('div');
    el.className = 'dev-card' + (st.running ? ' running' : '');
    el.dataset.id = it.id;
    el.innerHTML =
      `<div class="dev-thumb">
         <span class="dev-index">#${i}</span>
         <div class="dev-thumb-ph">
           <svg viewBox="0 0 24 24"><rect x="6" y="2" width="12" height="20" rx="3"/><line x1="10" y1="18.5" x2="14" y2="18.5"/></svg>
           <span>${st.text}</span>
         </div>
       </div>
       <div class="dev-info">
         <div class="dev-text">
           <div class="dev-name">${escapeHtml(it.name)}</div>
           <div class="dev-tags">
             <span class="tag">Android 14</span>
             <span class="tag">${s.cores || 4} 核</span>
             <span class="tag">${Math.round((s.ram || 4096) / 1024)} GB</span>
             ${s.root ? '<span class="tag">Root</span>' : ''}
           </div>
           <div class="dev-meta">${s.width || 1080} × ${s.height || 2400} | ${s.density || 420} DPI</div>
         </div>
         <div class="dev-actions">
           <button class="dev-play${st.running ? ' stop' : ''}" title="${st.running ? '停止' : '启动'}">
             ${
               st.running
                 ? '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>'
                 : '<svg viewBox="0 0 24 24"><path d="M8 5l11 7-11 7z"/></svg>'
             }
           </button>
           <button class="dev-more" title="更多操作">
             <svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/></svg>
           </button>
         </div>
       </div>`;

    el.addEventListener('click', async (e) => {
      if (e.target.closest('.dev-play') || e.target.closest('.dev-more')) return;
      await openWorkspace(it.id);
    });
    el.querySelector('.dev-play').addEventListener('click', async (e) => {
      e.stopPropagation();
      await toggleDevice(it);
    });
    el.querySelector('.dev-more').addEventListener('click', (e) => {
      e.stopPropagation();
      openCtxMenu(e.clientX, e.clientY, it);
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openCtxMenu(e.clientX, e.clientY, it);
    });
    box.appendChild(el);
  });
}

async function refreshDevices() {
  const r = await call(bridge.instances.list(), '读取设备', true);
  if (!r) return;
  devCache = r.list || [];
  devActiveId = r.activeId;
  renderDeviceGrid();
}

async function toggleDevice(it) {
  const st = devStatusOf(it);
  if (it.id !== devActiveId) {
    const sw = await call(bridge.instances.setActive(it.id), '切换实例');
    if (!sw) return;
    devActiveId = it.id;
    await loadConfig();
  }
  if (st.running) await call(bridge.vm.stop(), '停止虚拟机');
  else await call(bridge.vm.start({}), '启动虚拟机');
  await refreshDevices();
  await refreshStatus();
}

async function openWorkspace(id) {
  if (id && id !== devActiveId) {
    const sw = await call(bridge.instances.setActive(id), '切换实例');
    if (!sw) return;
    devActiveId = id;
    await loadConfig();
  }
  switchView('workspace');
  await refreshStatus();
}

// ---------- 卡片右键菜单 ----------
function openCtxMenu(x, y, it) {
  ctxTarget = it;
  const m = $('ctxMenu');
  if (!m) return;
  m.style.display = 'block';
  const w = m.offsetWidth || 210;
  const h = m.offsetHeight || 300;
  m.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + 'px';
  m.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + 'px';
}

function closeCtxMenu() {
  const m = $('ctxMenu');
  if (m) m.style.display = 'none';
}

document.addEventListener('click', (e) => {
  const m = $('ctxMenu');
  if (m && !m.contains(e.target)) closeCtxMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeCtxMenu();
});
window.addEventListener('resize', closeCtxMenu);

$('ctxMenu').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const it = ctxTarget;
  closeCtxMenu();
  if (it) await handleCtxAction(act, it);
});

async function handleCtxAction(act, it) {
  switch (act) {
    case 'settings':
      await openDevSettings(it);
      break;

    case 'clean': {
      if (!it.online) return toast('设备未运行，无法清理缓存', 'err');
      const ok = window.confirm(`清理「${it.name}」的应用缓存？\n\n只会删除各应用的缓存文件，不会动数据。`);
      if (!ok) return;
      if (it.id !== devActiveId) {
        await call(bridge.instances.setActive(it.id), '切换实例');
        devActiveId = it.id;
      }
      const r = await call(bridge.instances.clean(it.id), '清理缓存');
      if (r) toast('缓存已清理', 'ok');
      break;
    }

    case 'rename': {
      const name = window.prompt('重命名设备', it.name);
      if (!name || name === it.name) return;
      const r = await call(bridge.instances.rename(it.id, name), '重命名');
      if (r) {
        toast('已重命名', 'ok');
        await refreshDevices();
      }
      break;
    }

    case 'clone': {
      const r = await call(bridge.instances.create({ name: it.name + ' 副本', fromId: it.id }), '复制设备');
      if (r) {
        toast('已复制为新设备', 'ok');
        await refreshDevices();
      }
      break;
    }

    case 'backup':
      await openBackupDialog(it);
      break;

    case 'shortcut': {
      const r = await call(bridge.instances.shortcut(it.id), '创建快捷方式');
      if (r) toast('已在桌面创建快捷方式', 'ok');
      break;
    }

    case 'delete': {
      const ok = window.confirm(`删除「${it.name}」？\n\n该设备的数据分区会一并删除，不可恢复。`);
      if (!ok) return;
      const r = await call(bridge.instances.remove(it.id), '删除设备');
      if (r) {
        toast('已删除', 'ok');
        await refreshDevices();
      }
      break;
    }
  }
}

// ---------- 备份与还原 ----------
async function openBackupDialog(it) {
  const list = await call(bridge.instances.backups(it.id), '读取备份', true);
  const lines = (list || [])
    .slice(0, 8)
    .map((b, i) => `${i + 1}. ${b.file.replace(/\.img$/, '')}  (${(b.bytes / 1024 / 1024 / 1024).toFixed(2)} GB)`)
    .join('\n');
  const tip =
    `「${it.name}」的备份\n\n` +
    (list && list.length ? `已有备份：\n${lines}\n\n` : '还没有备份。\n\n') +
    '输入序号还原某个备份，直接回车则创建新备份。';

  const ans = window.prompt(tip, '');
  if (ans === null) return;

  const n = parseInt(ans, 10);
  if (Number.isFinite(n) && n >= 1 && list && list[n - 1]) {
    const ok = window.confirm('还原会覆盖当前数据分区，且需要先关闭虚拟机。继续？');
    if (!ok) return;
    const r = await call(bridge.instances.restore(it.id, list[n - 1].file), '还原备份');
    if (r) toast('已还原，重新启动虚拟机生效', 'ok');
    return;
  }

  toast('正在备份数据分区，请稍候…');
  const r = await call(bridge.instances.backup(it.id), '备份');
  if (r) toast(`备份完成（${(r.bytes / 1024 / 1024 / 1024).toFixed(2)} GB）`, 'ok');
}

// ==================== 设备设置弹窗 ====================
let dlgTarget = null;

const RES_PRESETS = [
  ['720x1280', '720 × 1280'],
  ['1080x1920', '1080 × 1920'],
  ['1080x2400', '1080 × 2400'],
  ['1440x2560', '1440 × 2560'],
  ['1440x3200', '1440 × 3200'],
  ['2160x3840', '2160 × 3840'],
];

function fillDevSettings() {
  const c = config || {};
  const gpu = (c.gpu && c.gpu.mode) || 'host';
  $('dsGpu').value = ['host', 'angle_indirect', 'swiftshader_indirect'].includes(gpu) ? gpu : 'host';
  $('dsCores').value = String(c.cores || 4);
  $('dsRam').value = String(c.ram || 4096);

  const res = c.resolution || { width: 1080, height: 2400, density: 420 };
  const key = `${res.width}x${res.height}`;
  $('dsRes').innerHTML = RES_PRESETS.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
  if (!RES_PRESETS.some(([v]) => v === key)) {
    $('dsRes').insertAdjacentHTML('afterbegin', `<option value="${key}">${res.width} × ${res.height}（当前）</option>`);
  }
  $('dsRes').value = key;
  $('dsDpi').value = res.density || 420;

  const au = c.audio || {};
  $('dsAudioOut').checked = au.output !== false;
  $('dsAudioIn').checked = au.input !== false;

  $('dsNet').innerHTML = NET_PRESETS.map(([k, label]) => `<option value="${k}">${label}</option>`).join('');
  $('dsNet').value = (c.network && c.network.profile) || 'wifi';
  $('dsProxy').checked = !!(c.proxy && c.proxy.enabled);

  $('dsModel').innerHTML = DEVICES.map(([k, n]) => `<option value="${k}">${n}</option>`).join('');
  $('dsModel').value = c.deviceKey || 'pixel_7';
  $('dsIdentity').textContent = c.deviceKey || '—';

  $('dsRoot').checked = c.root !== false;
  $('dsWritable').checked = c.writableSystem !== false;
  $('dsHidden').checked = c.window === 'hidden';

  $('dsDisk').value = String(c.diskGB || 6);
  $('dsSnapshot').checked = !!c.snapshot;
  $('dsLogDir').textContent = appInfo && appInfo.vmRoot ? appInfo.vmRoot + '\\logs' : '—';
}

$('dsOpenLog').addEventListener('click', () => {
  call(bridge.vm.openLogDir(), '打开日志目录', true);
});

async function openDevSettings(it) {
  dlgTarget = it;
  if (it.id !== devActiveId) {
    const sw = await call(bridge.instances.setActive(it.id), '切换实例');
    if (!sw) return;
    devActiveId = it.id;
    await loadConfig();
  }
  $('dlgDevName').textContent = `${it.name} · 设备设置`;
  fillDevSettings();
  $('devSettings').style.display = 'flex';
  selectDlgSection('perf');
}

function closeDevSettings() {
  $('devSettings').style.display = 'none';
  dlgTarget = null;
}

function selectDlgSection(sec) {
  document.querySelectorAll('.dlg-nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.sec === sec));
  document.querySelectorAll('.dlg-sec').forEach((s) => s.classList.toggle('active', s.dataset.sec === sec));
  const btn = document.querySelector(`.dlg-nav-btn[data-sec="${sec}"]`);
  $('dlgTitle').textContent = btn ? btn.querySelector('span').textContent : '';
}

$('dlgNav').addEventListener('click', (e) => {
  const b = e.target.closest('.dlg-nav-btn');
  if (b) selectDlgSection(b.dataset.sec);
});
$('btnDevSetClose').addEventListener('click', closeDevSettings);
$('btnDevSetCancel').addEventListener('click', closeDevSettings);
$('devSettings').addEventListener('click', (e) => {
  if (e.target === $('devSettings')) closeDevSettings();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('devSettings').style.display === 'flex') closeDevSettings();
});

$('btnDevSetSave').addEventListener('click', async () => {
  if (!config) return toast('配置还没加载完成', 'err');
  const [w, h] = $('dsRes').value.split('x').map(Number);
  config.gpu = { mode: $('dsGpu').value, renderer: $('dsGpu').value, enabled: true };
  config.cores = Number($('dsCores').value);
  config.ram = Number($('dsRam').value);
  config.resolution = { width: w, height: h, density: Number($('dsDpi').value) || 420 };
  config.audio = { output: $('dsAudioOut').checked, input: $('dsAudioIn').checked, host: true };
  config.network = { ...(config.network || {}), profile: $('dsNet').value };
  config.proxy = { ...(config.proxy || {}), enabled: $('dsProxy').checked };
  config.deviceKey = $('dsModel').value;
  config.root = $('dsRoot').checked;
  config.writableSystem = $('dsWritable').checked;
  config.window = $('dsHidden').checked ? 'hidden' : 'visible';
  config.diskGB = Number($('dsDisk').value);
  config.snapshot = $('dsSnapshot').checked;

  const r = await call(bridge.config.save(config), '保存配置');
  if (r) {
    toast('设置已保存，重启虚拟机后生效', 'ok');
    closeDevSettings();
    await refreshDevices();
  }
});

$('btnRailSettings').addEventListener('click', () => {
  const it = devCache.find((d) => d.id === devActiveId) || devCache[0];
  if (!it) return toast('还没有设备', 'err');
  openDevSettings(it);
});

// ---------- 启动器工具栏 ----------
$('btnNewDevice').addEventListener('click', async () => {
  const r = await call(bridge.instances.create({}), '新建设备');
  if (r) {
    toast('已创建新设备', 'ok');
    await refreshDevices();
  }
});

$('btnBatchOp').addEventListener('click', () => {
  const running = devCache.filter((d) => d.online).length;
  const ans = window.prompt(
    `批量操作\n\n共 ${devCache.length} 台设备，其中 ${running} 台运行中。\n\n输入数字：\n1 = 全部启动\n2 = 全部停止\n3 = 刷新状态`,
    ''
  );
  if (!ans) return;
  if (ans.trim() === '1') batchAll('start');
  else if (ans.trim() === '2') batchAll('stop');
  else refreshDevices();
});

async function batchAll(kind) {
  for (const it of devCache) {
    const st = devStatusOf(it);
    if (kind === 'start' && !st.running) {
      await call(bridge.instances.setActive(it.id), '切换实例', true);
      await call(bridge.vm.start({}), `启动 ${it.name}`, true);
    } else if (kind === 'stop' && st.running) {
      await call(bridge.instances.setActive(it.id), '切换实例', true);
      await call(bridge.vm.stop(), `停止 ${it.name}`, true);
    }
  }
  toast(kind === 'start' ? '已下发启动指令' : '已下发停止指令', 'ok');
  await refreshDevices();
}

$('btnArrange').addEventListener('click', () => {
  toast('窗口排列：设备都在管理器内显示，无需排列');
});

$('btnSortMode').addEventListener('click', () => {
  devSortMode = devSortMode === 'default' ? 'name' : devSortMode === 'name' ? 'status' : 'default';
  const label = { default: '默认顺序', name: '按名称', status: '运行中优先' }[devSortMode];
  toast('排序：' + label);
  renderDeviceGrid();
});

document.querySelectorAll('.vt-btn').forEach((b) => {
  b.addEventListener('click', () => {
    devViewMode = b.dataset.mode;
    document.querySelectorAll('.vt-btn').forEach((x) => x.classList.toggle('active', x === b));
    renderDeviceGrid();
  });
});

$('devSearch').addEventListener('input', (e) => {
  devQuery = e.target.value.trim();
  renderDeviceGrid();
});

// ---------- 初始化 ----------
(async function init() {
  await checkSdk();
  buildPresets();
  await refreshInstances();
  await refreshDevices();
  await loadConfig();
  await refreshCamData();
  await refreshStatus();
  switchView('launcher');
  statusTimer = setInterval(async () => {
    await refreshStatus();
    await refreshInstances();
    await refreshDevices();
  }, 4000);
})();
})();

