// 蓝牙模拟：开关、适配器名称、配对设备、状态读取
//
// ⚠️ 实测限制（重要）：
//   模拟器的蓝牙底层依赖 netsimd（虚拟 HCI）。本机 netsimd 启动失败：
//     "Netsim daemon failed to start: 拒绝访问。(os error 5)"
//   因此 `cmd bluetooth_manager enable` 会返回 Success，但适配器实际停在 STATE_OFF，
//   `wait-for-state:STATE_ON` 报 Failed with status=-1。
//   没有 netsimd 就没有真实 HCI 通道，蓝牙无法真正开启，也无法扫描/配对真实设备。
//
// 本模块做两件事：
//   1) 真实能力：开关尝试、名称写入、状态读取（如实报告适配器到底有没有起来）
//   2) 可伪装的层面：settings 里的 bluetooth_on / bluetooth_name（部分应用会读）
const adbmod = require('./adb');

async function shell(cmd) {
  return adbmod.shell(cmd).catch((e) => e.message);
}

/** 蓝牙底层是否可用（netsimd 是否正常） */
async function getBackend() {
  const raw = await shell('dumpsys bluetooth_manager 2>/dev/null | head -40');
  const stateM = raw.match(/state:\s*(\w+)/);
  const addrM = raw.match(/address:\s*(\S+)/);
  const nameM = raw.match(/\bname:\s*(.+)/);
  return {
    state: stateM ? stateM[1] : '',
    address: addrM && addrM[1] !== 'null' ? addrM[1] : '',
    name: nameM && nameM[1].trim() !== 'null' ? nameM[1].trim() : '',
  };
}

/**
 * 开关蓝牙。
 *
 * ⚠️ 安全护栏：本机开启蓝牙会让蓝牙协议栈在 StartUp 阶段断言失败并 abort
 * （libbluetooth_jni.so → StackManager::StartUp → __android_log_assert），
 * 进程反复崩溃，严重时会拖垮 system_server（实测导致 wifi/package 服务消失）。
 * 因此默认**拒绝开启**，必须显式传 { force: true } 才执行。
 */
async function setEnabled(on, { force = false } = {}) {
  if (on && !force) {
    return {
      ok: false,
      requested: true,
      blocked: true,
      reason:
        '已阻止：本机开启蓝牙会导致蓝牙协议栈 abort 崩溃（缺少 netsimd HCI 通道），' +
        '并可能拖垮 system_server。确需尝试请传 force=true。',
    };
  }
  const target = on ? 'STATE_ON' : 'STATE_OFF';
  const out = await shell(
    `cmd bluetooth_manager ${on ? 'enable' : 'disable'}; cmd bluetooth_manager wait-for-state:${target} 2>&1 | tail -2`
  );
  await new Promise((r) => setTimeout(r, 1500));
  const b = await getBackend();
  // settings 层同步（部分应用读这个）
  await adbmod.rootShell(`settings put global bluetooth_on ${on ? 1 : 0}`).catch(() => {});
  const reached = b.state === (on ? 'ON' : 'OFF');
  return {
    ok: reached,
    requested: !!on,
    actualState: b.state,
    output: out.trim(),
    note: reached ? '' : '适配器未达目标状态：netsimd 未能启动，蓝牙底层不可用（详见文档）',
  };
}

/** 设置蓝牙显示名称（会重启适配器尝试生效） */
async function setName(name) {
  const n = String(name || '').trim();
  if (!n) return { ok: false, error: '名称不能为空' };
  await adbmod.rootShell(
    `settings put secure bluetooth_name "${n}"; ` +
      `settings put secure bluetooth_address 02:00:00:00:00:00; true`
  ).catch(() => {});
  // 通过关闭再开启触发重新读取名称
  await shell('cmd bluetooth_manager disable');
  await new Promise((r) => setTimeout(r, 1200));
  await shell('cmd bluetooth_manager enable');
  await new Promise((r) => setTimeout(r, 2000));
  const b = await getBackend();
  return { ok: true, requested: n, actualName: b.name, note: b.name ? '' : '适配器未启动，名称仅写入 settings' };
}

/** 配对设备列表（读 dumpsys） */
async function listPaired() {
  const raw = await shell('dumpsys bluetooth_manager 2>/dev/null');
  const out = [];
  // 典型行：Bonded devices: 或 "XX:XX:XX:XX:XX:XX (name)"
  const re = /([0-9A-F]{2}(?::[0-9A-F]{2}){5})\s*\(([^)]*)\)/gi;
  let m;
  while ((m = re.exec(raw))) out.push({ address: m[1], name: m[2] });
  return out;
}

/** 综合状态 */
async function getStatus() {
  const b = await getBackend();
  const on = (await shell('settings get global bluetooth_on')).trim();
  const nameSetting = (await shell('settings get secure bluetooth_name')).trim();
  const paired = await listPaired();
  return {
    state: b.state,
    enabled: b.state === 'ON',
    address: b.address,
    name: b.name || (nameSetting !== 'null' ? nameSetting : ''),
    bluetoothOnSetting: on,
    paired,
    backendReady: b.state === 'ON',
    note:
      b.state === 'ON'
        ? ''
        : '蓝牙适配器处于 OFF：模拟器蓝牙依赖 netsimd，本机 netsimd 启动失败（Access denied）',
  };
}

module.exports = { setEnabled, setName, listPaired, getStatus, getBackend };
