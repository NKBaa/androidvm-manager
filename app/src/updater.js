// 应用更新检查（electron-updater + GitHub Releases）
//
// 只有打包版能用：开发模式下 autoUpdater 会直接抛错。
// 更新源在 package.json 的 build.publish 里配置，打包时会生成 resources/app-update.yml。
const { app } = require('electron');

let autoUpdater = null;
let wired = false;
let lastState = { phase: 'idle', message: '', info: null };
let listener = null;

function emit(patch) {
  lastState = { ...lastState, ...patch };
  try {
    if (listener) listener(lastState);
  } catch {}
}

function ensureUpdater() {
  if (autoUpdater) return autoUpdater;
  // 开发模式没有 app-update.yml，也没有签名，直接跳过
  if (!app.isPackaged) return null;
  try {
    autoUpdater = require('electron-updater').autoUpdater;
  } catch (e) {
    console.warn('[updater] electron-updater 加载失败:', e.message);
    return null;
  }
  autoUpdater.autoDownload = false; // 让用户决定下不下
  autoUpdater.autoInstallOnAppQuit = false;

  if (!wired) {
    wired = true;
    autoUpdater.on('checking-for-update', () => emit({ phase: 'checking', message: '正在检查更新…' }));
    autoUpdater.on('update-available', (info) =>
      emit({ phase: 'available', message: `发现新版本 ${info.version}`, info: { version: info.version, notes: info.releaseNotes || '' } })
    );
    autoUpdater.on('update-not-available', (info) =>
      emit({ phase: 'latest', message: '已经是最新版本', info: { version: info && info.version } })
    );
    autoUpdater.on('download-progress', (p) =>
      emit({
        phase: 'downloading',
        message: `下载中 ${(p.percent || 0).toFixed(0)}%`,
        percent: p.percent || 0,
        transferred: p.transferred,
        total: p.total,
      })
    );
    autoUpdater.on('update-downloaded', (info) =>
      emit({ phase: 'downloaded', message: `新版本 ${info.version} 已下载，可以安装`, info: { version: info.version } })
    );
    autoUpdater.on('error', (err) =>
      emit({ phase: 'error', message: String((err && err.message) || err).split('\n')[0] })
    );
  }
  return autoUpdater;
}

function state() {
  return { ...lastState, packaged: app.isPackaged };
}

/** 检查更新。返回最新状态 */
async function check() {
  const u = ensureUpdater();
  if (!u) {
    const s = {
      phase: 'unavailable',
      message: app.isPackaged
        ? '更新组件不可用'
        : '开发模式不检查更新（打包后才有 app-update.yml）',
    };
    emit(s);
    return state();
  }
  try {
    emit({ phase: 'checking', message: '正在检查更新…' });
    await u.checkForUpdates();
  } catch (e) {
    emit({ phase: 'error', message: String(e.message || e).split('\n')[0] });
  }
  return state();
}

async function download() {
  const u = ensureUpdater();
  if (!u) return state();
  try {
    await u.downloadUpdate();
  } catch (e) {
    emit({ phase: 'error', message: String(e.message || e).split('\n')[0] });
  }
  return state();
}

function install() {
  const u = ensureUpdater();
  if (!u) return { ok: false, message: '更新组件不可用' };
  if (lastState.phase !== 'downloaded') return { ok: false, message: '还没有下载完成的更新' };
  // 立即退出并安装；isSilent=false 让用户看到安装界面
  setImmediate(() => {
    try {
      u.quitAndInstall(false, true);
    } catch (e) {
      console.error('[updater] 安装失败:', e.message);
    }
  });
  return { ok: true };
}

function onStatus(cb) {
  listener = cb;
}

module.exports = { check, download, install, state, onStatus };
