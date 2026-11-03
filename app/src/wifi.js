// WiFi 模拟：开关、连接虚拟 AP、保存/遗忘网络、状态读取
//
// 实测环境（google_apis 镜像 + virtio-wifi）：
//   - wlan0 + hwsim0 存在，WiFi 可正常开关
//   - 模拟器自带虚拟 AP，SSID 固定为 "AndroidWifi"（open）
//   - `cmd wifi connect-network AndroidWifi open` 能真连上并拿到 supplicant COMPLETED
//   - 扫描结果为空（没有其它真实 AP），这是模拟器固有限制
const adbmod = require('./adb');

const DEFAULT_AP = 'AndroidWifi';

async function shell(cmd) {
  return adbmod.shell(cmd).catch((e) => e.message);
}

// 注意：connect-network / add-network / forget-network 需要特权 UID，
// 以 shell(2000) 执行会抛 SecurityException（实测），必须用 root 执行。
async function rootShell(cmd) {
  return adbmod.rootShell(cmd).catch((e) => e.message);
}

/** 开关 WiFi */
async function setEnabled(on) {
  const out = await rootShell(`cmd wifi set-wifi-enabled ${on ? 'enabled' : 'disabled'}`);
  await new Promise((r) => setTimeout(r, 3000));
  const st = await getStatus();
  return { ok: st.enabled === !!on, requested: !!on, output: out.trim(), state: st };
}

/**
 * 连接网络。
 * security: open | owe | wpa2 | wpa3 | wep
 *
 * ⚠️ 实测：`cmd wifi connect-network` 在本镜像上会把 wifi 服务打崩
 * （调用后 `cmd wifi status` 立刻变成 "Can't find service: wifi"，
 *  进而拖垮整个网络栈）。因此这里**完全不用 connect-network**。
 *
 * 可靠做法：只操作 WiFi 开关。关闭再开启后，系统会自动连上内置虚拟 AP
 * AndroidWifi（supplicant COMPLETED）。
 * 自定义 SSID 用 addNetwork() 保存进"已保存网络"供应用读取，但连不上（无对应 AP）。
 */
async function connect(ssid, security = 'open', passphrase = '') {
  const s = String(ssid || DEFAULT_AP);
  const sec = String(security || 'open');

  if (s !== DEFAULT_AP) {
    return {
      ok: false,
      method: 'unsupported',
      ssid: s,
      security: sec,
      note:
        '模拟器只有 AndroidWifi 一个真实虚拟 AP。自定义 SSID 请用「保存网络」写入已保存列表；' +
        'connect-network 会打崩 wifi 服务，已禁用。',
    };
  }

  // 先确保是开启状态，再 toggle 一次触发自动关联
  await rootShell('cmd wifi set-wifi-enabled enabled').catch(() => {});
  await new Promise((r) => setTimeout(r, 3000));
  let st = await getStatus();
  if (!st.connected) {
    await rootShell('cmd wifi set-wifi-enabled disabled').catch(() => {});
    await new Promise((r) => setTimeout(r, 5000));
    await rootShell('cmd wifi set-wifi-enabled enabled').catch(() => {});
    // 自动关联需要时间，轮询最多 30 秒
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      st = await getStatus();
      if (st.connected) break;
    }
  }
  return {
    ok: st.connected && st.ssid === s,
    initiated: st.connected,
    method: 'toggle',
    ssid: s,
    security: sec,
    state: st,
  };
}

/**
 * 保存网络（不立即连接）。
 *
 * ⚠️ 实测：`cmd wifi add-network` 在本镜像上会打崩 wifi 服务
 * （返回 "Failure calling service wifi: Broken pipe"，随后 `cmd wifi status` 变空、
 *  已建立的连接也会断开）。因此默认**不执行**，避免把网络栈弄坏。
 * 确需尝试可传 { force: true }。
 */
