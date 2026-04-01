/* ═══════════════════════════════════════════
   任务栏 UI 更新
   ═══════════════════════════════════════════ */

const TaskbarUI = (() => {
  // ─── 窗口模式 ───
  const FULL_SIZE = { width: 320, height: 460 };
  const COMPACT_SIZE = { width: 160, height: 160 };
  let isCompact = false;
  let compactHoverTimer = null;

  function init() {
    // ─── 开始菜单（从 hover-panel 设置按钮触发） ───
    const startMenu = document.getElementById('start-menu');

    // mousedown 比 click 更早触发，且不受透明区域穿透影响
    document.addEventListener('mousedown', (e) => {
      if (!startMenu.classList.contains('hidden') &&
          !startMenu.contains(e.target) &&
          !e.target.closest('#btn-settings')) {
        startMenu.classList.add('hidden');
      }
    });

    // 点击桌面或其他应用导致窗口失焦时，也自动收起菜单
    // 同时监听主进程 blur IPC（透明窗口 window.blur 不可靠）
    const closeMenuOnBlur = () => startMenu.classList.add('hidden');
    window.addEventListener('blur', closeMenuOnBlur);
    if (window.electronAPI?.onMainWindowBlur) {
      window.electronAPI.onMainWindowBlur(closeMenuOnBlur);
    }

    // ─── 菜单项 ───
    document.querySelectorAll('.menu-item').forEach(item => {
      item.addEventListener('click', () => {
        const action = item.dataset.action;
        startMenu.classList.add('hidden');
        SoundEngine.click();

        switch (action) {
          case 'backpack':
            PanelManager.togglePanel('backpack');
            break;
          case 'chat':
            PanelManager.togglePanel('chat');
            break;
          case 'focus':
            if (typeof FocusMode !== 'undefined') {
              if (FocusMode.isActive) {
                FocusMode.stop();
              } else {
                FocusMode.start();
              }
            }
            break;
          case 'process':
            ProcessManager.openTaskManager();
            break;
          case 'diary':
            if (typeof PetDiary !== 'undefined') PetDiary.openDiary();
            break;
          case 'status':
            showStatusPopup();
            break;
          case 'skills':
            // 打开 Skills 接入独立窗口
            if (window.electronAPI && window.electronAPI.openSkillsWindow) {
              window.electronAPI.openSkillsWindow();
            }
            break;
          case 'check-update':
            if (window.electronAPI && window.electronAPI.checkUpdatesNow) {
              BubbleSystem.show('正在检查更新...', 1800);
              window.electronAPI.checkUpdatesNow().then((result) => {
                if (!result) {
                  BubbleSystem.show('检查更新失败，请稍后重试', 2600);
                  return;
                }
                if (result.status === 'update-ready') {
                  BubbleSystem.show(`新版本 v${result.remoteVersion} 已下载就绪，请按弹窗提示升级`, 3200);
                  return;
                }
                if (result.status === 'downloading') {
                  BubbleSystem.show(`正在后台下载新版本 v${result.remoteVersion}...`, 3200);
                  return;
                }
                if (result.status === 'update-available') {
                  BubbleSystem.show(`发现新版本 v${result.remoteVersion}，正在后台下载...`, 3200);
                  return;
                }
                if (result.status === 'up-to-date') {
                  BubbleSystem.show(`当前已是最新版本 v${result.localVersion}`, 2800);
                  return;
                }
                if (result.status === 'disabled') {
                  BubbleSystem.show('自动更新未启用，请先配置更新地址', 2800);
                  return;
                }
                BubbleSystem.show(`检查更新失败：${result.error || '请稍后重试'}`, 3200);
              }).catch(() => {
                BubbleSystem.show('检查更新失败，请稍后重试', 2600);
              });
            } else {
              BubbleSystem.show('当前环境不支持检查更新', 2600);
            }
            break;
          case 'system-settings':
            PanelManager.togglePanel('system-settings');
            break;
          case 'feedback':
            PanelManager.togglePanel('feedback');
            break;
          case 'exit':
            if (window.electronAPI && window.electronAPI.quitApp) {
              // ─── 退出动画：从 Exit2/Exit4 随机选一个播放，播完再退出 ───
              if (typeof SpriteRenderer !== 'undefined' && SpriteRenderer.qcLoaded && SpriteRenderer.QC_COMMON.exit.length > 0) {
                const exitPool = SpriteRenderer.QC_COMMON.exit.filter(
                  name => name === 'Exit2' || name === 'Exit4'
                );
                const pool = exitPool.length > 0 ? exitPool : SpriteRenderer.QC_COMMON.exit;
                const exitAnim = pool[Math.floor(Math.random() * pool.length)];
                console.log('🐧 播放退出动画:', exitAnim);

                // ── 立即加退出锁，后续一切点击/互动/动画替换均无效 ──
                SpriteRenderer.setExiting();

                SpriteRenderer.loadQCSheet(exitAnim).then(() => {
                  SpriteRenderer.playOnce(exitAnim, () => {
                    window.electronAPI.quitApp();
                  });
                }).catch(() => {
                  window.electronAPI.quitApp();
                });

                // 安全兜底：最多等 5 秒，退出动画卡住也要退出（避免误以为程序无法关闭）
                setTimeout(() => { window.electronAPI.quitApp(); }, 10000);
              } else {
                window.electronAPI.quitApp();
              }
            }
            break;
        }
      });
    });

    // ─── hover-panel 上的窗口缩放按钮（full模式用） ───
    const btnMinimize = document.getElementById('btn-win-minimize');
    const btnMaximize = document.getElementById('btn-win-maximize');

    if (btnMinimize) {
      btnMinimize.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!isCompact) switchToCompact();
      });
    }

    if (btnMaximize) {
      btnMaximize.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isCompact) switchToFull();
      });
      btnMaximize.classList.add('active');
    }

    // ─── 浮动控制栏上的放大按钮（compact模式用） ───
    const btnCompactMax = document.getElementById('btn-compact-maximize');
    if (btnCompactMax) {
      btnCompactMax.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isCompact) switchToFull();
      });
    }

    // ─── compact模式下 鼠标悬停显示浮动控制栏 ───
    document.body.addEventListener('mouseenter', () => {
      if (!isCompact) return;
      clearTimeout(compactHoverTimer);
      document.body.classList.add('compact-hover');
      // 更新浮动时钟
      updateCompactClock();
    });

    document.body.addEventListener('mouseleave', () => {
      if (!isCompact) return;
      compactHoverTimer = setTimeout(() => {
        document.body.classList.remove('compact-hover');
      }, 800);
    });

    // ─── 时钟 ───
    updateClock();
    setInterval(updateClock, 1000);

    // ─── 监听状态变化更新 UI ───
    PetState.on('stat-change', updateBars);
    PetState.on('low-warning', onLowWarning);
  }

  // ─── 切换到缩小模式 ───
  function switchToCompact() {
    if (isCompact) return;
    isCompact = true;

    // 关闭所有面板和菜单
    document.querySelectorAll('.retro-panel').forEach(p => p.classList.add('hidden'));
    document.getElementById('start-menu').classList.add('hidden');

    // 暂停行走
    BehaviorEngine.pause();

    // 添加compact样式（会隐藏hover-panel等）
    document.body.classList.add('compact-mode');

    // 企鹅居中到 compact 窗口
    const petContainer = document.getElementById('pet-container');
    petContainer.style.left = '0px';
    petContainer.style.top = '0px';

    // 通知主进程缩小窗口
    if (window.electronAPI && window.electronAPI.resizeWindow) {
      window.electronAPI.resizeWindow(COMPACT_SIZE);
    }

    SoundEngine.click();
  }

  // ─── 切换到放大模式 ───
  function switchToFull() {
    if (!isCompact) return;
    isCompact = false;

    // 移除compact样式
    document.body.classList.remove('compact-mode');
    document.body.classList.remove('compact-hover');
    clearTimeout(compactHoverTimer);

    // 恢复企鹅位置
    const petContainer = document.getElementById('pet-container');
    petContainer.style.left = '80px';
    petContainer.style.top = '50px';

    // 通知主进程恢复窗口
    if (window.electronAPI && window.electronAPI.resizeWindow) {
      window.electronAPI.resizeWindow(FULL_SIZE);
    }

    // 更新按钮状态
    const btnMax = document.getElementById('btn-win-maximize');
    const btnMin = document.getElementById('btn-win-minimize');
    if (btnMax) btnMax.classList.add('active');
    if (btnMin) btnMin.classList.remove('active');

    SoundEngine.click();

    // 恢复行为引擎
    setTimeout(() => BehaviorEngine.resume(), 500);
  }

  function updateClock() {
    const now = new Date();
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    const timeStr = `${h}:${m}`;
    document.getElementById('taskbar-clock').textContent = timeStr;
    // 同步更新浮动时钟
    updateCompactClock();
  }

  function updateCompactClock() {
    const el = document.getElementById('compact-clock');
    if (el) {
      const now = new Date();
      const h = String(now.getHours()).padStart(2, '0');
      const m = String(now.getMinutes()).padStart(2, '0');
      el.textContent = `${h}:${m}`;
    }
  }

  function updateBars() {
    const { hunger, clean, energy } = PetState.stats;

    const barH = document.getElementById('bar-hunger');
    const barC = document.getElementById('bar-clean');
    const barE = document.getElementById('bar-energy');

    if (barH) barH.style.width = `${hunger}%`;
    if (barC) barC.style.width = `${clean}%`;
    if (barE) barE.style.width = `${energy}%`;

    const valH = document.getElementById('val-hunger');
    const valC = document.getElementById('val-clean');
    const valE = document.getElementById('val-energy');
    if (valH) valH.textContent = hunger;
    if (valC) valC.textContent = clean;
    if (valE) valE.textContent = energy;

    if (barH) barH.classList.toggle('warning', hunger <= 20);
    if (barC) barC.classList.toggle('warning', clean <= 20);
    if (barE) barE.classList.toggle('warning', energy <= 20);
  }

  function onLowWarning({ key, value }) {
    SoundEngine.warning();
    // 不弹气泡
  }

  function showStatusPopup() {
    const { hunger, clean, energy } = PetState.stats;
    const state = PetState.state;
    const focusStr = (typeof FocusMode !== 'undefined' && FocusMode.isActive) ? '\n🍅 番茄钟进行中' : '';
    const batteryStr = (typeof DesktopShepherd !== 'undefined') ? `\n🔋 电量:${DesktopShepherd.batteryPercent}%` : '';
    BubbleSystem.show(
      `📊 状态报告\n🍖饥饿:${hunger} ✨清洁:${clean} ⚡精力:${energy}\n当前:${state}${focusStr}${batteryStr}`,
      5000
    );
  }

  return {
    init, updateBars, showStatusPopup,
    get isCompact() { return isCompact; },
    switchToCompact, switchToFull,
  };
})();
