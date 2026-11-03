// 界面多语言
//
// 用法：
//   1) HTML 里给静态文案加 data-i18n="key"（占位符用 data-i18n-ph，title 用 data-i18n-title）
//   2) JS 里动态文案用 t('key') 或 t('key', { n: 3 })
//   3) 切换语言后调用 applyI18n() 重新套用
//
// 目前覆盖：图标栏、启动器工具栏、设备卡片、卡片右键菜单、各对话框骨架、状态栏。
// 工作区里的深度技术面板（网络/代理/电话/硬件/终端）仍是中文。
(() => {
  const DICT = {
    'zh-CN': {
      'rail.devices': '设备',
      'rail.run': '运行',
      'rail.update': '更新',
      'rail.settings': '设置',
      'rail.lang': '语言',

      'launcher.new': '＋ 新建设备',
      'launcher.batch': '批量操作',
      'launcher.arrange': '排列窗口',
      'launcher.search': '搜索设备',
      'launcher.grid': '网格视图',
      'launcher.list': '列表视图',
      'launcher.sort': '切换排序',

      'status.off': '未开机',
      'status.booting': '启动中',
      'status.on': '运行中',
      'card.cores': '核',
      'card.empty': '还没有设备，点左上角「＋ 新建设备」创建',
      'card.noMatch': '没有匹配的设备',

      'ctx.settings': '设备设置',
      'ctx.clean': '磁盘清理',
      'ctx.rename': '重命名',
      'ctx.clone': '复制',
      'ctx.backup': '备份与还原',
      'ctx.shortcut': '创建桌面快捷方式',
      'ctx.delete': '删除',

      'dlg.ok': '确定',
      'dlg.cancel': '取消',
      'dlg.close': '关闭',
      'dlg.renameTitle': '重命名设备',
      'dlg.renameDesc': '只影响管理器里的显示名称，不会改动虚拟机内部。',
      'dlg.backupTitle': '备份与还原',
      'dlg.batchTitle': '批量操作',
      'dlg.arrangeTitle': '排列窗口',
      'dlg.updateTitle': '检查更新',

      'sb.notStarted': '未启动',
    },
    'en-US': {
      'rail.devices': 'Devices',
      'rail.run': 'Running',
      'rail.update': 'Update',
      'rail.settings': 'Settings',
      'rail.lang': 'Language',

      'launcher.new': '+ New device',
      'launcher.batch': 'Batch',
      'launcher.arrange': 'Arrange',
      'launcher.search': 'Search devices',
      'launcher.grid': 'Grid view',
      'launcher.list': 'List view',
      'launcher.sort': 'Sort',

      'status.off': 'Stopped',
      'status.booting': 'Starting',
      'status.on': 'Running',
      'card.cores': 'cores',
      'card.empty': 'No devices yet — click "+ New device" to create one',
      'card.noMatch': 'No matching devices',

      'ctx.settings': 'Device settings',
      'ctx.clean': 'Clean disk',
      'ctx.rename': 'Rename',
      'ctx.clone': 'Duplicate',
      'ctx.backup': 'Backup & restore',
      'ctx.shortcut': 'Create desktop shortcut',
      'ctx.delete': 'Delete',

      'dlg.ok': 'OK',
      'dlg.cancel': 'Cancel',
      'dlg.close': 'Close',
      'dlg.renameTitle': 'Rename device',
      'dlg.renameDesc': 'Only changes the display name in this manager.',
      'dlg.backupTitle': 'Backup & restore',
      'dlg.batchTitle': 'Batch operations',
      'dlg.arrangeTitle': 'Arrange windows',
      'dlg.updateTitle': 'Check for updates',

      'sb.notStarted': 'Not started',
    },
  };

  const LANGS = [
    { id: 'zh-CN', label: '中' },
    { id: 'en-US', label: 'EN' },
  ];

  const STORAGE_KEY = 'avm.lang';

  function detectDefault() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && DICT[saved]) return saved;
    } catch {}
    const nav = (navigator.language || 'zh-CN').toLowerCase();
    return nav.startsWith('zh') ? 'zh-CN' : 'en-US';
  }

  let lang = detectDefault();

  function t(key, vars) {
    const table = DICT[lang] || DICT['zh-CN'];
    let s = table[key] != null ? table[key] : (DICT['zh-CN'][key] != null ? DICT['zh-CN'][key] : key);
    if (vars) {
      for (const k of Object.keys(vars)) s = s.split('{' + k + '}').join(String(vars[k]));
    }
    return s;
  }

  function applyI18n(root) {
    const scope = root || document;
    scope.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.dataset.i18n);
    });
    scope.querySelectorAll('[data-i18n-ph]').forEach((el) => {
      el.setAttribute('placeholder', t(el.dataset.i18nPh));
    });
    scope.querySelectorAll('[data-i18n-title]').forEach((el) => {
      el.setAttribute('title', t(el.dataset.i18nTitle));
    });
    document.documentElement.lang = lang === 'en-US' ? 'en' : 'zh-CN';
    const badge = document.getElementById('langLabel');
    if (badge) badge.textContent = (LANGS.find((l) => l.id === lang) || LANGS[0]).label;
  }

  function setLang(next) {
    if (!DICT[next]) return lang;
    lang = next;
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {}
    applyI18n();
    return lang;
  }

  function nextLang() {
    const i = LANGS.findIndex((l) => l.id === lang);
    return LANGS[(i + 1) % LANGS.length].id;
  }

  window.i18n = { t, applyI18n, setLang, nextLang, get lang() { return lang; }, LANGS, DICT };
})();
