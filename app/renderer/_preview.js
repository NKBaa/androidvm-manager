// 预览辅助：按 URL 参数切换标签页并加载截图
//   ?tab=device          切换到指定标签
//   ?scroll=camBack      切页后把指定元素滚动到可视区（用于截长面板的局部）
(() => {
  const q = new URLSearchParams(location.search);
  const tab = q.get('tab') || 'device';
  const scrollTo = q.get('scroll');

  setTimeout(() => {
    const btn = document.querySelector(`.tab[data-tab="${tab}"]`);
    if (btn) btn.click();

    const s = document.getElementById('btnShot');
    if (s) s.click();

    if (scrollTo) {
      setTimeout(() => {
        const el = document.getElementById(scrollTo);
        // 滚动容器是 .sidepanel，不是 .panel
        const scroller = document.querySelector('.sidepanel');
        if (el && scroller) {
          const delta = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
          scroller.scrollTop += delta - 10;
        }
        document.title = 'ready';
      }, 700);
    } else {
      document.title = 'ready';
    }
  }, 400);
})();