async function addNetwork(ssid, security = 'open', passphrase = '', { force = false } = {}) {
  const s = String(ssid || '');
  if (!s) return { ok: false, error: 'SSID 不能为空' };
  if (!force) {
    return {
      ok: false,
      blocked: true,
      ssid: s,
      note:
        '已阻止：本镜像上 `cmd wifi add-network` 会打崩 wifi 服务并断开当前连接。' +
        '模拟器只有内置虚拟 AP AndroidWifi，自定义 SSID 无法真正连上。确需尝试请传 force=true。',
    };
  }
  const sec = String(security || 'open');
  const out = await rootShell(
    `cmd wifi add-network "${s}" ${sec}${passphrase ? ` "${passphrase}"` : ''}`
  );
  return { ok: /Save successful|success|already|exists/i.test(out), ssid: s, output: out.trim() };
}

/** 已保存网络列表 */
async function listNetworks() {
  const raw = await shell('cmd wifi list-networks');
  const rows = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || /^Network Id/i.test(t)) continue;
    const m = t.match(/^(\d+)\s+(.+?)\s{2,}(\S+)\s*$/);
    if (m) rows.push({ id: Number(m[1]), ssid: m[2].trim(), security: m[3] });
  }
  return rows;
}

async function forgetNetwork(id, { force = false } = {}) {
  if (!force) {
    return {
      ok: false,
      blocked: true,
      id: Number(id),
      note: '已阻止：`cmd wifi forget-network` 与 add/connect 同类，会打崩 wifi 服务。确需尝试请传 force=true。',
    };
  }
  const out = await rootShell(`cmd wifi forget-network ${Number(id)}`);
  return { ok: /success/i.test(out) || out.trim() === '', id: Number(id), output: out.trim() };
}

async function setScanAlwaysAvailable(on) {
  return rootShell(`cmd wifi set-scan-always-available ${on ? 'enabled' : 'disabled'}`);
}

/** 扫描结果（模拟器通常为空） */
async function listScanResults() {
  const raw = await shell('cmd wifi list-scan-results');
  if (/No scan results/i.test(raw)) return [];
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = l.match(/SSID:\s*"?([^",]*)"?.*?BSSID:\s*([0-9a-f:]{17}).*?RSSI:\s*(-?\d+)/i);
      return m ? { ssid: m[1], bssid: m[2], rssi: Number(m[3]) } : { raw: l };
    });
}

/** 当前 WiFi 状态（解析 cmd wifi status） */
async function getStatus() {
  // wifi 服务偶发无响应（返回空），重试几次
  let raw = '';
  for (let i = 0; i < 3 && !raw; i++) {
    raw = await shell('cmd wifi status');
    if (!raw || !/Wifi is/i.test(raw)) {
      raw = '';
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  const enabled = /Wifi is enabled/i.test(raw);
  const connected = /Wifi is connected to/i.test(raw);
  const ssidM = raw.match(/Wifi is connected to "([^"]+)"/);
  const info = raw.match(/WifiInfo:\s*(.+)/);
  const line = info ? info[1] : '';
  const pick = (re) => {
    const m = line.match(re);
    return m ? m[1].trim() : '';
  };
  const ip = await shell('ip -4 addr show wlan0 2>/dev/null').catch(() => '');
  const ipM = ip.match(/inet (\d+\.\d+\.\d+\.\d+)/);
  return {
    enabled,
    connected,
    ssid: ssidM ? ssidM[1] : '',
    bssid: pick(/BSSID:\s*([0-9a-f:]{17})/i),
    mac: pick(/MAC:\s*([0-9a-f:]{17})/i),
    rssi: pick(/RSSI:\s*(-?\d+)/),
    linkSpeed: pick(/Link speed:\s*([0-9A-Za-z.]+)/),
    frequency: pick(/Frequency:\s*(\d+)/),
    security: pick(/Security type:\s*(\d+)/),
    supplicantState: pick(/Supplicant state:\s*([A-Z_]+)/),
    ip: ipM ? ipM[1] : '',
    raw: raw.trim(),
  };
}

module.exports = {
  DEFAULT_AP,
  setEnabled,
  connect,
  addNetwork,
  listNetworks,
  forgetNetwork,
  setScanAlwaysAvailable,
  listScanResults,
  getStatus,
};
