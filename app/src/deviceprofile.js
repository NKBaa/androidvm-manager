// 真机档案（Device Profile）：从官方真机数据库生成完整属性集，并写入模拟器
//
// 原理（已实测验证）：
//   1. 用 -writable-system 启动 → adb root → adb remount
//      remount 会 disable-verity 并对 /system /product /system_ext /vendor 启用 overlayfs
//   2. 改写各分区的 build.prop 中 ro.product.<分区>.* 与 ro.build.*
//   3. 重启后 ro.product.model / device / brand / name 及 ro.build.fingerprint 全部改变
//   4. overlayfs 数据落在 /data，随 userdata 持久化（跨模拟器重启保留）
//
// 前提：镜像必须是 userdebug/user 可 root（ATD 镜像 ro.debuggable=1）。
//       Play 商店镜像是 user 版本（ro.debuggable=0），adb root 会失败，需先换镜像。

const fs = require('node:fs');
const path = require('node:path');
const adbmod = require('./adb');
const { conf } = require('./config');

const DATA_DIR = path.join(conf.vmRoot, '_data');
const CSV_FILE = path.join(DATA_DIR, 'supported_devices.csv');
const PROFILE_DIR = path.join(DATA_DIR, 'profiles');
const STATE_FILE = path.join(DATA_DIR, 'active-profile.json');

// ---------- 真机数据库 ----------

let dbCache = null;

/** 解析 Google Play 官方设备清单（UTF-16LE CSV，约 5.4 万台真机） */
function loadDatabase() {
  if (dbCache) return dbCache;
  if (!fs.existsSync(CSV_FILE)) {
    throw new Error(`真机数据库缺失: ${CSV_FILE}（可用 tools/fetch_devices 下载）`);
  }
  // 官方清单是 UTF-16LE，必须显式解码，否则字段里会混入 \0 导致搜索失效
  const buf = fs.readFileSync(CSV_FILE);
  const isUtf16 = buf.length > 2 && (buf[0] === 0xff || (buf[1] === 0x00 && buf[0] !== 0x00));
  let txt = buf.toString(isUtf16 ? 'utf16le' : 'utf8');
  if (txt.charCodeAt(0) === 0xfeff) txt = txt.slice(1);
  txt = txt.replace(/\u0000/g, '');

  const rows = [];
  const lines = txt.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    // CSV 字段可能带引号
    const parts = [];
    let cur = '';
    let q = false;
    for (const ch of line) {
      if (ch === '"') { q = !q; continue; }
      if (ch === ',' && !q) { parts.push(cur); cur = ''; continue; }
      cur += ch;
    }
    parts.push(cur);
    if (parts.length < 4) continue;
    const [brandRaw, marketing, device, model] = parts;
    if (!device) continue;
    rows.push({
      brand: (brandRaw || '').trim(),
      marketing: (marketing || '').trim(),
      device: device.trim(),
      model: model.trim(),
    });
  }
  dbCache = rows;
  return rows;
}

/** 按关键词搜索真机（品牌 / 型号 / 代号） */
function searchDevices(keyword, limit = 20) {
  const rows = loadDatabase();
  const kw = String(keyword || '').toLowerCase().trim();
  if (!kw) return rows.slice(0, limit);
  const terms = kw.split(/\s+/);
  const out = [];
  for (const r of rows) {
    const hay = `${r.brand} ${r.marketing} ${r.device} ${r.model}`.toLowerCase();
    if (terms.every((t) => hay.includes(t))) {
      out.push(r);
      if (out.length >= limit) break;
    }
  }
  return out;
}

function dbStats() {
  const rows = loadDatabase();
  const brands = new Set(rows.map((r) => r.brand).filter(Boolean));
  return { devices: rows.length, brands: brands.size, file: CSV_FILE };
}

// ---------- 档案（Profile） ----------

/** 把品牌名规范成 Android 属性风格（小写、去空格） */
function normBrand(brand) {
  return String(brand || '').toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9_]/g, '');
}

