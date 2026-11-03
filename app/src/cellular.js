// 移动网络模拟：信号强度、数据连接、语音注册、运营商、制式、漫游
//
// 底层走模拟器控制台（telnet 5554）的 gsm 子命令，这些都是真实生效的：
//   gsm signal <rssi 0-31|none> <ber 0-7|none>
//   gsm signal-profile <0-4>
//   gsm data <unregistered|home|roaming|searching|denied|off|on>
//   gsm voice <unregistered|home|roaming|searching|denied|off|on>
//   gsm meter <unmetered|none|low|high>
// 运营商 / 制式同时写系统属性与 siminfo，供应用读取。
const adbmod = require('./adb');

const DATA_STATES = ['unregistered', 'home', 'roaming', 'searching', 'denied', 'off', 'on'];

async function console(cmds) {
  return adbmod.consoleCmd(cmds).catch((e) => e.message);
}

async function shell(cmd) {
  return adbmod.shell(cmd).catch((e) => e.message);
}

/** 信号强度 0-4 → signal-profile；同时映射到 rssi 供 gsm signal 使用 */
async function setSignal(level) {
  const lv = Math.max(0, Math.min(4, Number(level) || 0));
  const rssiMap = [0, 6, 12, 20, 28]; // 0=无信号, 4=满格
  const berMap = [7, 5, 3, 1, 0];
  const out = await console([`gsm signal-profile ${lv}`]);
  const out2 = await console([`gsm signal ${rssiMap[lv]} ${berMap[lv]}`]);
  await adbmod.rootShell(`setprop gsm.signal.level ${lv}; setprop gsm.signal.strength ${rssiMap[lv]}; true`).catch(
    () => {}
  );
  return { ok: /\bOK\b/.test(out), level: lv, rssi: rssiMap[lv], raw: (out + ' ' + out2).trim() };
}

/** 直接设定 rssi(0-31|none) 与 ber(0-7|none) */
async function setRssi(rssi, ber = 0) {
  const out = await console([`gsm signal ${rssi} ${ber}`]);
  return { ok: /\bOK\b/.test(out), rssi, ber, raw: out.trim() };
}

/** 数据连接状态 */
async function setData(state) {
  const s = String(state || 'home').toLowerCase();
  if (!DATA_STATES.includes(s)) throw new Error(`未知数据状态: ${state}（可选 ${DATA_STATES.join('/')}）`);
  const out = await console([`gsm data ${s}`]);
  return { ok: /\bOK\b/.test(out), state: s, raw: out.trim() };
}

/** 语音注册状态 */
async function setVoice(state) {
  const s = String(state || 'home').toLowerCase();
  if (!DATA_STATES.includes(s)) throw new Error(`未知语音状态: ${state}`);
  const out = await console([`gsm voice ${s}`]);
  return { ok: /\bOK\b/.test(out), state: s, raw: out.trim() };
}

/** 计量属性（影响应用是否把网络当计费网络） */
async function setMeter(meter) {
  const out = await console([`gsm meter ${meter || 'unmetered'}`]);
  return { ok: /\bOK\b/.test(out), meter: meter || 'unmetered', raw: out.trim() };
}

