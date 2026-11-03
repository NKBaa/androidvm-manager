// 网络模拟：上下行带宽、延迟、丢包、制式、离线
const adbmod = require('./adb');

const SPEED_KBPS = {
  gsm: 14.4, gprs: 40, hscsd: 43.2, edge: 400, umts: 384, hsdpa: 14400, 'full': 0,
};

async function setRadio(technology) {
  // 模拟器控制台不支持 radio 命令；改用 RIL 覆盖属性 + 蜂窝数据模式切换，
  // 让 SystemUI 图标与应用感知到目标制式。
  const t = String(technology || 'LTE').toUpperCase();
  const map = {
    GSM: 'GSM', EDGE: 'EDGE', UMTS: 'UMTS', HSDPA: 'HSDPA', HSPA: 'HSPA',
    LTE: 'LTE', '5G': 'NR',
  };
  const target = map[t] || 'LTE';
  const out = await adbmod.rootShell(
    `setprop persist.radio.rat.override ${target}; ` +
    `setprop gsm.network.type ${target}; ` +
    `setprop persist.radio.nr.enabled ${target === 'NR' ? 1 : 0}; true`
  ).catch(() => '');
  return out || `制式已设为 ${target}`;
}

async function setSpeed(speed, downloadKbps, uploadKbps) {
  let out = '';
  if (downloadKbps || uploadKbps) {
    // 自定义带宽：控制台只支持预设值，自定义走 netem 式限速需要 root + tc
    const down = Math.max(1, Math.round((downloadKbps || 1024) / 8));
    const up = Math.max(1, Math.round((uploadKbps || 512) / 8));
    out += await adbmod.rootShell(
      `tc qdisc del dev eth0 root 2>/dev/null; ` +
      `tc qdisc add dev eth0 root handle 1: tbf rate ${down}kbit burst 32kbit latency 400ms && ` +
      `tc qdisc add dev eth0 parent 1: handle 2: netem rate ${down}kbit limit 1000`
    );
    return out;
  }
  const s = SPEED_KBPS[speed] !== undefined ? speed : 'full';
  out += await adbmod.consoleCmd([`network speed ${s}`]);
  // 同时清掉 tc 限制
  await adbmod.rootShell('tc qdisc del dev eth0 root 2>/dev/null');
  return out;
}

async function setDelay(delayMs) {
  if (!delayMs) return adbmod.consoleCmd(['network delay none']);
  // 自定义延迟走 tc netem
  const out = await adbmod.rootShell(
    `tc qdisc del dev eth0 root 2>/dev/null; tc qdisc add dev eth0 root netem delay ${delayMs}ms`
  );
  return out;
}

async function setPacketLoss(percent) {
  if (!percent) return '';
  return adbmod.rootShell(
    `tc qdisc del dev eth0 root 2>/dev/null; tc qdisc add dev eth0 root netem loss ${percent}%`
  );
}

async function setOffline(offline) {
  if (offline) {
    await adbmod.rootShell('svc wifi disable; svc data disable');
    const out = await adbmod.consoleCmd(['network speed gsm']);
    await adbmod.rootShell('iptables -I OUTPUT -j DROP 2>/dev/null; iptables -I INPUT -j DROP 2>/dev/null');
    return out;
  }
  await adbmod.rootShell('iptables -D OUTPUT -j DROP 2>/dev/null; iptables -D INPUT -j DROP 2>/dev/null; true');
  await adbmod.rootShell('svc wifi enable; svc data enable');
  return adbmod.consoleCmd(['network speed full']);
}

async function setNetwork(net) {
  const cfg = net || {};
  const results = {};
  if (cfg.offline) {
    results.offline = await setOffline(true);
    return results;
  }
  await setOffline(false).catch(() => {});
  results.speed = await setSpeed(cfg.profile || 'wifi', cfg.downloadKbps, cfg.uploadKbps).catch((e) => e.message);
  results.delay = await setDelay(cfg.latencyMs).catch((e) => e.message);
  results.loss = await setPacketLoss(cfg.packetLoss).catch((e) => e.message);
  if (cfg.radioType) results.radio = await setRadio(cfg.radioType).catch((e) => e.message);
  return results;
}

async function getNetworkStatus() {
  const console1 = await adbmod.consoleCmd(['network status']);
  const ui = await adbmod.shell('dumpsys connectivity | grep -m3 -E "NetworkAgentInfo|Active default"').catch(() => '');
  const radio = await adbmod.shell('getprop gsm.network.type; getprop gsm.operator.alpha').catch(() => '');
  const [netType, operator] = radio.split('\n');
  return { console: console1, connectivity: ui, networkType: netType, operator };
}

async function testConnectivity() {
  const ping = await adbmod.shell('ping -c 3 -W 2 8.8.8.8 2>&1 | tail -3').catch((e) => e.message);
  const dns = await adbmod.shell('ping -c 1 -W 2 google.com 2>&1 | head -2').catch((e) => e.message);
  return { ping, dns };
}

module.exports = { setNetwork, setOffline, setSpeed, setDelay, setPacketLoss, setRadio, getNetworkStatus, testConnectivity };
