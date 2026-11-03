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
  $('camBack').value = cam.back || 'virtualscene';
  $('camFront').value = cam.front || 'emulated';
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

$('btnCamApply').addEventListener('click', async () => {
  const r = await call(bridge.dev.camera({ back: $('camBack').value, front: $('camFront').value }), '应用摄像头设置');
  $('camOut').textContent = JSON.stringify(r || '', null, 2) + '\n（重启虚拟机后生效）';
  config.camera = { back: $('camBack').value, front: $('camFront').value };
  await call(bridge.config.save(config), '保存', true);
});
$('btnCamStatus').addEventListener('click', async () => {
  const r = await call(bridge.dev.cameraStatus(), '读取摄像头', true);
  $('camOut').textContent = JSON.stringify(r || '', null, 2);
  if (r) { $('camBack').value = r.back || 'virtualscene'; $('camFront').value = r.front || 'emulated'; }
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
async function checkSdk() {
  const info = await call(bridge.info(), '读取信息', true);
  if (!info) return;
  const st = await call(bridge.sdk.check(), '检查 SDK', true);
  const ready = st ? st.ready : info.sdkReady;
  if (ready) return;
  const b = $('sdkBanner');
  if (!b) return;
  b.style.display = 'flex';
  $('sdkMsg').innerHTML =
    `未找到 Android SDK（当前解析路径：<code>${escapeHtml(info.sdkRoot || '')}</code>）` +
    ` —— 可在线下载，或选择已有的 SDK 目录`;
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
    $('sdkPhase').textContent = `${d.file}  ${fmtMB(d.received)} / ${fmtMB(d.total)}`;
    const pct = d.overallPercent || 0;
    $('sdkBar').style.width = pct.toFixed(1) + '%';
    $('sdkPct').textContent = pct.toFixed(0) + '%';
    return;
  }
  if (phase === 'resolve') { $('sdkPhase').textContent = d.message || '解析组件清单…'; return; }
  if (phase === 'resolved') {
    const n = (d.packages || []).length;
    $('sdkPhase').textContent = `共 ${n} 个组件，合计 ${fmtMB(d.totalBytes || 0)}`;
    return;
  }
  if (phase === 'download-start') { $('sdkPhase').textContent = '开始下载 ' + d.file; return; }
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
  const ok = window.confirm(
    '将从 Google 官方源下载 Android SDK：\n\n' +
      '  • emulator            约 439 MB\n' +
      '  • platform-tools      约 8 MB\n' +
      '  • Android 14 系统镜像  约 1491 MB\n\n' +
      '合计约 1.9 GB，解压后约 5.4 GB。\n确定开始下载？'
  );
  if (!ok) return;
  showSdkProgress(true);
  $('sdkPhase').textContent = '准备中…';
  if (!sdkUnsub) sdkUnsub = bridge.sdk.onProgress(onSdkProgress);
  const r = await call(bridge.sdk.download({}), '开始下载', true);
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

// ---------- 初始化 ----------
(async function init() {
  await checkSdk();
  buildPresets();
  await refreshInstances();
  await loadConfig();
  await refreshStatus();
  statusTimer = setInterval(async () => {
    await refreshStatus();
    await refreshInstances();
  }, 4000);
})();
})();

