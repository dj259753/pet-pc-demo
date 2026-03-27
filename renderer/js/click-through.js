/* ═══════════════════════════════════════════
   点击穿透管理器
   透明区域穿透到桌面，交互元素正常响应
   配合 main.js 的 setIgnoreMouseEvents(true, { forward: true })
   ═══════════════════════════════════════════ */

const ClickThrough = (() => {
  'use strict';

  // 当前是否处于穿透状态
  let isIgnoring = true;

  // 需要响应交互的元素选择器列表
  const INTERACTIVE_SELECTORS = [
    '#pet-container',
    '#hover-panel.visible',          // 只有显示时才阻止穿透
    '#bubble-stack:not(.hidden)',
    '#quick-chat:not(.hidden)',
    '#start-menu:not(.hidden)',
    '#compact-toolbar',
    '.retro-panel:not(.hidden)',   // 背包/对话/进程/日记等面板
    '#work-timer:not(.hidden)',
    '#focus-timer:not(.hidden)',
  ];

  function init() {
    if (!window.electronAPI || !window.electronAPI.setIgnoreMouse) {
      console.warn('🖱️ 点击穿透: electronAPI 不可用，跳过');
      return;
    }

    // 监听鼠标移动 → 判断是否在交互区域
    document.addEventListener('mousemove', onMouseMove);
    // 鼠标离开窗口时恢复穿透
    document.addEventListener('mouseleave', () => setIgnore(true));

    console.log('🖱️ 点击穿透管理器就绪');
  }

  function onMouseMove(e) {
    const shouldInteract = isOverInteractive(e.clientX, e.clientY);

    if (shouldInteract && isIgnoring) {
      // 进入交互区域 → 恢复鼠标事件
      setIgnore(false);
    } else if (!shouldInteract && !isIgnoring) {
      // 离开交互区域 → 穿透
      setIgnore(true);
    }
  }

  /**
   * 检查坐标是否在任何交互元素上
   * 优先用 elementFromPoint 判断，再用 AABB 兜底
   */
  function isOverInteractive(x, y) {
    // 方法1: elementFromPoint — 最准确
    const el = document.elementFromPoint(x, y);
    if (el && el !== document.body && el !== document.documentElement) {
      // 检查该元素或其祖先是否匹配交互选择器
      for (const sel of INTERACTIVE_SELECTORS) {
        if (el.closest(sel)) return true;
      }
      // 额外：任何有 pointer-events: auto 且不是 body 的可见元素
      // 按钮、输入框等原生交互元素
      const tag = el.tagName.toLowerCase();
      if (tag === 'button' || tag === 'input' || tag === 'a' || tag === 'select' || tag === 'textarea') {
        return true;
      }
    }

    // 方法2: AABB 包围盒兜底（元素可能被 pointer-events: none 遮挡）
    for (const sel of INTERACTIVE_SELECTORS) {
      const elements = document.querySelectorAll(sel);
      for (const elem of elements) {
        const rect = elem.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
          return true;
        }
      }
    }

    return false;
  }

  function setIgnore(ignore) {
    if (isIgnoring === ignore) return;
    isIgnoring = ignore;
    window.electronAPI.setIgnoreMouse(ignore);
  }

  return { init };
})();