/** 运营商名称（siminfo + 属性 + 控制台刷新） */
async function setOperator(name) {
  const n = String(name || '').trim();
  if (!n) return { ok: false, error: '运营商名称不能为空' };
  const db = '/data/user_de/0/com.android.providers.telephony/databases/telephony.db';
  const esc = n.replace(/'/g, "''");
  const sql = `UPDATE siminfo SET display_name='${esc}', carrier_name='${esc}';`;
  const b64 = Buffer.from(sql + '\n', 'utf8').toString('base64');
  await adbmod
    .rootShell(
      `echo '${b64}' | base64 -d > /data/local/tmp/_o.sql && sqlite3 '${db}' < /data/local/tmp/_o.sql; rm -f /data/local/tmp/_o.sql; true`
    )
    .catch(() => {});
  // 三个运营商相关属性都写一遍（RIL 会周期性覆盖 gsm.operator.alpha，
  // 所以以 siminfo 为权威来源，属性只作辅助）
  await adbmod
    .rootShell(
      `setprop gsm.operator.alpha "${n}"; setprop gsm.sim.operator.alpha "${n}"; ` +
        `setprop gsm.operator.spn "${n}"; true`
    )
    .catch(() => {});
  // 重启电话进程让订阅信息重载
  await adbmod.rootShell('killall com.android.phone 2>/dev/null; true').catch(() => {});
  await new Promise((r) => setTimeout(r, 2000));
  const st = await getStatus();
  return { ok: true, requested: n, actual: st.operator };
}

/** 网络制式（LTE/5G/GSM/...） */
async function setNetworkType(type) {
  const map = { GSM: 'GSM', EDGE: 'EDGE', UMTS: 'UMTS', HSDPA: 'HSDPA', HSPA: 'HSPA', LTE: 'LTE', '5G': 'NR' };
  const target = map[String(type || 'LTE').toUpperCase()] || 'LTE';
  await adbmod
    .rootShell(
      `setprop persist.radio.rat.override ${target}; ` +
        `setprop gsm.network.type ${target}; ` +
        `setprop persist.radio.nr.enabled ${target === 'NR' ? 1 : 0}; true`
    )
    .catch(() => {});
  return { ok: true, requested: target };
}

/** 漫游开关（通过数据/语音注册状态模拟） */
async function setRoaming(on) {
  const r1 = await setData(on ? 'roaming' : 'home');
  const r2 = await setVoice(on ? 'roaming' : 'home');
  await adbmod.rootShell(`settings put global data_roaming ${on ? 1 : 0}`).catch(() => {});
  return { ok: r1.ok || r2.ok, roaming: !!on };
}

/** 综合状态 */
async function getStatus() {
  const gsmStatus = await console(['gsm status']);
  const props = await shell(
    'getprop gsm.operator.alpha; getprop gsm.network.type; getprop gsm.sim.state; ' +
      'getprop gsm.signal.level; getprop gsm.signal.strength; getprop gsm.data.network; ' +
      'getprop persist.radio.rat.override'
  );
  const [operator, networkType, simState, sigLevel, sigStrength, dataNetwork, ratOverride] = props.split('\n');
  const db = '/data/user_de/0/com.android.providers.telephony/databases/telephony.db';
  const subsRaw = await adbmod
    .rootShell(`sqlite3 '${db}' "SELECT _id,number,display_name,icc_id,carrier_name FROM siminfo;" 2>&1`)
    .catch(() => '');
  const subscriptions = subsRaw
    .split('\n')
    .filter((l) => l.includes('|'))
    .map((l) => {
      const [id, number, displayName, iccid, carrier] = l.split('|');
      return { id: Number(id), number, displayName, iccid, carrier };
    });
  const roaming = /roaming/i.test(gsmStatus);
  // 运营商以 siminfo 的 display_name 为权威来源（RIL 会周期性覆盖 gsm.operator.alpha）
  const simOperator = (subscriptions[0] && (subscriptions[0].displayName || subscriptions[0].carrier)) || '';
  return {
    operator: simOperator || (operator || '').trim(),
    operatorProp: (operator || '').trim(),
    networkType: (networkType || '').trim(),
    simState: (simState || '').trim(),
    signalLevel: (sigLevel || '').trim(),
    signalStrength: (sigStrength || '').trim(),
    dataNetwork: (dataNetwork || '').trim(),
    ratOverride: (ratOverride || '').trim(),
    roaming,
    subscriptions,
    console: gsmStatus.trim(),
  };
}

module.exports = {
  setSignal,
  setRssi,
  setData,
  setVoice,
  setMeter,
  setOperator,
  setNetworkType,
  setRoaming,
  getStatus,
  DATA_STATES,
};
