/* ═══════════════════════════════════════════
   面板管理 - 桌面物品直接交互 + 对话面板
   ═══════════════════════════════════════════ */

const PanelManager = (() => {
  let soapMode = false;

  function init() {
    const voiceModeMenu = document.getElementById('voice-mode-menu');
    const feedbackLink = document.getElementById('feedback-link');
    if (feedbackLink) {
      feedbackLink.addEventListener('click', async (e) => {
        e.preventDefault();
        const url = feedbackLink.getAttribute('href');
        if (window.electronAPI && window.electronAPI.openExternalUrl) {
          const result = await window.electronAPI.openExternalUrl(url);
          if (!result || result.ok === false) {
            BubbleSystem.show('打开链接失败，请稍后重试', 2400);
          }
        } else {
          window.open(url, '_blank');
        }
      });
    }

    // ─── 关闭按钮 ───
    document.querySelectorAll('.panel-close').forEach(btn => {
      btn.addEventListener('click', () => {
        const panelId = btn.dataset.panel;
        document.getElementById(panelId).classList.add('hidden');
        SoundEngine.menuClose();
      });
    });

    // ═══════════ 动作栏按钮交互 ═══════════

    // 🐟 喂小鱼 → 吃完后开心跳跃
    document.getElementById('btn-feed').addEventListener('click', (e) => {
      e.stopPropagation();
      BehaviorEngine.notifyInteraction();
      BehaviorEngine.pause();
      const btn = document.getElementById('btn-feed');
      if (PetState.feed()) {
        SoundEngine.feed();
        animateItemBtn(btn);
        SpriteRenderer.setAnimation('eating');
        BubbleSystem.show('小鱼好好吃！🐟', 2000);
        if (typeof PetDiary !== 'undefined') PetDiary.addEntry('feed', '吃了一条小鱼，好满足~');
        setTimeout(() => {
          BubbleSystem.show('吃饱啦！好开心！🎉', 2000);
          BehaviorEngine.startJumping(() => {
            BehaviorEngine.resume();
          });
        }, 1500);
      }
      updateInventoryUI();
    });

    // 🧼 用肥皂
    document.getElementById('btn-soap').addEventListener('click', (e) => {
      e.stopPropagation();
      BehaviorEngine.notifyInteraction();
      BehaviorEngine.pause();
      const btn = document.getElementById('btn-soap');
      if (PetState.inventory.soap <= 0) {
        SoundEngine.error();
        shakeBtn(btn);
        BubbleSystem.show('肥皂用完了...😢', 2000);
        setTimeout(() => BehaviorEngine.resume(), 1000);
        return;
      }
      soapMode = true;
      document.body.classList.add('soap-cursor');
      btn.classList.add('item-active');
      BubbleSystem.show('在我身上搓搓吧！🧼', 3000);
    });

    // 肥皂模式：点击宠物完成清洗
    document.getElementById('pet-container').addEventListener('click', () => {
      if (soapMode) {
        soapMode = false;
        document.body.classList.remove('soap-cursor');
        document.getElementById('btn-soap').classList.remove('item-active');
        if (PetState.wash()) {
          SoundEngine.wash();
          animateItemBtn(document.getElementById('btn-soap'));
          SpriteRenderer.setAnimation('rain_wash');
          EffectsEngine.startRain(3500);
          BubbleSystem.show('下雨啦~洗得干干净净！🌧️✨', 3000);
          if (typeof PetDiary !== 'undefined') PetDiary.addEntry('wash', '洗了个舒服的澡，清爽！');
          setTimeout(() => {
            SpriteRenderer.setAnimation('idle');
            BubbleSystem.show('洗完啦！好清爽！✨', 2000);
            BehaviorEngine.resume();
          }, 3500);
        } else {
          setTimeout(() => BehaviorEngine.resume(), 1000);
        }
        updateInventoryUI();
      }
    });

    // 💬 对讲 → 打开屏幕居中独立快捷对话窗口
    const btnTalk = document.getElementById('btn-talk');
    if (btnTalk) {
      // 默认快捷键提示（若有系统设置，会由 SystemSettings 再次覆盖）
      const shortcutEl = document.getElementById('talk-shortcut');
      if (shortcutEl) {
        shortcutEl.textContent = 'cmd/ctrl+u';
      }
      btnTalk.addEventListener('click', (e) => {
        e.stopPropagation();
        BehaviorEngine.notifyInteraction();
        // 调用主进程打开屏幕居中的独立快捷对话窗口
        if (window.electronAPI && window.electronAPI.openQuickChat) {
          window.electronAPI.openQuickChat();
        } else {
          // 非 Electron 环境降级：使用内嵌对话框
          document.dispatchEvent(new CustomEvent('open-quick-chat'));
        }
      });
    }

    // 🎤 语音对讲 → 切换录音状态
    const btnVoice = document.getElementById('btn-voice');
    if (btnVoice) {
      // 默认快捷键提示（若有系统设置，会由 SystemSettings 再次覆盖）
      const voiceShortcutEl = document.getElementById('voice-shortcut');
      if (voiceShortcutEl) {
        voiceShortcutEl.textContent = 'cmd/ctrl+k';
      }

      btnVoice.addEventListener('click', async (e) => {
        e.stopPropagation();
        BehaviorEngine.notifyInteraction();

        if (typeof VoiceMode !== 'undefined' && VoiceMode.isSupported) {
          // toggle() 是 async 的，await 拿到真实结果
          const nowRecording = await VoiceMode.toggle();

          // 更新按钮状态
          const voiceIcon = document.getElementById('voice-icon');
          const voiceLabel = document.getElementById('voice-label');
          if (nowRecording) {
            btnVoice.classList.add('recording');
            if (voiceIcon) voiceIcon.textContent = '\u25A0';  // ■ 方块
            if (voiceLabel) voiceLabel.textContent = '结束';
          } else {
            btnVoice.classList.remove('recording');
            if (voiceIcon) voiceIcon.textContent = '\u25CF';  // ● 圆点
            if (voiceLabel) voiceLabel.textContent = getIdleVoiceLabel();
          }
        } else {
          BubbleSystem.show('这个浏览器不支持语音功能', 3000);
        }
      });

      // 右键语音按钮：打开模式菜单
      btnVoice.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!voiceModeMenu || typeof VoiceMode === 'undefined') return;
        updateVoiceMenuActive();
        voiceModeMenu.classList.remove('hidden');
        // 边缘避让：靠近屏幕边缘时自动向内偏移，避免菜单被裁切
        const menuRect = voiceModeMenu.getBoundingClientRect();
        const margin = 8;
        const maxLeft = window.innerWidth - menuRect.width - margin;
        const maxTop = window.innerHeight - menuRect.height - margin;
        const left = Math.max(margin, Math.min(e.clientX, maxLeft));
        const top = Math.max(margin, Math.min(e.clientY, maxTop));
        voiceModeMenu.style.left = `${left}px`;
        voiceModeMenu.style.top = `${top}px`;
      });
    }

    if (voiceModeMenu) {
      voiceModeMenu.querySelectorAll('.voice-mode-item').forEach((item) => {
        item.addEventListener('click', () => {
          if (typeof VoiceMode === 'undefined') return;
          const nextMode = item.dataset.mode;
          VoiceMode.setMode(nextMode);
          updateVoiceMenuActive();
          syncVoiceIdleLabel();
          voiceModeMenu.classList.add('hidden');
          BubbleSystem.show(nextMode === 'single' ? '已切换：单次对话模式' : '已切换：实时通话模式', 1800);
        });
      });
    }

    if (typeof VoiceMode !== 'undefined' && VoiceMode.onModeChange) {
      VoiceMode.onModeChange(() => {
        syncVoiceIdleLabel();
        updateVoiceMenuActive();
      });
    }
    syncVoiceIdleLabel();

    // ⚙️ 设置 → 打开开始菜单
    const btnSettings = document.getElementById('btn-settings');
    if (btnSettings) {
      btnSettings.addEventListener('click', (e) => {
        e.stopPropagation();
        BehaviorEngine.notifyInteraction();
        const startMenu = document.getElementById('start-menu');
        if (startMenu) {
          const isHidden = startMenu.classList.contains('hidden');
          startMenu.classList.toggle('hidden');
          if (isHidden) {
            SoundEngine.menuOpen();
          } else {
            SoundEngine.menuClose();
          }
        }
      });
    }

    // ─── 全局点击：点击面板/菜单外部自动关闭 ───
    // 注意：system-settings-panel 和 feedback-panel 是表单型面板，不应被点击外部关闭
    const AUTO_CLOSE_PANEL_IDS = ['backpack-panel', 'process-panel', 'diary-panel'];
    const ALL_PANEL_IDS = ['backpack-panel', 'process-panel', 'diary-panel', 'system-settings-panel', 'feedback-panel'];
    const ALL_PANEL_SELECTORS = ALL_PANEL_IDS.map(id => `#${id}`).join(',');

    function closeAllPanelsAndMenus() {
      // 只关闭非表单型面板（设置/反馈面板保持打开）
      AUTO_CLOSE_PANEL_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (el && !el.classList.contains('hidden')) {
          el.classList.add('hidden');
        }
      });
      const startMenu = document.getElementById('start-menu');
      if (startMenu && !startMenu.classList.contains('hidden')) {
        startMenu.classList.add('hidden');
      }
      if (voiceModeMenu && !voiceModeMenu.classList.contains('hidden')) {
        voiceModeMenu.classList.add('hidden');
      }
    }

    document.addEventListener('click', (e) => {
      // 关闭语音模式菜单
      if (voiceModeMenu && !e.target.closest('#voice-mode-menu') && !e.target.closest('#btn-voice')) {
        voiceModeMenu.classList.add('hidden');
      }
      // 关闭所有 retro-panel：点击不在面板内、不在触发按钮内
      // 设置面板和反馈面板除外（需要手动关闭）
      const insideAnyPanel = e.target.closest(ALL_PANEL_SELECTORS);
      const insideTrigger = e.target.closest('#start-menu, .menu-item, .action-bar-btn, #btn-settings');
      if (!insideAnyPanel && !insideTrigger) {
        AUTO_CLOSE_PANEL_IDS.forEach(id => {
          const el = document.getElementById(id);
          if (el && !el.classList.contains('hidden')) {
            el.classList.add('hidden');
          }
        });
      }
      // 取消肥皂模式
      if (soapMode && !e.target.closest('#pet-container') && !e.target.closest('#btn-soap')) {
        soapMode = false;
        document.body.classList.remove('soap-cursor');
        document.getElementById('btn-soap').classList.remove('item-active');
        BubbleSystem.show('肥皂放回去了~', 1500);
        BehaviorEngine.resume();
      }
    });

    // ─── 窗口失焦（点击窗口外桌面区域）→ 关闭所有面板和菜单 ───
    window.addEventListener('blur', () => {
      closeAllPanelsAndMenus();
    });

    // ─── 双击宠物打开独立对话窗口 ───
    document.getElementById('pet-container').addEventListener('dblclick', () => {
      BehaviorEngine.notifyInteraction();
      if (window.electronAPI && window.electronAPI.openQuickChat) {
        window.electronAPI.openQuickChat();
      }
    });

    // ─── 面板切换来自主进程 ───
    if (window.electronAPI) {
      window.electronAPI.onTogglePanel((panel) => {
        if (panel === 'status') {
          TaskbarUI.showStatusPopup && TaskbarUI.showStatusPopup();
        } else {
          togglePanel(panel);
        }
      });
    }

    // ─── 进程管理器刷新按钮 ───
    const refreshBtn = document.getElementById('process-refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        ProcessManager.refreshProcessList();
        SoundEngine.click();
      });
    }
  }

  function getIdleVoiceLabel() {
    if (typeof VoiceMode !== 'undefined' && VoiceMode.mode === VoiceMode.MODE_REALTIME) {
      return '实时通话';
    }
    return '语音对讲';
  }

  function syncVoiceIdleLabel() {
    const btnVoice = document.getElementById('btn-voice');
    const voiceLabel = document.getElementById('voice-label');
    if (!btnVoice || !voiceLabel) return;
    if (!btnVoice.classList.contains('recording')) {
      voiceLabel.textContent = getIdleVoiceLabel();
    }
  }

  function updateVoiceMenuActive() {
    const voiceModeMenu = document.getElementById('voice-mode-menu');
    if (!voiceModeMenu || typeof VoiceMode === 'undefined') return;
    const current = VoiceMode.mode;
    voiceModeMenu.querySelectorAll('.voice-mode-item').forEach((el) => {
      el.classList.toggle('active', el.dataset.mode === current);
    });
  }

  function togglePanel(name) {
    const panels = ['backpack-panel', 'process-panel', 'diary-panel', 'system-settings-panel', 'feedback-panel'];
    const targetId = name === 'backpack' ? 'backpack-panel' :
                     name === 'process' ? 'process-panel' :
                     name === 'diary' ? 'diary-panel' :
                     name === 'system-settings' ? 'system-settings-panel' :
                     name === 'feedback' ? 'feedback-panel' : null;

    if (!targetId) return;

    const target = document.getElementById(targetId);
    const isVisible = !target.classList.contains('hidden');

    // 关闭所有面板
    panels.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.add('hidden');
    });

    if (!isVisible) {
      target.classList.remove('hidden');
      SoundEngine.menuOpen();
      if (targetId === 'backpack-panel') {
        ClipboardBag.updateClipboardPanel();
      }
      if (targetId === 'process-panel') {
        ProcessManager.refreshProcessList();
      }
      if (targetId === 'diary-panel' && typeof PetDiary !== 'undefined') {
        PetDiary.renderDiaryPanel();
        const durationEl = document.getElementById('diary-duration');
        if (durationEl) durationEl.textContent = PetDiary.getDuration();
        const countEl = document.getElementById('diary-count');
        if (countEl) countEl.textContent = `共 ${PetDiary.getEntries().length} 条记录`;
      }
    } else {
      SoundEngine.menuClose();
    }
  }

  function animateItemBtn(btn) {
    btn.classList.remove('using');
    void btn.offsetWidth;
    btn.classList.add('using');
    setTimeout(() => btn.classList.remove('using'), 500);
  }

  function shakeBtn(btn) {
    btn.classList.add('shake');
    setTimeout(() => btn.classList.remove('shake'), 400);
  }

  function animatePet(className) {
    const el = document.getElementById('pet-container');
    el.classList.remove(className);
    void el.offsetWidth;
    el.classList.add(className);
    setTimeout(() => el.classList.remove(className), 1000);
  }

  function updateInventoryUI() {
    const inv = PetState.inventory;

    // 喂食 badge
    const cookieCount = document.getElementById('cookie-count');
    if (cookieCount) cookieCount.textContent = '∞';

    // 背包面板（如果存在）
    const invCookie = document.getElementById('inv-cookie');
    const invSoap = document.getElementById('inv-soap');
    const invCoffee = document.getElementById('inv-coffee');
    const invToy = document.getElementById('inv-toy');
    if (invCookie) invCookie.textContent = '∞';
    if (invSoap) invSoap.textContent = `x${inv.soap}`;
    if (invCoffee) invCoffee.textContent = `x${inv.coffee}`;
    if (invToy) invToy.textContent = `x${inv.toy}`;

    // 喂食按钮不再禁用（小鱼干无限）
    const btnFeed = document.getElementById('btn-feed');
    if (btnFeed) btnFeed.disabled = false;

    // 洗澡按钮禁用状态
    const btnSoap = document.getElementById('btn-soap');
    if (btnSoap) btnSoap.disabled = inv.soap <= 0;

    // badge 显示/隐藏
    document.querySelectorAll('.action-bar-badge').forEach(badge => {
      const text = badge.textContent;
      if (text !== 'x∞' && text !== '∞') {
        badge.style.display = parseInt(text) <= 0 ? 'none' : '';
      }
    });
  }

  return { init, togglePanel, updateInventoryUI };
})();