/**
 * 从数据库记录生成一份档案。
 * 数据库只提供 brand/model/device（这是 Play 商店分发判断用的核心字段）；
 * build.id / incremental / security_patch 等真实构建信息数据库里没有，
 * 必须由真实构建来源提供（见 profiles/ 目录），否则指纹不完整。
 */
function profileFromDevice(rec, overrides = {}) {
  const brand = normBrand(rec.brand || overrides.manufacturer || 'unknown');
  const device = rec.device || 'unknown';
  const model = rec.model || rec.marketing || device;
  const manufacturer = overrides.manufacturer || rec.brand || 'unknown';
  return {
    brand,
    device,
    model,
    name: rec.device || device,
    product: rec.device || device,
    manufacturer,
    marketing: rec.marketing || model,
    // 构建信息：默认留空表示"沿用模拟器当前值"
    buildId: '',
    incremental: '',
    release: '',
    sdk: '',
    type: '',
    tags: '',
    securityPatch: '',
    firstApiLevel: '',
    ...overrides,
  };
}

function listProfiles() {
  if (!fs.existsSync(PROFILE_DIR)) return [];
  return fs
    .readdirSync(PROFILE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(PROFILE_DIR, f), 'utf8'));
        return { file: f, ...p };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function loadProfile(nameOrFile) {
  const f = nameOrFile.endsWith('.json') ? nameOrFile : `${nameOrFile}.json`;
  const p = path.join(PROFILE_DIR, f);
  if (!fs.existsSync(p)) throw new Error(`档案不存在: ${f}`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function getActiveProfile() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

// ---------- 应用 / 还原 ----------

/** 分区 → build.prop 路径 */
const PROP_FILES = {
  product: '/product/etc/build.prop',
  system_ext: '/system_ext/etc/build.prop',
  vendor: '/vendor/build.prop',
};

// ABI 相关文件（ODM 优先级最高，是实际生效源；system/vendor 一起改保持一致）
const ABI_FILES = ['/odm/etc/build.prop', '/system/build.prop', '/vendor/build.prop'];

/** 当前模拟器是否可 root（决定能否改写属性） */
async function canSpoof() {
  const debuggable = (await adbmod.shell('getprop ro.debuggable').catch(() => '')).trim();
  const uid0 = (await adbmod.shell('id -u').catch(() => '')).trim() === '0';
  return { debuggable: debuggable === '1', uid0, ok: uid0 || debuggable === '1' };
}

/** 确保 root + overlayfs 可写；返回是否就绪 */
async function ensureWritableSystem() {
  await adbmod.adb(['root'], { allowFail: true, timeout: 15000 });
  await new Promise((r) => setTimeout(r, 2500));
  const uid = (await adbmod.shell('id -u').catch(() => '')).trim();
  if (uid !== '0') {
    return { ok: false, reason: 'adb root 失败（镜像可能是 user 版本，ro.debuggable=0）' };
  }
  const rm = await adbmod.adb(['remount'], { allowFail: true, timeout: 60000 });
  const out = (rm.stdout + rm.stderr).toLowerCase();
  const needsReboot = /reboot your device|verity disabled; overlayfs enabled/.test(out);
  // 探测是否真的可写
  const probe = await adbmod.shell(
    'touch /system/.wtest 2>&1 && rm -f /system/.wtest && echo WRITABLE || echo READONLY'
  ).catch(() => '');
  return {
    ok: probe.includes('WRITABLE'),
    needsReboot,
    remountOutput: (rm.stdout + rm.stderr).trim(),
    reason: probe.includes('WRITABLE') ? '' : 'system 仍为只读，需要先重启一次让 overlayfs 生效',
  };
}

/** 生成要写入的 key=value 列表（按分区） */
function buildPropEntries(profile, partition) {
  const p = partition;
  const e = [];
  const push = (k, v) => {
    if (v !== undefined && v !== null && String(v) !== '') e.push([k, String(v)]);
  };
  push(`ro.product.${p}.brand`, profile.brand);
  push(`ro.product.${p}.device`, profile.device);
  push(`ro.product.${p}.manufacturer`, profile.manufacturer);
  push(`ro.product.${p}.model`, profile.model);
  push(`ro.product.${p}.name`, profile.name);
  // CPU ABI：让设备"自称" ARM64（软件层伪装，非真指令集模拟）
  const cpu = profile.cpu;
  if (cpu && (cpu.abilist || cpu.abi)) {
    push(`ro.${p}.product.cpu.abilist`, cpu.abilist);
    push(`ro.${p}.product.cpu.abilist64`, cpu.abilist64);
    push(`ro.${p}.product.cpu.abilist32`, cpu.abilist32);
  }
  return e;
}

/**
 * 全局 ABI 属性。
 * 注意：`ro.product.cpu.abi` 决定 Build.CPU_ABI，系统库/zygote 按它加载；
 * 把它改成 arm64-v8a 会让系统库加载失败 → 引导 4 分钟 + package 服务挂掉（实测）。
 * 因此这里**只改 abilist 顺序**（让 Build.SUPPORTED_ABIS[0] 变 arm64-v8a），
 * abi 保持 x86_64，系统照常运行。
 */
function buildCpuEntries(profile) {
  const cpu = profile.cpu;
  if (!cpu || !cpu.abilist) return [];
  const e = [];
  const push = (k, v) => {
    if (v !== undefined && v !== null) e.push([k, String(v)]);
  };
  push('ro.product.cpu.abilist', cpu.abilist);
  push('ro.product.cpu.abilist64', cpu.abilist64);
  push('ro.product.cpu.abilist32', cpu.abilist32);
  return e;
}

/** 在设备上把 key=value 写入某个 build.prop（就地替换，不存在则追加） */
async function writeProps(propFile, entries) {
  const script = entries
    .map(([k, v]) => {
      const val = String(v).replace(/([\\|&$'"`])/g, '\\$1');
      // 有该键则整行替换，否则追加
      return `if grep -q "^${k}=" ${propFile} 2>/dev/null; then sed -i "s|^${k}=.*|${k}=${val}|" ${propFile}; else echo "${k}=${val}" >> ${propFile}; fi`;
    })
    .join('\n');
  const out = await adbmod.shell(`sh -c '${script.replace(/'/g, "'\\''")}'`).catch((e) => e.message);
  return out;
}

// ---------- 档案 → 属性行（applyProfile 与 reapplyIfNeeded 共用） ----------

/** ro.build.* 等全局字段 */
function buildSystemEntries(profile) {
  const e = [];
  if (profile.buildId) e.push(['ro.build.id', profile.buildId]);
  if (profile.incremental) e.push(['ro.build.version.incremental', profile.incremental]);
  if (profile.release) {
    e.push(['ro.build.version.release', profile.release]);
    e.push(['ro.build.version.release_or_codename', profile.release]);
  }
  if (profile.sdk) e.push(['ro.build.version.sdk', profile.sdk]);
  if (profile.type) e.push(['ro.build.type', profile.type]);
  if (profile.tags) e.push(['ro.build.tags', profile.tags]);
  if (profile.securityPatch) e.push(['ro.build.version.security_patch', profile.securityPatch]);
  if (profile.firstApiLevel) e.push(['ro.product.first_api_level', profile.firstApiLevel]);
  return e;
}

/**
 * CPU ABI 写入项。
 * 生效源是 ODM（优先级最高）：/odm/etc/build.prop 的 ro.odm.product.cpu.abilist。
 * 只改 system/vendor 不生效（实测）。ro.product.cpu.abi 必须保持 x86_64，否则系统崩。
 */
function buildCpuWrites(profile) {
  const cpu = profile.cpu;
  if (!cpu || !cpu.abilist) return null;
  const mk = (prefix) =>
    [
      [`${prefix}.abilist`, cpu.abilist],
      [`${prefix}.abilist64`, cpu.abilist64],
      [`${prefix}.abilist32`, cpu.abilist32],
    ].filter(([, v]) => v !== undefined && v !== null);
  return {
    odm: mk('ro.odm.product.cpu'),
    system: [...mk('ro.system.product.cpu'), ...buildCpuEntries(profile)],
    vendor: mk('ro.vendor.product.cpu'),
  };
}

/** 硬件标识（board / platform）；ro.hardware 不能改 */
function buildHardwareEntries(profile) {
  const e = [];
  if (profile.board) e.push(['ro.product.board', profile.board]);
  if (profile.boardPlatform) e.push(['ro.board.platform', profile.boardPlatform]);
  return e;
}

/** 把一份档案的全部属性写入设备（调用前需确保 system 可写） */
async function writeAllProps(profile) {
  const written = {};
  for (const [part, file] of Object.entries(PROP_FILES)) {
    const entries = buildPropEntries(profile, part);
    if (!entries.length) continue;
    await writeProps(file, entries);
    written[part] = entries.length;
  }
  const sysEntries = buildSystemEntries(profile);
  if (sysEntries.length) {
    await writeProps('/system/build.prop', sysEntries);
    written.system = sysEntries.length;
  }
  const cpuWrites = buildCpuWrites(profile);
  if (cpuWrites) {
    await writeProps('/odm/etc/build.prop', cpuWrites.odm);
    await writeProps('/system/build.prop', cpuWrites.system);
    await writeProps('/vendor/build.prop', cpuWrites.vendor);
    written.abi = cpuWrites.odm.length;
  }
  const hwEntries = buildHardwareEntries(profile);
  if (hwEntries.length) {
    await writeProps('/vendor/build.prop', hwEntries);
    written.hardware = hwEntries.length;
  }
  return written;
}

/**
 * 应用档案（需要已 root + 可写 system）。
 * 首次 remount 只会 disable-verity 并启用 overlayfs，必须重启一次才真正可写；
 * 这里自动完成"remount → 重启 → 再 remount → 写入 → 重启"的完整流程。
 */
async function applyProfile(profile, { reboot = true, maxPhaseRetry = 2 } = {}) {
  const cpu = profile.cpu;
  if (cpu && String(cpu.abi || '').includes('arm')) {
    return {
      ok: false,
      reason:
        '不能把 ro.product.cpu.abi 设为 ARM：系统库按它加载，会导致引导失败、package 服务崩溃。只改 abilist 顺序即可。',
    };
  }

  let ready = await ensureWritableSystem();

  // 两阶段：第一次 remount 后需要重启，重启回来再 remount 才可写
  for (let attempt = 0; !ready.ok && ready.needsReboot && attempt < maxPhaseRetry; attempt++) {
    await adbmod.adb(['reboot'], { allowFail: true, timeout: 15000 });
    const booted = await adbmod.waitForBoot(240000);
    if (!booted) return { ok: false, reason: '重启后未能完成引导，无法继续写入' };
    await new Promise((r) => setTimeout(r, 3000));
    ready = await ensureWritableSystem();
  }

  if (!ready.ok) {
    return { ok: false, ...ready, hint: '请用 -writable-system 启动且镜像需 userdebug' };
  }

  const written = await writeAllProps(profile);

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ ...profile, appliedAt: new Date().toISOString() }, null, 2), 'utf8');

  if (reboot) {
    await adbmod.adb(['reboot'], { allowFail: true, timeout: 15000 });
  }
  return { ok: true, written, rebooted: reboot };
}

/** 读取当前生效的真机身份 */
async function readIdentity() {
  const raw = await adbmod
    .shell(
      'echo "brand=$(getprop ro.product.brand)"; echo "device=$(getprop ro.product.device)"; ' +
        'echo "model=$(getprop ro.product.model)"; echo "name=$(getprop ro.product.name)"; ' +
        'echo "manufacturer=$(getprop ro.product.manufacturer)"; echo "fingerprint=$(getprop ro.build.fingerprint)"; ' +
        'echo "buildId=$(getprop ro.build.id)"; echo "release=$(getprop ro.build.version.release)"; ' +
        'echo "type=$(getprop ro.build.type)"; echo "tags=$(getprop ro.build.tags)"; ' +
        'echo "patch=$(getprop ro.build.version.security_patch)"'
    )
    .catch(() => '');
  const out = {};
  for (const line of raw.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/**
 * 还原为镜像原始身份。
 * remount 后 /system 等是 overlayfs，改过的文件副本存在
 * /mnt/scratch/overlay/<分区>/upper 下；删掉这些副本，重启即回到镜像原值。
 * （比"备份还原"更可靠：备份可能是在已改写状态下创建的）
 */
async function revertProfile({ reboot = true } = {}) {
  const ready = await ensureWritableSystem();
  if (!ready.ok) return { ok: false, ...ready };

  const parts = ['system', 'product', 'system_ext', 'vendor', 'system_dlkm', 'odm'];
  const targets = [
    'etc/build.prop',
    'build.prop',
  ];
  const rm = [];
  for (const p of parts) {
    for (const t of targets) {
      rm.push(`rm -f /mnt/scratch/overlay/${p}/upper/${t}`);
    }
  }
  const out = await adbmod.shell(`sh -c '${rm.join('; ')}'`).catch(() => '');
  try { fs.rmSync(STATE_FILE, { force: true }); } catch {}
  if (reboot) await adbmod.adb(['reboot'], { allowFail: true, timeout: 15000 });
  return { ok: true, removed: rm.length, note: out.trim() };
}

/** 备份当前 build.prop（首次改写前调用，供还原使用） */
async function backupProps() {
  const files = new Set([...Object.values(PROP_FILES), ...ABI_FILES]);
  const script = [...files]
    .map((f) => `[ -f ${f} ] && [ ! -f ${f}.bak ] && cp ${f} ${f}.bak`)
    .join('; ');
  return adbmod.shell(script).catch(() => '');
}

/**
 * 启动后自动补应用档案。
 * 背景：overlayfs 的改动**不跨模拟器进程重启**（同一会话内 adb reboot 能保留），
 * 所以每次冷启动后都要检查身份，不匹配就重新写入。
 * 该函数内部会自行处理"remount 需先重启"的两阶段，最多重启 maxReboot 次。
 *
 * ⚠️ 超时要给足：应用 ARM ABI 伪装后，系统引导会从 ~60 秒涨到
 * 200~470 秒（实测 204s / 271s / 326s / 476s）。等待上限太小会导致
 * "超时 → 再重启 → 更慢 → 放弃"的恶性循环，最后模拟器被拖死。
 */
const REAPPLY_BOOT_TIMEOUT = 600000; // 10 分钟

async function reapplyIfNeeded({ maxReboot = 2 } = {}) {
  const active = getActiveProfile();
  if (!active || !active.model) return { ok: true, skipped: true, reason: '没有激活的档案' };

  const wantAbi = active.cpu && active.cpu.abilist ? String(active.cpu.abilist).split(',')[0] : '';

  for (let i = 0; i <= maxReboot; i++) {
    const id = await readIdentity().catch(() => ({}));
    if (!id || !id.model) return { ok: false, reason: '设备未就绪' };

    const sameModel = String(id.model) === String(active.model);
    const sameAbi = !wantAbi || String(id.abilist || '').startsWith(wantAbi);
    if (sameModel && sameAbi) {
      return { ok: true, already: true, identity: id, reboots: i };
    }

    const ready = await ensureWritableSystem();
    if (ready.ok) {
      const written = await writeAllProps(active);
      await adbmod.adb(['reboot'], { allowFail: true, timeout: 15000 });
      await adbmod.waitForBoot(REAPPLY_BOOT_TIMEOUT);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    if (ready.needsReboot) {
      await adbmod.adb(['reboot'], { allowFail: true, timeout: 15000 });
      await adbmod.waitForBoot(REAPPLY_BOOT_TIMEOUT);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    return { ok: false, ...ready };
  }
  return { ok: false, reason: `尝试 ${maxReboot + 1} 轮后仍未能应用档案` };
}

module.exports = {
  loadDatabase,
  searchDevices,
  dbStats,
  profileFromDevice,
  listProfiles,
  loadProfile,
  getActiveProfile,
  canSpoof,
  ensureWritableSystem,
  applyProfile,
  reapplyIfNeeded,
  readIdentity,
  revertProfile,
  backupProps,
  PROP_FILES,
};
