// 多开实例管理：注册表、新建（克隆 AVD）、删除、重命名、切换
//
// 存储结构：
//   _data/instances.json          —— 注册表 { activeId, list: [{id,name,avdName,port,createdAt}] }
//   _data/instances/<id>.json     —— 每个实例的独立配置（原 app/state.json 的内容）
//   avd/<avdName>.avd/            —— AVD 目录
//   avd/<avdName>.ini             —— AVD 定义文件
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { conf, seedAvdConfig } = require('./config');

const DATA_DIR = path.join(conf.vmRoot, '_data');
const INST_DIR = path.join(DATA_DIR, 'instances');
const REGISTRY = path.join(DATA_DIR, 'instances.json');
const LEGACY_STATE = path.join(conf.vmRoot, 'app', 'state.json');

const BASE_PORT = 5554; // 控制台端口，adb 端口 = port + 1

function ensureDirs() {
  fs.mkdirSync(INST_DIR, { recursive: true });
}

function serialOf(port) {
  return 'emulator-' + port;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

/** 首次运行：把旧的单实例 state.json 迁移成 "主实例" */
function migrateIfNeeded() {
  if (fs.existsSync(REGISTRY)) return readJson(REGISTRY);
  ensureDirs();
  const legacy = readJson(LEGACY_STATE) || {};
  const reg = {
    activeId: 'main',
    list: [
      {
        id: 'main',
        name: '主实例',
        avdName: conf.avdName,
        port: conf.consolePort,
        createdAt: new Date().toISOString(),
      },
    ],
  };
  writeJson(path.join(INST_DIR, 'main.json'), legacy);
  writeJson(REGISTRY, reg);
  return reg;
}

function load() {
  const reg = migrateIfNeeded();
  if (!reg || !Array.isArray(reg.list)) {
    return { activeId: 'main', list: [] };
  }
  if (!reg.list.length) return { activeId: null, list: [] };
  if (!reg.list.some((x) => x.id === reg.activeId)) reg.activeId = reg.list[0].id;
  return reg;
}

function save(reg) {
  writeJson(REGISTRY, reg);
  return reg;
}

function stateFile(id) {
  return path.join(INST_DIR, `${id}.json`);
}

function loadState(id) {
  return readJson(stateFile(id)) || {};
}

function saveState(id, cfg) {
  writeJson(stateFile(id), cfg);
}

/** 端口是否被占用（用于分配新实例端口） */
function portInUse(port) {
  return new Promise((resolve) => {
    const sock = net.createConnection(port, '127.0.0.1');
    let done = false;
    const fin = (v) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch {}
      resolve(v);
    };
    sock.on('connect', () => fin(true));
    sock.on('error', () => fin(false));
    sock.setTimeout(600, () => fin(false));
  });
}

/** 分配一个空闲控制台端口（5554 / 5556 / 5558 …） */
async function nextPort(reg) {
  const used = new Set(reg.list.map((x) => Number(x.port)));
  for (let p = BASE_PORT; p < BASE_PORT + 40; p += 2) {
    if (used.has(p)) continue;
    if (await portInUse(p)) continue;
    return p;
  }
  throw new Error('没有可用的控制台端口（已占用过多）');
}

function slugId(base, reg) {
  const used = new Set(reg.list.map((x) => x.id));
  let n = 1;
  let id = base;
  while (used.has(id)) id = `${base}-${++n}`;
  return id;
}

function nextAvdName(reg) {
  const used = new Set(reg.list.map((x) => String(x.avdName)));
  for (let i = 2; i < 60; i++) {
    const name = `${conf.avdName}_${i}`;
    if (!used.has(name) && !fs.existsSync(path.join(conf.avdHome, name + '.avd'))) return name;
  }
  throw new Error('AVD 名称已用尽');
}

/**
 * 新建实例。
 * fromId 指定时复制该实例的配置（机型/镜像/参数），但**不复制 userdata**
 * —— 新实例首次启动是干净系统，避免几 GB 的数据复制。
 */
