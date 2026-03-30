/* ═══════════════════════════════════════════
   全局鼠标拖拽 - 挣扎/落地动画 + 屏幕边界约束
   ═══════════════════════════════════════════ */

const DragSystem = (() => {
  let isDragging = false;
  let dragTimer = null;       // 持续拖拽定时器
  let dragDuration = 0;       // 拖拽持续时间（秒）
  let dragPointerOffset = { x: 0, y: 0 };
  let lastRequestedWindowPos = { x: 0, y: 0 };

  // 拖拽时的挣扎台词
  const struggleQuotes = [
    '放开我啦！🐧💦',
    '呜呜头好晕...🌀',
    '我的小脚丫悬空了！😱',
    '主人轻点轻点~',
    '啊啊啊要飞起来了！',
    '不要拽我嘛！🐧',
    '主人干嘛拖着我呀？',
    '我不是玩具啦！💦',
  ];

  // 落地台词
  const landingQuotes = [
    '终于落地了...🥴',
    '呼~安全着陆！🐧',
    '脚踏实地的感觉真好~',
    '不要再拽我了嘛！😤',
    '头还在转...🌀',
  ];

  function init() {
    const petContainer = document.getElementById('pet-container');
    applyPetAnchorPosition(0);

    // ─── 企鹅区域拖拽（full模式 + compact模式都生效） ───
    petContainer.addEventListener('mousedown', onDragStart);

    // ─── compact 模式下整个 body 也可拖拽 ───
    document.body.addEventListener('mousedown', (e) => {
      // 只在compact模式下，且不是点击浮动控制栏按钮时
      if (!TaskbarUI.isCompact) return;
      if (e.target.closest('#compact-toolbar')) return;
      if (e.button !== 0) return;
      startDrag(e);
    });

    const onDragMove = (e) => {
      if (!isDragging) return;
      updateDragPosition(e.screenX, e.screenY);
    };

    const onDragEnd = () => {
      if (!isDragging) return;
      finishDrag();
    };

    document.addEventListener('mousemove', onDragMove);
    window.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragEnd);
    window.addEventListener('mouseup', onDragEnd);
    window.addEventListener('blur', onDragEnd);
  }

  function resolveScreenPoint(inputX, inputY, e) {
    const parsedX = Number(inputX);
    const parsedY = Number(inputY);
    const fallbackX = Number(window.screenX || 0) + Number(e?.clientX || 0);
    const fallbackY = Number(window.screenY || 0) + Number(e?.clientY || 0);
    const mouseX = Number.isFinite(parsedX) ? parsedX : fallbackX;
    const mouseY = Number.isFinite(parsedY) ? parsedY : fallbackY;
    return {
      mouseX: Math.round(mouseX),
      mouseY: Math.round(mouseY),
    };
  }

  function updateDragPosition(mouseX, mouseY, e = null) {
    if (!isDragging) return;
    const point = resolveScreenPoint(mouseX, mouseY, e);
    lastRequestedWindowPos = {
      x: point.mouseX - dragPointerOffset.x,
      y: point.mouseY - dragPointerOffset.y,
    };
    applyPetAnchorPosition(lastRequestedWindowPos.y);
    window.electronAPI.dragMove(point);
  }

  function finishDrag() {
    isDragging = false;

    // 清除拖拽定时器
    clearTimeout(dragTimer);
    clearInterval(dragTimer);
    dragTimer = null;

    window.electronAPI.dragEnd();
    document.getElementById('pet-container').style.cursor = 'grab';

    // compact模式下不恢复行为引擎（保持暂停）
    if (TaskbarUI.isCompact) {
      SpriteRenderer.setAnimation('idle');
      enforceScreenBounds();
      EdgeSnap.check();
      return;
    }

    // ── 落地：播 QC 互动动画，播完回 Stand ──
    if (typeof SpriteRenderer !== 'undefined' && SpriteRenderer.qcLoaded) {
      const mood = (typeof PetState !== 'undefined') ? (PetState.mood || 'peaceful') : 'peaceful';
      const landAnim = SpriteRenderer.getQCInteract(mood);
      if (landAnim) {
        SpriteRenderer.loadQCSheet(landAnim).then(() => {
          SpriteRenderer.playOnce(landAnim, () => {
            const stand = SpriteRenderer.getQCStand(mood);
            SpriteRenderer.setAnimation(stand || 'idle');
            BehaviorEngine.resume();
          });
        });
      } else {
        SpriteRenderer.forceSetAnimation('idle');
        BehaviorEngine.resume();
      }
    } else {
      SpriteRenderer.forceSetAnimation('idle');
      BehaviorEngine.resume();
    }

    // 落地后检查屏幕边界
    enforceScreenBounds();
    EdgeSnap.check();
  }

  function onDragStart(e) {
    if (e.button !== 0) return; // 仅左键
    // 不拦截动作栏按钮、面板、菜单上的点击
    if (e.target.closest('.action-bar-btn') || e.target.closest('.retro-panel') || e.target.closest('#start-menu') || e.target.closest('#compact-toolbar') || e.target.closest('#action-bar') || e.target.closest('#hover-panel')) return;
    startDrag(e);
  }

  function startDrag(e) {
    if (isDragging) return;
    if (e?.button != null && e.button !== 0) return;
    e?.preventDefault?.();
    e?.stopPropagation?.();

    isDragging = true;
    dragDuration = 0;

    // 拖拽期间强制关闭点击穿透，避免窗口移动时丢失 mousemove / mouseup
    window.electronAPI?.setIgnoreMouse?.(false);

    // 如果处于吸附状态，拖拽立即退出吸附（不播 Appear 动画，直接重置）
    if (typeof EdgeSnap !== 'undefined' && EdgeSnap.isSnapped) {
      EdgeSnap.resetSnap();
    }

    const point = resolveScreenPoint(e?.screenX, e?.screenY, e);
    const currentLift = getCurrentPetLift();
    dragPointerOffset = {
      x: Number(e?.clientX || 0),
      y: Number(e?.clientY || 0) + currentLift,
    };
    lastRequestedWindowPos = {
      x: point.mouseX - dragPointerOffset.x,
      y: point.mouseY - dragPointerOffset.y,
    };
    applyPetAnchorPosition(lastRequestedWindowPos.y);

    window.electronAPI.dragStart(point);
    document.getElementById('pet-container').style.cursor = 'grabbing';
    SoundEngine.click();

    // compact 模式下不显示挣扎动画（简洁拖拽）
    if (TaskbarUI.isCompact) return;

    // ── 拖拽立即切换到挣扎动画 ──
    BehaviorEngine.pause();
    // QC 挣扎动画
    if (typeof SpriteRenderer !== 'undefined' && SpriteRenderer.qcLoaded) {
      const struggleAnim = SpriteRenderer.getQCStruggle();
      if (struggleAnim) {
        SpriteRenderer.loadQCSheet(struggleAnim).then(() => {
          if (isDragging) SpriteRenderer.forceSetAnimation(struggleAnim);
        });
      } else {
        SpriteRenderer.forceSetAnimation('question');
      }
    } else {
      SpriteRenderer.forceSetAnimation('question');
    }

    // 2秒 后开始显示挣扎台词
    dragTimer = setTimeout(() => {
      if (isDragging) {
        const msg = struggleQuotes[Math.floor(Math.random() * struggleQuotes.length)];
        BubbleSystem.show(msg, 3000);

        // 持续拖拽：每6秒换一句挣扎台词
        dragTimer = setInterval(() => {
          if (!isDragging) {
            clearInterval(dragTimer);
            return;
          }
          dragDuration += 6;
          const msg = struggleQuotes[Math.floor(Math.random() * struggleQuotes.length)];
          BubbleSystem.show(msg, 3000);
        }, 6000);
      }
    }, 2000);
  }

  function getPetAnchorMetrics() {
    const isCompact = typeof TaskbarUI !== 'undefined' && TaskbarUI.isCompact;
    if (isCompact) {
      return {
        winW: 160,
        winH: 160,
        petLeft: 0,
        petTop: 0,
        petWidth: 160,
        headTopOffset: 0,
        snapRightNudge: 0,
      };
    }

    return {
      winW: 320,
      winH: 460,
      petLeft: 80,
      petTop: 200,
      petWidth: 160,
      headTopOffset: 28,
      snapRightNudge: 0,
    };
  }

  function getCurrentPetLift() {
    const petContainer = document.getElementById('pet-container');
    const metrics = getPetAnchorMetrics();
    const currentTop = Number.parseFloat(petContainer?.style?.top);
    const effectiveTop = Number.isFinite(currentTop) ? currentTop : metrics.petTop;
    return Math.max(0, metrics.petTop - effectiveTop);
  }

  function applyPetAnchorPosition(requestedWindowY) {
    const petContainer = document.getElementById('pet-container');
    if (!petContainer) return;

    const metrics = getPetAnchorMetrics();
    const desiredY = Number.isFinite(requestedWindowY) ? requestedWindowY : 0;
    const maxLift = metrics.petTop + metrics.headTopOffset;
    const lift = desiredY < 0 ? Math.min(maxLift, -desiredY) : 0;
    petContainer.style.top = `${Math.round(metrics.petTop - lift)}px`;
  }

  function normalizeScreenContext(screenContext) {
    const fallbackBounds = {
      x: 0,
      y: 0,
      width: Number(screenContext?.width) || window.screen.width || 0,
      height: Number(screenContext?.height) || window.screen.height || 0,
    };
    return {
      virtualBounds: screenContext?.virtualBounds || fallbackBounds,
      currentDisplay: screenContext?.currentDisplay || fallbackBounds,
    };
  }

  function getDragBounds(screenContext) {
    const metrics = getPetAnchorMetrics();
    const { virtualBounds } = normalizeScreenContext(screenContext);
    // 横向和纵向都按整个扩展桌面算，防止跨屏时被主屏范围误夹
    const minY = virtualBounds.y - (metrics.petTop + metrics.headTopOffset);
    const maxY = virtualBounds.y + virtualBounds.height - metrics.winH;
    return {
      ...metrics,
      minX: virtualBounds.x - metrics.petLeft,
      maxX: virtualBounds.x + virtualBounds.width - (metrics.petLeft + metrics.petWidth) + metrics.snapRightNudge,
      minY,
      maxY,
    };
  }

  // ─── 屏幕边界约束（防止拖出屏幕） ───
  async function enforceScreenBounds() {
    if (!window.electronAPI) return;
    try {
      const [screenContext, winPos] = await Promise.all([
        window.electronAPI.getScreenContext(),
        window.electronAPI.getWindowPosition(),
      ]);
      const bounds = getDragBounds(screenContext);
      let { x, y } = winPos;
      let clamped = false;

      if (x < bounds.minX) { x = bounds.minX; clamped = true; }
      if (y < bounds.minY) { y = bounds.minY; clamped = true; }
      if (x > bounds.maxX) { x = bounds.maxX; clamped = true; }
      if (y > bounds.maxY) { y = bounds.maxY; clamped = true; }

      if (clamped) {
        window.electronAPI.setWindowPosition({ x, y });
      }
    } catch (e) {
      // 静默
    }
  }

  function startExternalDrag(e) {
    startDrag(e);
  }

  function moveExternalDrag(e) {
    if (!isDragging) return;
    e?.preventDefault?.();
    e?.stopPropagation?.();
    updateDragPosition(e?.screenX, e?.screenY, e);
  }

  function endExternalDrag(e) {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    if (!isDragging) return;
    finishDrag();
  }

  return {
    init,
    startExternalDrag,
    moveExternalDrag,
    endExternalDrag,
    get isDragging() { return isDragging; }
  };
})();
