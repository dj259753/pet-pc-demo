/* ═══════════════════════════════════════════
   边界感知 & 吸附系统
   拖拽到屏幕左右边缘时：
   1. 播放 Hide_left / Hide_right 吸附动画
   2. 窗口贴到屏幕边缘
   3. 点击宠物恢复（播 Appear 动画）
   ═══════════════════════════════════════════ */

const EdgeSnap = (() => {
  const SNAP_THRESHOLD = 50;
  let isSnapped = false;
  let snapSide = null;
  let isAnimating = false;

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
        snapRightReveal: 0,
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
      snapRightReveal: 0,
    };
  }

  function getWinSize() {
    const { winW, winH } = getPetAnchorMetrics();
    return { w: winW, h: winH };
  }

  function normalizeScreenContext(screenContext) {
    const fallbackBounds = {
      x: 0,
      y: 0,
      width: Number(screenContext?.width) || window.screen.width || 0,
      height: Number(screenContext?.height) || window.screen.height || 0,
    };
    return {
      currentDisplay: screenContext?.currentDisplay || fallbackBounds,
      virtualBounds: screenContext?.virtualBounds || fallbackBounds,
    };
  }

  function getVerticalBounds(displayBounds) {
    const metrics = getPetAnchorMetrics();
    return {
      minY: displayBounds.y - (metrics.petTop + metrics.headTopOffset),
      maxY: displayBounds.y + displayBounds.height - metrics.winH,
    };
  }

  async function check() {
    if (!window.electronAPI) return;
    if (isSnapped || isAnimating) return;

    try {
      const [screenContext, winPos] = await Promise.all([
        window.electronAPI.getScreenContext(),
        window.electronAPI.getWindowPosition(),
      ]);

      const metrics = getPetAnchorMetrics();
      const { currentDisplay } = normalizeScreenContext(screenContext);
      const displayLeft = currentDisplay.x;
      const displayRight = currentDisplay.x + currentDisplay.width;
      const { x, y } = winPos;
      const petLeftX = x + metrics.petLeft;
      const petRightX = petLeftX + metrics.petWidth;

      if (petLeftX < displayLeft + SNAP_THRESHOLD) {
        await snapToEdge('left', currentDisplay, y);
        return;
      }

      if (petRightX > displayRight - SNAP_THRESHOLD) {
        await snapToEdge('right', currentDisplay, y);
        return;
      }

      // 上下简单贴边
      const { minY, maxY } = getVerticalBounds(currentDisplay);
      let newY = y;
      if (y < minY + SNAP_THRESHOLD) newY = minY;
      else if (y > maxY - SNAP_THRESHOLD) newY = maxY;
      if (newY !== y) {
        window.electronAPI.setWindowPosition({ x, y: newY });
      }
    } catch (err) {}
  }

  async function snapToEdge(side, displayBounds, currentY) {
    isAnimating = true;
    isSnapped = true;
    snapSide = side;

    if (typeof BehaviorEngine !== 'undefined') BehaviorEngine.pause();

    const hideAnim = side === 'left' ? 'Hide_left' : 'Hide_right';

    const metrics = getPetAnchorMetrics();

    // 窗口定位：按当前显示器里的企鹅本体边缘贴边，而不是按整块透明窗口贴边
    let targetX;
    if (side === 'left') {
      targetX = displayBounds.x - metrics.petLeft;
    } else {
      targetX = displayBounds.x + displayBounds.width - (metrics.petLeft + metrics.petWidth) - metrics.snapRightReveal + metrics.snapRightNudge;
    }
    const { minY, maxY } = getVerticalBounds(displayBounds);
    let targetY = Math.max(minY, Math.min(currentY, maxY));
    window.electronAPI.setWindowPosition({ x: targetX, y: targetY });

    // 打断当前动画，播放吸附动画
    if (typeof SpriteRenderer !== 'undefined' && SpriteRenderer.qcLoaded) {
      await SpriteRenderer.loadQCSheet(hideAnim);
      SpriteRenderer.forceSetAnimation(hideAnim);
    }

    isAnimating = false;
    SoundEngine.snap();
    console.log(`🐧 吸附到${side === 'left' ? '左' : '右'}边缘`);
  }

  async function unsnap() {
    if (!isSnapped || isAnimating) return;
    if (!window.electronAPI) return;

    isAnimating = true;
    const side = snapSide;

    try {
      const [screenContext, winPos] = await Promise.all([
        window.electronAPI.getScreenContext(),
        window.electronAPI.getWindowPosition(),
      ]);

      const metrics = getPetAnchorMetrics();
      const { currentDisplay } = normalizeScreenContext(screenContext);
      const mood = (typeof PetState !== 'undefined') ? (PetState.mood || 'peaceful') : 'peaceful';

      // 播出现动画
      const appearPool = SpriteRenderer.QC_POOLS?.appear?.[mood] || SpriteRenderer.QC_POOLS?.appear?.['peaceful'] || [];
      const appearName = appearPool.length > 0 ? appearPool[0] : null;
      if (appearName) {
        SpriteRenderer.forceSetAnimation(appearName);
      }

      // 窗口移回当前显示器内（以企鹅本体留 10px 边距）
      let targetX = side === 'left'
        ? currentDisplay.x + 10 - metrics.petLeft
        : currentDisplay.x + currentDisplay.width - (metrics.petLeft + metrics.petWidth) - 10 + metrics.snapRightNudge;
      window.electronAPI.setWindowPosition({ x: targetX, y: winPos.y });

      // 切回 Stand
      const stand = SpriteRenderer.getQCStand(mood);
      if (stand) {
        setTimeout(() => SpriteRenderer.setAnimation(stand), 3000);
      }
    } catch (e) {
      console.warn('unsnap 失败:', e);
    }

    isSnapped = false;
    snapSide = null;
    isAnimating = false;

    // 10秒后恢复行为引擎
    setTimeout(() => {
      if (typeof BehaviorEngine !== 'undefined') BehaviorEngine.resume();
    }, 10000);
  }

  function resetSnap() {
    isSnapped = false;
    snapSide = null;
    isAnimating = false;
  }

  return {
    check,
    unsnap,
    resetSnap,
    get isSnapped() { return isSnapped; },
    get snapSide() { return snapSide; },
    get isAnimating() { return isAnimating; },
  };
})();