async function create({ name, fromId } = {}) {
  ensureDirs();
  const reg = load();
  const src = fromId ? reg.list.find((x) => x.id === fromId) : null;
  const srcState = src ? loadState(src.id) : loadState(reg.activeId) || {};

  const id = slugId('inst', reg);
  const avdName = nextAvdName(reg);
  const port = await nextPort(reg);

  // 1) 建 AVD 目录并复制 config.ini
  const avdDir = path.join(conf.avdHome, avdName + '.avd');
  fs.mkdirSync(avdDir, { recursive: true });
  const srcAvdDir = path.join(conf.avdHome, (src ? src.avdName : conf.avdName) + '.avd');
  const srcCfg = path.join(srcAvdDir, 'config.ini');
  const dstCfg = path.join(avdDir, 'config.ini');
  if (fs.existsSync(srcCfg)) {
    fs.copyFileSync(srcCfg, dstCfg);
    // 克隆过来的配置带着源 AVD 的 avd.id / avd.name，必须改成新实例的，
    // 否则模拟器可能认错 AVD
    try {
      let t = fs.readFileSync(dstCfg, 'utf8');
      t = t.replace(/^avd\.id=.*$/m, `avd.id=${avdName}`);
      t = t.replace(/^avd\.name=.*$/m, `avd.name=${avdName}`);
      fs.writeFileSync(dstCfg, t, 'utf8');
    } catch {}
  } else {
    // 全新安装时没有可复制的源配置，用随包模板生成完整 config.ini
    // （只写一行 encoding 是不够的，模拟器缺 abi.type/image.sysdir.1 会 FATAL 退出）
    seedAvdConfig(avdDir);
    try {
      let t = fs.readFileSync(dstCfg, 'utf8');
      t = t.replace(/^avd\.id=.*$/m, `avd.id=${avdName}`);
      t = t.replace(/^avd\.name=.*$/m, `avd.name=${avdName}`);
      fs.writeFileSync(dstCfg, t, 'utf8');
    } catch {}
  }

  // 2) 写 AVD 定义文件（path 必须正确，否则模拟器会回退到 arm 架构直接退出）
  fs.writeFileSync(
    path.join(conf.avdHome, avdName + '.ini'),
    `avd.ini.encoding=UTF-8\npath=${avdDir}\ntarget=android-34\n`,
    'utf8'
  );

  // 3) 写实例配置
  const cfg = {
    ...JSON.parse(JSON.stringify(conf.defaultConfig)),
    ...srcState,
    avdName,
    name: name || `实例 ${reg.list.length + 1}`,
  };
  delete cfg.resolution_keep;
  saveState(id, cfg);

  const inst = {
    id,
    name: name || `实例 ${reg.list.length + 1}`,
    avdName,
    port,
    createdAt: new Date().toISOString(),
    clonedFrom: src ? src.id : null,
  };
  reg.list.push(inst);
  save(reg);
  return inst;
}

/** 删除实例：移除注册表项 + 删除 AVD 目录 + 配置 */
function remove(id) {
  const reg = load();
  const inst = reg.list.find((x) => x.id === id);
  if (!inst) throw new Error('实例不存在: ' + id);
  if (reg.list.length <= 1) throw new Error('至少保留一个实例');

  // 不允许删除正在运行的实例
  // （运行状态由调用方检查，这里只做数据清理）

  reg.list = reg.list.filter((x) => x.id !== id);
  if (reg.activeId === id) reg.activeId = reg.list[0].id;
  save(reg);

  try { fs.rmSync(stateFile(id), { force: true }); } catch {}
  try { fs.rmSync(path.join(conf.avdHome, inst.avdName + '.ini'), { force: true }); } catch {}
  try { fs.rmSync(path.join(conf.avdHome, inst.avdName + '.avd'), { recursive: true, force: true }); } catch {}
  return reg;
}

function rename(id, name) {
  const reg = load();
  const inst = reg.list.find((x) => x.id === id);
  if (!inst) throw new Error('实例不存在: ' + id);
  inst.name = String(name || inst.name);
  save(reg);
  return inst;
}

function setActive(id) {
  const reg = load();
  if (!reg.list.some((x) => x.id === id)) throw new Error('实例不存在: ' + id);
  reg.activeId = id;
  save(reg);
  return reg.list.find((x) => x.id === id);
}

function get(id) {
  return load().list.find((x) => x.id === id) || null;
}

function active() {
  const reg = load();
  return reg.list.find((x) => x.id === reg.activeId) || reg.list[0] || null;
}

/** 列表 + 实时状态（端口是否在监听） */
async function list({ withStatus = true } = {}) {
  const reg = load();
  const out = [];
  for (const inst of reg.list) {
    const item = { ...inst, serial: serialOf(inst.port), active: inst.id === reg.activeId };
    if (withStatus) {
      item.listening = await portInUse(inst.port);
      item.running = item.listening;
    }
    out.push(item);
  }
  return out;
}

module.exports = {
  REGISTRY,
  DATA_DIR,
  INST_DIR,
  load,
  save,
  list,
  get,
  active,
  setActive,
  create,
  remove,
  rename,
  stateFile,
  loadState,
  saveState,
  serialOf,
  portInUse,
};
