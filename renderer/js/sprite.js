/* ═══════════════════════════════════════════
   精灵动画渲染器 - Ruffle SWF 直接播放版
   用 Ruffle (Flash WASM 模拟器) 直接播放 QC 宠物 SWF 动画
   矢量原生透明，零质量损失
   ═══════════════════════════════════════════ */

const SpriteRenderer = (() => {
  // ─── Ruffle Player 实例 ───
  let rufflePlayer = null;
  let ruffleContainer = null;
  let currentAnim = 'idle';
  let currentSwfPath = '';

  // ─── 原版路由状态机（复刻 swfPet.js 的 next/old 语义） ───
  let currentRoute = null;       // 当前动画路由（oldNext）
  let currentRouteStartedAt = 0; // 当前路由生效时间，用于避免未加载完就提前切走
  let pendingRoute = null;       // 待切换路由（nextSwfRouter）
  let routeMonitorTimer = null;  // 每100ms检查切换时机
  let swfChanging = false;       // 防并发切换
  let savedRoute = null;         // 切换过程中缓存的下一次请求 { route, forceImmediate }

  // ─── 动画播放锁：播放中的动画不允许被抢占 ───
  let animLocked = false;
  let animOnComplete = null;
  let pollTimer = null;          // 帧轮询定时器
  let isExiting = false;         // 退出锁：设置后一切动画切换请求均拒绝
  let _pollSession = 0;          // 播完检测会话 ID，防止多次 playOnce 互相串号

  // ─── SWF 清单 ───
  let swfManifest = null;        // 动画名 → SWF 相对路径
  let qcLoaded = false;

  // 读取 SWF 文件需要跳过前缀
  const fs = typeof require !== 'undefined' ? require('fs') : null;
  const path = typeof require !== 'undefined' ? require('path') : null;

  // ─── 动画池：按 mood 和类型索引 ───
  const QC_POOLS = {
    stand:    {},
    speak:    {},
    interact: {},
    play:     {},
    appear:   {},
    hide:     {},
  };

  // 通用（不分情绪）动画池
  const QC_COMMON = {
    eat:     [],
    clean:   [],
    sick:    [],
    enter:   [],
    exit:    [],
    cure:    [],
    die:     [],
    dying:   [],
    levelup: [],
    revival: [],
    etoj:    [],
    jtoc:    [],
    bury:    [],
    first:   [],
    game:    [],
    hideleft:  [],
    hideright: [],
  };

  // ─── 原版路由规则（精简复刻） ───
  const NORMAL_AFTER_STATES = [
    'normal', 'hideleft', 'hideright', 'play', 'speak', 'interact', 'hide', 'appear',
    'eat', 'clean', 'cure', 'sick', 'etoj', 'jtoc', 'dying', 'die', 'revival',
    'bury', 'first', 'levup', 'enter', 'exit', 'game'
  ];

  const ROUTE_RULES = {
    normal:    { power: 0,   afterState: NORMAL_AFTER_STATES },
    play:      { power: 50,  backSwf: 'normal' },
    interact:  { power: 50,  backSwf: 'normal' },
    speak:     { power: 100, backSwf: 'normal' },
    etoj:      { power: 66,  lastTimeCut: 7, backSwf: 'canNext' },
    jtoc:      { power: 66,  lastTimeCut: 7, backSwf: 'canNext' },
    hide:      { power: 150, canSelfSet: true },
    appear:    { power: 150, backSwf: 'normal', canSelfSet: true },
    eat:       { power: 150, backSwf: 'normal', canSelfSet: true },
    clean:     { power: 150, backSwf: 'normal', canSelfSet: true },
    sick:      { power: 150, backSwf: 'normal', canSelfSet: true },
    cure:      { power: 150, backSwf: 'normal', canSelfSet: true },
    game:      { power: 150, canSelfSet: true },
    dying:     { power: 150, backSwf: 'canNext' },
    die:       { power: 170, afterState: ['revival', 'bury'], canSelfSet: true },
    revival:   { power: 170, backSwf: 'canNext' },
    bury:      { power: 170, lastTimeCut: 5, afterState: ['normal', 'changeState', 'first'], backSwf: 'normal' },
    first:     { power: 170, backSwf: 'normal' },
    levup:     { power: 170, backSwf: 'normal' },
    // 吸附态：默认停在最后一帧，不允许被 normal 抢回
    hideleft:  { power: 170, canSelfSet: true, afterState: ['hideleft', 'hideright', 'appear', 'exit'], freezeAtLastFrame: true },
    hideright: { power: 170, canSelfSet: true, afterState: ['hideleft', 'hideright', 'appear', 'exit'], freezeAtLastFrame: true },
    enter:     { power: 0 },
    exit:      { power: 0 },
    default:   { power: 0 },
  };

  function detectRouteState(animName) {
    const lower = String(animName || '').toLowerCase();

    if (lower.includes('-play-')) return 'play';
    if (lower.includes('-interact-')) return 'interact';
    if (lower.endsWith('-speak')) return 'speak';
    if (lower.endsWith('-stand') || lower.includes('-stand')) return 'normal';
    if (lower.endsWith('-appear')) return 'appear';
    if (lower.endsWith('-hide')) return 'hide';

    if (lower.startsWith('eat')) return 'eat';
    if (lower.startsWith('clean')) return 'clean';
    if (lower.startsWith('cure')) return 'cure';
    if (lower.startsWith('sick')) return 'sick';
    if (lower === 'etoj') return 'etoj';
    if (lower === 'jtoc') return 'jtoc';
    if (lower === 'dying') return 'dying';
    if (lower === 'die') return 'die';
    if (lower === 'revival') return 'revival';
    if (lower === 'bury') return 'bury';
    if (lower === 'first') return 'first';
    if (lower === 'levup') return 'levup';
    if (lower === 'hide_left') return 'hideleft';
    if (lower === 'hide_right') return 'hideright';
    if (lower.startsWith('enter')) return 'enter';
    if (lower.startsWith('exit')) return 'exit';
    if (lower.startsWith('game')) return 'game';

    return 'normal';
  }

  function buildRoute(animName, callBack = null) {
    if (!animName || !swfManifest?.[animName]) return null;
    const state = detectRouteState(animName);
    const rule = ROUTE_RULES[state] || ROUTE_RULES.default;
    return {
      name: state,
      src: animName,
      opt: {
        power: rule.power || 0,
        lastTimeCut: rule.lastTimeCut || 1,
        canSelfSet: !!rule.canSelfSet,
        afterState: rule.afterState ? [...rule.afterState] : null,
        backSwf: rule.backSwf || null,
        nextFrames: rule.nextFrames || null,
        freezeAtLastFrame: !!rule.freezeAtLastFrame,
      },
      callBack,
    };
  }

  // ═══════════════════════════════════════════
  //  加载 SWF 清单并分类
  // ═══════════════════════════════════════════

  async function loadSwfManifest() {
    try {
      const resp = await fetch('sprites/qc/swf-manifest.json');
      if (!resp.ok) throw new Error('swf-manifest not found');
      swfManifest = await resp.json();

      // 分类到动画池
      for (const name of Object.keys(swfManifest)) {
        const parts = name.split('-');

        if (parts.length === 1) {
          // 通用动作
          const lower = name.toLowerCase();
          if (lower.startsWith('eat'))       QC_COMMON.eat.push(name);
          else if (lower.startsWith('clean')) QC_COMMON.clean.push(name);
          else if (lower.startsWith('sick'))  QC_COMMON.sick.push(name);
          else if (lower.startsWith('enter')) QC_COMMON.enter.push(name);
          else if (lower.startsWith('exit'))  QC_COMMON.exit.push(name);
          else if (lower.startsWith('cure'))  QC_COMMON.cure.push(name);
          else if (lower === 'die')           QC_COMMON.die.push(name);
          else if (lower === 'dying')         QC_COMMON.dying.push(name);
          else if (lower === 'levup')         QC_COMMON.levelup.push(name);
          else if (lower === 'revival')       QC_COMMON.revival.push(name);
          else if (lower === 'etoj')          QC_COMMON.etoj.push(name);
          else if (lower === 'jtoc')          QC_COMMON.jtoc.push(name);
          else if (lower === 'bury')          QC_COMMON.bury.push(name);
          else if (lower === 'first')         QC_COMMON.first.push(name);
          else if (lower === 'hide_left')     QC_COMMON.hideleft.push(name);
          else if (lower === 'hide_right')    QC_COMMON.hideright.push(name);
        } else {
          const mood = parts[0];
          if (parts.length === 2) {
            const t = parts[1].toLowerCase().replace(/\d+$/, '');
            if (t === 'stand')       { (QC_POOLS.stand[mood] = QC_POOLS.stand[mood] || []).push(name); }
            else if (t === 'speak')  { (QC_POOLS.speak[mood] = QC_POOLS.speak[mood] || []).push(name); }
            else if (t === 'appear') { (QC_POOLS.appear[mood] = QC_POOLS.appear[mood] || []).push(name); }
            else if (t === 'hide')   { (QC_POOLS.hide[mood] = QC_POOLS.hide[mood] || []).push(name); }
            else { (QC_POOLS.stand[mood] = QC_POOLS.stand[mood] || []).push(name); }
          } else if (parts.length >= 3) {
            const category = parts[1].toLowerCase();
            if (category === 'interact') {
              (QC_POOLS.interact[mood] = QC_POOLS.interact[mood] || []).push(name);
            } else if (category === 'play') {
              (QC_POOLS.play[mood] = QC_POOLS.play[mood] || []).push(name);
            }
          }
        }
      }

      console.log('🐧 SWF清单加载完成:', Object.keys(swfManifest).length, '个动画');
      console.log('   stand池:', Object.entries(QC_POOLS.stand).map(([k,v]) => `${k}(${v.length})`).join(', '));
      console.log('   play池:', Object.entries(QC_POOLS.play).map(([k,v]) => `${k}(${v.length})`).join(', '));
      console.log('   通用:', Object.entries(QC_COMMON).filter(([k,v]) => v.length > 0).map(([k,v]) => `${k}(${v.length})`).join(', '));

      return true;
    } catch (e) {
      console.warn('SWF清单加载失败:', e.message);
      return false;
    }
  }

  // ═══════════════════════════════════════════
  //  Ruffle Player 管理
  // ═══════════════════════════════════════════

  /** 创建 Ruffle Player */
  function createRufflePlayer() {
    ruffleContainer = document.getElementById('ruffle-container');
    if (!ruffleContainer) {
      console.error('找不到 #ruffle-container');
      return false;
    }

    const ruffle = window.RufflePlayer?.newest();
    if (!ruffle) {
      console.error('Ruffle 未加载');
      return false;
    }

    rufflePlayer = ruffle.createPlayer();
    rufflePlayer.style.width = '160px';
    rufflePlayer.style.height = '160px';
    ruffleContainer.appendChild(rufflePlayer);
    console.log('🐧 Ruffle Player 已创建');
    return true;
  }

  /** 加载并播放 SWF 文件 */
  async function loadSwf(animName) {
    const swfPath = swfManifest?.[animName];
    if (!swfPath) {
      console.warn('未知动画:', animName);
      return false;
    }

    if (swfPath === currentSwfPath) {
      // 同一个 SWF，不重复加载，只重播
      try {
        rufflePlayer.rewind();
        rufflePlayer.play();
      } catch(e) {}
      return true;
    }

    try {
      // 通过 fetch 加载 SWF（Electron file:// 协议支持）
      const resp = await fetch(swfPath);
      const buf = await resp.arrayBuffer();
      const arr = new Uint8Array(buf);

      // 查找 CWS/FWS/ZWS 签名位置（跳过前缀字节）
      let offset = 0;
      for (let i = 0; i < Math.min(64, arr.length - 3); i++) {
        const s = String.fromCharCode(arr[i], arr[i+1], arr[i+2]);
        if (s === 'CWS' || s === 'FWS' || s === 'ZWS') {
          offset = i;
          break;
        }
      }

      const cleanData = arr.slice(offset);
      await rufflePlayer.load({ data: cleanData });
      currentSwfPath = swfPath;

      // 等一帧让 Ruffle 初始化
      await new Promise(r => setTimeout(r, 50));
      rufflePlayer.play();

      // 绑定拖拽事件（只需一次）
      bindRuffleContainerEvents();

      // 强制隐藏 Ruffle 的播放按钮/覆盖层（在 shadow DOM 内）
      hideRuffleOverlays();

      // 检测 Ruffle panic（仅对 interact 类动画，其他动画不检测）
      // 只有 prostrate/upset 的 interact 才容易 panic
      if (animName.includes('interact')) {
        const panicCheckAnim = animName;
        setTimeout(() => {
          if (currentAnim !== panicCheckAnim) return;
          if (checkRufflePanic()) {
            console.warn('🐧 SWF 渲染失败（Ruffle panic），回退:', panicCheckAnim);
            if (swfManifest) swfManifest[panicCheckAnim] = null;
            const stand = getQCStand('peaceful');
            if (stand && stand !== panicCheckAnim) {
              currentSwfPath = '';
              loadSwf(stand);
            }
            if (animLocked && animOnComplete) {
              stopPolling();
              animLocked = false;
              const cb = animOnComplete;
              animOnComplete = null;
              cb();
            }
          }
        }, 3000);
      }

      return true;
    } catch (e) {
      console.warn('SWF加载失败:', animName, e.message);
      return false;
    }
  }

  /** 绑定 Ruffle canvas 的 mousedown 事件到拖拽系统 */
  let _ruffleContainerBound = false;
  let _ruffleMousedownPending = false; // 防重入
  function bindRuffleContainerEvents() {
    const container = document.getElementById('ruffle-container');
    if (!container) return;

    const bindTarget = (target) => {
      if (!target || target.__dragBound) return;
      target.__dragBound = true;
      target.addEventListener('pointerdown', handleRufflePointerDown, true);
      target.addEventListener('pointermove', handleRufflePointerMove, true);
      target.addEventListener('pointerup', handleRufflePointerUp, true);
      target.addEventListener('pointercancel', handleRufflePointerUp, true);
      target.addEventListener('mousedown', handleRuffleMouseDown, true);
      target.addEventListener('mousemove', handleRuffleMouseMove, true);
      target.addEventListener('mouseup', handleRuffleMouseUp, true);
      target.addEventListener('mouseleave', handleRuffleMouseLeave, true);
    };

    bindTarget(container);
    bindTarget(rufflePlayer);
    bindTarget(rufflePlayer?.shadowRoot);

    if (_ruffleContainerBound) return;
    _ruffleContainerBound = true;
    console.log('🐧 Ruffle 拖拽事件绑定完成');
  }

  function handleRufflePointerDown(e) {
    if (e.button !== 0) return;
    e.currentTarget?.setPointerCapture?.(e.pointerId);
    handleRuffleMouseDown(e);
  }

  function handleRufflePointerMove(e) {
    if (typeof DragSystem !== 'undefined' && DragSystem.moveExternalDrag) {
      DragSystem.moveExternalDrag(e);
    }
  }

  function handleRufflePointerUp(e) {
    e.currentTarget?.releasePointerCapture?.(e.pointerId);
    if (typeof DragSystem !== 'undefined' && DragSystem.endExternalDrag) {
      DragSystem.endExternalDrag(e);
    }
  }

  function handleRuffleMouseDown(e) {
    if (e.button !== 0) return;
    if (_ruffleMousedownPending) return;
    _ruffleMousedownPending = true;
    setTimeout(() => { _ruffleMousedownPending = false; }, 100);

    if (typeof DragSystem !== 'undefined' && DragSystem.startExternalDrag) {
      DragSystem.startExternalDrag(e);
      return;
    }

    const pc = document.getElementById('pet-container');
    if (pc) {
      pc.dispatchEvent(new MouseEvent('mousedown', {
        clientX: e.clientX,
        clientY: e.clientY,
        screenX: e.screenX,
        screenY: e.screenY,
        button: 0,
        bubbles: false,
      }));
    }
  }

  function handleRuffleMouseMove(e) {
    if (typeof DragSystem !== 'undefined' && DragSystem.moveExternalDrag) {
      DragSystem.moveExternalDrag(e);
    }
  }

  function handleRuffleMouseUp(e) {
    if (typeof DragSystem !== 'undefined' && DragSystem.endExternalDrag) {
      DragSystem.endExternalDrag(e);
    }
  }

  function handleRuffleMouseLeave(e) {
    if (e.buttons === 0 && typeof DragSystem !== 'undefined' && DragSystem.endExternalDrag) {
      DragSystem.endExternalDrag(e);
    }
  }

  /** 强制隐藏 Ruffle shadow DOM 内的 play-button / splash-screen 等 UI，保留 unmute-overlay */
  function hideRuffleOverlays() {
    if (!rufflePlayer) return;
    try {
      const shadow = rufflePlayer.shadowRoot;
      if (!shadow) return;
      // 只隐藏 play-button 和 splash-screen，不隐藏 unmute-overlay（音频解锁需要）
      const allEls = shadow.querySelectorAll('div, button, .play-button, .splash-screen, .context-menu-overlay');
      allEls.forEach(el => {
        if (el.querySelector('canvas') || el.tagName === 'CANVAS') return;
        // 保留 unmute-overlay
        if (el.className && String(el.className).includes('unmute')) return;
        el.style.display = 'none';
      });
      // 注入 style：只隐藏 play-button / splash，不碰 unmute
      if (!shadow.querySelector('#ruffle-hide-style')) {
        const style = document.createElement('style');
        style.id = 'ruffle-hide-style';
        style.textContent = `
          .play-button, .splash-screen,
          .context-menu-overlay, [class*="play"], [class*="splash"] {
            display: none !important; opacity: 0 !important;
          }
        `;
        shadow.appendChild(style);
      }
    } catch (e) {
      // shadow DOM 不可访问，忽略
    }
  }

  /** 检测 Ruffle 是否显示了 panic/error 页面 */
  function checkRufflePanic() {
    if (!rufflePlayer) return false;
    try {
      const shadow = rufflePlayer.shadowRoot;
      if (!shadow) return false;
      // Ruffle panic 时会在 shadow DOM 内创建 .panic 或包含错误文字的元素
      const panicEl = shadow.querySelector('.panic, .panic-body, [class*="panic"]');
      if (panicEl) return true;
      // 也检查文字内容
      const allText = shadow.textContent || '';
      if (allText.includes('出了些问题') || allText.includes('Something went wrong') || allText.includes('panic')) {
        return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  // ═══════════════════════════════════════════
  //  原版路由状态机：切换时机/优先级/回退
  // ═══════════════════════════════════════════

  function ensureRouteMonitor() {
    if (routeMonitorTimer) return;
    routeMonitorTimer = setInterval(() => {
      if (pendingRoute && shouldSwitchNow(pendingRoute)) {
        const target = pendingRoute;
        pendingRoute = null;
        switchRouteNow(target);
      }
      keepHidePoseLooping();
    }, 100);
  }

  function stopRouteMonitorIfIdle() {
    if (!routeMonitorTimer) return;
    if (!pendingRoute && !currentRoute?.opt?.nextFrames && !currentRoute?.opt?.freezeAtLastFrame) {
      clearInterval(routeMonitorTimer);
      routeMonitorTimer = null;
    }
  }

  function getFrameState() {
    try {
      return {
        currentFrame: Number(rufflePlayer?.currentFrame ?? 0),
        totalFrames: Number(rufflePlayer?.totalFrames ?? 0),
      };
    } catch (e) {
      return { currentFrame: 0, totalFrames: 0 };
    }
  }

  function shouldSwitchNow(nextRoute) {
    if (!nextRoute) return false;
    if (!currentRoute) return true;

    // 原版：game 状态不允许被随意抢占
    if (currentRoute.name === 'game') return false;

    // 原版：afterState 白名单限制
    const afterState = currentRoute?.opt?.afterState;
    if (afterState && nextRoute.name !== 'exit' && !afterState.includes(nextRoute.name)) {
      return false;
    }

    const { currentFrame, totalFrames } = getFrameState();
    const lastTimeCut = Number(currentRoute?.opt?.lastTimeCut || 1);

    if (!Number.isFinite(totalFrames) || totalFrames <= 1) {
      // totalFrames 不可用时，不能直接放行；否则会出现 1~2 秒被截断回退
      const holdElapsed = Date.now() - Number(currentRouteStartedAt || 0);
      const nextPower = Number(nextRoute?.opt?.power || 0);
      const curPower = Number(currentRoute?.opt?.power || 0);

      if (nextRoute?.name === 'exit') return true;
      if (nextPower > curPower) return true;

      // 吸附冻结态：仅允许显式 appear/exit（afterState 已控），这里不放行自动回退
      if (currentRoute?.opt?.freezeAtLastFrame) return false;

      // 兜底：如果长时间拿不到帧信息，再允许切换，防止极端场景永远卡住
      if (holdElapsed >= 12000) return true;
      return false;
    }

    // 原版：到尾帧前 lastTimeCut 时机切换
    if (currentFrame >= Math.max(1, totalFrames - lastTimeCut)) return true;

    const nextPower = Number(nextRoute?.opt?.power || 0);
    const curPower = Number(currentRoute?.opt?.power || 0);

    // 原版：高优先级可抢占
    if (nextPower > curPower) return true;

    // 原版：同优先级 + canSelfSet 可抢占
    if (nextPower === curPower && nextRoute?.opt?.canSelfSet) return true;

    // 原版：exit 永远可切
    if (nextRoute.name === 'exit') return true;

    // 原版：某些 normal 可直接切
    if (currentRoute?.opt?.isOverState === 'normal') return true;

    return false;
  }

  function keepHidePoseLooping() {
    if (!currentRoute?.opt || !rufflePlayer) return;

    const { currentFrame, totalFrames } = getFrameState();
    if (!Number.isFinite(totalFrames) || totalFrames <= 1) return;

    // 吸附态：默认停在最后一帧并保持暂停
    if (currentRoute.opt.freezeAtLastFrame) {
      if (currentFrame >= totalFrames - 2) {
        tryStopAtLastFrame(totalFrames);
      }
      return;
    }

    // 兼容旧逻辑：需要循环维持姿态的动画走 nextFrames
    if (!currentRoute.opt.nextFrames) return;
    if (currentFrame >= totalFrames - 1) {
      const targetFrame = Number(currentRoute.opt.nextFrames);
      tryJumpToFrame(targetFrame);
    }
  }

  function tryStopAtLastFrame(totalFrames) {
    if (!Number.isFinite(totalFrames) || !rufflePlayer) return;

    const candidates = [Math.round(totalFrames), Math.max(0, Math.round(totalFrames - 1))];

    try {
      if (typeof rufflePlayer.gotoAndStop === 'function') {
        for (const frame of candidates) {
          try { rufflePlayer.gotoAndStop(frame); break; } catch (e) {}
        }
      } else if (typeof rufflePlayer.GotoAndStop === 'function') {
        for (const frame of candidates) {
          try { rufflePlayer.GotoAndStop(frame); break; } catch (e) {}
        }
      } else if (typeof rufflePlayer.gotoFrame === 'function') {
        for (const frame of candidates) {
          try { rufflePlayer.gotoFrame(frame); break; } catch (e) {}
        }
      } else if (typeof rufflePlayer.GotoFrame === 'function') {
        for (const frame of candidates) {
          try { rufflePlayer.GotoFrame(frame); break; } catch (e) {}
        }
      }
      rufflePlayer.pause?.();
    } catch (e) {}
  }

  function tryJumpToFrame(frame) {
    if (!Number.isFinite(frame) || frame < 0 || !rufflePlayer) return;
    try {
      if (typeof rufflePlayer.gotoFrame === 'function') {
        rufflePlayer.gotoFrame(frame);
      } else if (typeof rufflePlayer.GotoFrame === 'function') {
        rufflePlayer.GotoFrame(frame);
      } else if (typeof rufflePlayer.gotoAndPlay === 'function') {
        rufflePlayer.gotoAndPlay(frame);
      } else if (typeof rufflePlayer.GotoAndPlay === 'function') {
        rufflePlayer.GotoAndPlay(frame);
      }
      rufflePlayer.play?.();
    } catch (e) {}
  }

  function queueRoute(route) {
    if (!route) return;

    // 与当前完全一致则忽略（避免 normal 重复排队造成无意义重播）
    if (currentRoute && currentRoute.src === route.src && currentRoute.name === route.name) {
      return;
    }

    // 与待切换目标一致也忽略
    if (pendingRoute && pendingRoute.src === route.src && pendingRoute.name === route.name) {
      return;
    }

    pendingRoute = route;
    ensureRouteMonitor();
    if (shouldSwitchNow(route)) {
      const target = pendingRoute;
      pendingRoute = null;
      switchRouteNow(target);
    }
  }

  async function switchRouteNow(route, forceImmediate = false) {
    if (!route) return;
    if (swfChanging) {
      savedRoute = { route, forceImmediate };
      return;
    }

    swfChanging = true;
    try {
      currentAnim = route.src;
      await loadSwf(route.src);
      currentRoute = route;
      currentRouteStartedAt = Date.now();

      if (route.callBack?.load) route.callBack.load();

      // 原版 backSwf：切换后立即预置回退路由（并非立刻切）
      if (route.opt?.backSwf) {
        setTimeout(() => {
          if (route.opt.backSwf === 'canNext') {
            if (pendingRoute) return;
            const stand = getStandByCurrentMood();
            if (stand && stand !== route.src) {
              const backRoute = buildRoute(stand);
              if (backRoute) queueRoute(backRoute);
            }
          } else if (route.opt.backSwf === 'normal') {
            const stand = getStandByCurrentMood();
            if (stand && stand !== route.src) {
              const backRoute = buildRoute(stand);
              if (backRoute) queueRoute(backRoute);
            }
          }
        }, 100);
      }
    } finally {
      swfChanging = false;
      if (savedRoute) {
        const next = savedRoute;
        savedRoute = null;
        if (next.forceImmediate) {
          switchRouteNow(next.route, true);
        } else {
          queueRoute(next.route);
        }
      }
      stopRouteMonitorIfIdle();
    }
  }

  function getStandByCurrentMood() {
    const mood = (typeof PetState !== 'undefined') ? (PetState.mood || 'peaceful') : 'peaceful';
    return getQCStand(mood) || getQCStand('peaceful');
  }

  // ═══════════════════════════════════════════
  //  播完检测（轮询 Ruffle 帧状态）
  // ═══════════════════════════════════════════

  function startPlayOncePolling(onComplete) {
    stopPolling();
    let prevFrame = -1;
    let stableCount = 0;
    let startTime = Date.now();
    let hasStartedPlaying = false; // 是否已观测到帧推进（frame > 0）

    // 用 sessionId 防止跨 playOnce 的回调交叉触发
    const sessionId = ++_pollSession;

    pollTimer = setInterval(() => {
      if (!rufflePlayer) { stopPolling(); return; }
      if (_pollSession !== sessionId) { stopPolling(); return; }

      try {
        const current = rufflePlayer.currentFrame;
        const elapsed = Date.now() - startTime;

        // 前2秒不做判定（等 Ruffle 充分加载和播放）
        if (elapsed < 2000) {
          prevFrame = current;
          return;
        }

        // 必须先观测到帧推进，才算动画真正开始
        if (!hasStartedPlaying) {
          if (current > 0 && current !== prevFrame) {
            hasStartedPlaying = true;
          }
          prevFrame = current;
          return;
        }

        // 帧号5秒不变 = 动画停住了（播完或卡住）
        if (current === prevFrame) {
          stableCount++;
          if (stableCount >= 50) { // 50 * 100ms = 5秒
            fireComplete(onComplete, sessionId);
            return;
          }
        } else {
          stableCount = 0;
        }

        prevFrame = current;
      } catch (e) {}
    }, 100);
  }

  function fireComplete(onComplete, sessionId) {
    if (sessionId !== undefined && _pollSession !== sessionId) return;
    stopPolling();
    animLocked = false;
    if (onComplete) {
      const cb = onComplete;
      animOnComplete = null;
      cb();
    }
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // ═══════════════════════════════════════════
  //  动画选择接口（与旧版完全兼容）
  // ═══════════════════════════════════════════

  function getQCStand(mood) {
    const pool = QC_POOLS.stand[mood] || QC_POOLS.stand['peaceful'] || [];
    return pool.length > 0 ? pool[0] : null;
  }

  function getQCSpeak(mood) {
    const pool = QC_POOLS.speak[mood] || QC_POOLS.speak['peaceful'] || [];
    return pool.length > 0 ? pool[0] : null;
  }

  // ─── 最近播放去重（避免短时间内重复同一动画） ───
  const recentPlayed = [];     // 最近播放的动画名
  const RECENT_MAX = 8;        // 记住最近8个，不从中重复选

  function pickRandom(pool) {
    if (pool.length === 0) return null;
    // 排除最近播放过的
    const available = pool.filter(name => !recentPlayed.includes(name));
    const arr = available.length > 0 ? available : pool; // 全都播过了就重置
    const pick = arr[Math.floor(Math.random() * arr.length)];
    // 记录
    recentPlayed.push(pick);
    if (recentPlayed.length > RECENT_MAX) recentPlayed.shift();
    return pick;
  }

  function getQCInteract(mood) {
    const pool = QC_POOLS.interact[mood] || QC_POOLS.interact['peaceful'] || [];
    return pickRandom(pool);
  }

  function getQCPlay(mood) {
    const pool = QC_POOLS.play[mood] || QC_POOLS.play['peaceful'] || [];
    return pickRandom(pool);
  }

  function getQCCommon(type) {
    const pool = QC_COMMON[type] || [];
    if (pool.length === 0) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function getQCStroke(mood) {
    const candidates = [
      `${mood}-interact-H1`,
      `${mood}-interact-H5`,
    ].filter(name => swfManifest?.[name]);
    if (candidates.length === 0) {
      return swfManifest?.['peaceful-interact-H1'] ? 'peaceful-interact-H1' :
             swfManifest?.['peaceful-interact-H5'] ? 'peaceful-interact-H5' : null;
    }
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  function getQCStruggle() {
    // 优先用 upset 的 interact（Ruffle 兼容性最好）
    const upsetPool = QC_POOLS.interact['upset'] || [];
    // 只选 BE(身体)/LF(左脚)/RF(右脚)/RH(右手) 类——挣扎感强
    const struggles = upsetPool.filter(name => {
      const last = name.split('-').pop();
      return last.startsWith('BE') || last.startsWith('LF') || last.startsWith('RF') || last.startsWith('RH');
    });
    const arr = struggles.length > 0 ? struggles : upsetPool;
    return pickRandom(arr);
  }

  // ─── 预加载心情动画（Ruffle 模式下不需要，保留接口兼容） ───
  async function preloadMoodSheets(mood) {
    // Ruffle 按需加载 SWF，不需要预加载
    console.log(`🐧 Ruffle模式: ${mood} 心情动画按需加载`);
  }

  // ─── 加载 QC Sheet（兼容接口，Ruffle 模式下返回 true） ───
  function loadQCSheet(name) {
    return Promise.resolve(true);
  }

  // ═══════════════════════════════════════════
  //  旧动画名 → QC 动画名 映射
  // ═══════════════════════════════════════════

  const LEGACY_MAP = {
    'idle':         () => getQCStand('peaceful'),
    'happy':        () => getQCStand('happy'),
    'happy_jump':   () => getQCInteract('happy'),
    'sad':          () => getQCStand('sad'),
    'eating':       () => getQCCommon('eat'),
    'washing':      () => getQCCommon('clean'),
    'thinking':     () => getQCStand('peaceful'),
    'talking':      () => getQCSpeak('peaceful'),
    'sleeping':     () => getQCStand('prostrate'),
    'sleeping_lie': () => getQCStand('prostrate'),
    'working':      () => getQCStand('peaceful'),
    'working_1':    () => getQCStand('peaceful'),
    'working_2':    () => getQCStand('peaceful'),
    'error':        () => getQCStand('upset'),
    'walk_right':   () => getQCPlay('peaceful'),
    'walk_left':    () => getQCPlay('peaceful'),
    'yawning':      () => getQCPlay('peaceful'),
  };

  // ═══════════════════════════════════════════
  //  动画切换核心 API
  // ═══════════════════════════════════════════

  /** 切换动画（可被锁定阻止） */
  function setAnimation(name) {
    if (animLocked) return;
    // 吸附状态下不允许切换动画（除非 forceSetAnimation）
    if (typeof EdgeSnap !== 'undefined' && EdgeSnap.isSnapped) return;
    _doSetAnimation(name, false, null);
  }

  /** 播放一次动画（锁定直到播完，然后执行回调） */
  function playOnce(name, onComplete) {
    // 吸附状态下拒绝播放（吸附是最高优先级）
    if (typeof EdgeSnap !== 'undefined' && EdgeSnap.isSnapped) {
      if (onComplete) onComplete(); // 立即回调避免卡死
      return;
    }

    animLocked = false;
    stopPolling();
    _doSetAnimation(name, true, null);

    // 设置锁定和回调
    animLocked = true;
    animOnComplete = onComplete || null;

    // 启动播完检测轮询
    startPlayOncePolling(onComplete);

    // 安全兜底：最长60秒自动解锁（防止检测失败卡死）
    setTimeout(() => {
      if (animLocked && animOnComplete === onComplete) {
        console.warn('🐧 playOnce 超时兜底:', name);
        stopPolling();
        animLocked = false;
        if (animOnComplete) {
          const cb = animOnComplete;
          animOnComplete = null;
          cb();
        }
      }
    }, 60000);
  }

  /** 强制切换动画（无视锁定，但退出流程不可打断） */
  function forceSetAnimation(name) {
    if (isExiting) return;
    animLocked = false;
    animOnComplete = null;
    stopPolling();
    _doSetAnimation(name, true, null);
  }

  /** 内部动画切换实现（对齐原版 next/old 路由机制） */
  function _doSetAnimation(name, force = false, callBack = null) {
    let resolved = null;

    // 直接是 QC 动画名
    if (swfManifest?.[name]) {
      resolved = name;
    }

    // 旧动画名 → 映射到 QC
    if (!resolved && qcLoaded && LEGACY_MAP[name]) {
      const mapped = LEGACY_MAP[name]();
      if (mapped && swfManifest?.[mapped]) resolved = mapped;
    }

    // 兜底
    if (!resolved && qcLoaded) {
      const fallback = getQCStand('peaceful');
      if (fallback) resolved = fallback;
    }

    if (!resolved) return;

    const route = buildRoute(resolved, callBack);
    if (!route) return;

    if (force) {
      pendingRoute = null;
      switchRouteNow(route, true);
      return;
    }

    queueRoute(route);
  }

  // ═══════════════════════════════════════════
  //  启动
  // ═══════════════════════════════════════════

  function start() {
    // 创建 Ruffle Player
    const playerOk = createRufflePlayer();
    if (!playerOk) {
      console.error('🐧 Ruffle Player 创建失败！');
      return;
    }

    // 加载 SWF 清单
    loadSwfManifest().then(ok => {
      if (ok) {
        qcLoaded = true;
        console.log('🐧 Ruffle SWF 模式就绪');

        // 不在此处切动画，由 app.js 入场动画接管
        // 兜底：2秒后如果还没播任何东西，默认切 Stand
        setTimeout(() => {
          if (!currentSwfPath) {
            const stand = getQCStand('peaceful');
            if (stand) setAnimation(stand);
          }
        }, 2000);
      }
    });
  }

  // ─── 兼容接口 ───
  function registerSheet() {}
  function getFrameIndex() { return 0; }

  return {
    start,
    setAnimation,
    playOnce,
    forceSetAnimation,
    registerSheet,
    getFrameIndex,
    /** 设置音量 0=静音, 1=正常 */
    setVolume(vol) {
      try {
        if (rufflePlayer) rufflePlayer.volume = vol;
      } catch (e) {}
    },
    /** 退出前调用，锁定后所有动画替换均拒绝 */
    setExiting() { isExiting = true; },
    get isExiting() { return isExiting; },
    get currentAnim() { return currentAnim; },
    // QC 动画接口
    get qcLoaded() { return qcLoaded; },
    getQCStand,
    getQCSpeak,
    getQCInteract,
    getQCPlay,
    getQCCommon,
    getQCStroke,
    getQCStruggle,
    preloadMoodSheets,
    loadQCSheet,
    QC_POOLS,
    QC_COMMON,
  };
})();
