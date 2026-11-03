// 预览辅助：按 URL 参数切换标签页并加载截图
(() => {
  const q = new URLSearchParams(location.search);
  const tab = q.get('tab') || 'device';

  setTimeout(() => {
    const btn = document.querySelector(`.tab[data-tab="${tab}"]`);
    if (btn) btn.click();

    const s = document.getElementById('btnShot');
    if (s) s.click();

    document.title = 'ready';
  }, 400);
})();
