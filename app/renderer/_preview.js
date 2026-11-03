// 预览辅助：按 URL 参数切换视图/标签并加载截图
//   ?tab=device          工作区里切到指定标签（会先切到工作区视图）
//   ?view=launcher       只显示启动器（设备网格）
//   ?scroll=camBack      切页后把指定元素滚动到可视区
//   ?sdkready=0          模拟「找不到 SDK」状态
//   ?ctx=1               打开第一张设备卡片的右键菜单
//   ?dlg=perf            打开设备设置弹窗并切到指定分区
(() => {
  const q = new URLSearchParams(location.search);
  const tab = q.get('tab') || 'device';
  const view = q.get('view');
  const scrollTo = q.get('scroll');
  const ctx = q.get('ctx');
  const dlg = q.get('dlg');

  setTimeout(() => {
    if (view !== 'launcher') {
      // 先切到工作区视图，标签按钮才可见
      const ws = document.querySelector('.rail-btn[data-view="workspace"]');
      if (ws) ws.click();

      const btn = document.querySelector(`.tab[data-tab="${tab}"]`);
      if (btn) btn.click();
    }

    const s = document.getElementById('btnShot');
    if (s) s.click();

    setTimeout(() => {
      if (ctx) {
        const card = document.querySelector('.dev-card');
        if (card) {
          const r = card.getBoundingClientRect();
          card.dispatchEvent(
            new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 200, clientY: r.top + 130 })
          );
        }
        // 截图期间可能被 resize 监听关掉，用 rAF 每帧重设保证最终画面里有菜单
        const menu = document.getElementById('ctxMenu');
        const keep = () => {
          if (!menu) return;
          menu.style.display = 'block';
          if (!menu.style.left) {
            menu.style.left = '500px';
            menu.style.top = '160px';
          }
          requestAnimationFrame(keep);
        };
        keep();
      }
      if (dlg) {
        const card = document.querySelector('.dev-card');
        const more = card && card.querySelector('.dev-more');
        if (more) more.click();
        const first = document.querySelector('#ctxMenu button[data-act="settings"]');
        if (first) first.click();
        setTimeout(() => {
          const nav = document.querySelector(`.dlg-nav-btn[data-sec="${dlg}"]`);
          if (nav) nav.click();
        }, 120);
      }
      if (q.get('task')) {
        const el = document.getElementById('taskProgress');
        if (el) {
          el.style.display = 'flex';
          document.getElementById('taskPhase').textContent = '备份 主实例  1.8 GB / 4.2 GB';
          document.getElementById('taskBar').style.width = '43%';
          document.getElementById('taskPct').textContent = '43%';
        }
      }
      if (q.get('diag')) {
        const box = document.createElement('div');
        box.style.cssText =
          'position:fixed;right:8px;bottom:40px;z-index:99999;background:#000;color:#0f0;' +
          'font:12px monospace;padding:8px;white-space:pre';
        document.body.appendChild(box);
        setInterval(() => {
          const shots = document.querySelectorAll('.dev-shot');
          box.textContent =
            `dev-shot 数量=${shots.length}\n` +
            `卡片数=${document.querySelectorAll('.dev-card').length}\n` +
            `initStep=${window.__initStep}\n` +
            `err=${window.__initErr || '无'}\n` +
            `--- thumbLog ---\n${window.__thumbLog || '(未执行)'}`;
        }, 300);
      }
      document.title = 'ready';
    }, scrollTo ? 700 : 250);

    if (scrollTo) {
      setTimeout(() => {
        const el = document.getElementById(scrollTo);
        // 滚动容器是 .sidepanel，不是 .panel
        const scroller = document.querySelector('.sidepanel');
        if (el && scroller) {
          const delta = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
          scroller.scrollTop += delta - 10;
        }
      }, 400);
    }
  }, 400);
})();
