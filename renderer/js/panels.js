/* ═══════════════════════════════════════════
   面板管理 - 桌面物品直接交互 + 对话面板
   ═══════════════════════════════════════════ */

const PanelManager = (() => {

  function init() {
    const voiceModeMenu = document.getElementById('voice-mode-menu');
    const skillModeMenu = document.getElementById('skill-mode-menu');
    const translatePill = document.getElementById('translate-pill');
    const translateToggleBtn = document.getElementById('skill-translate-toggle');
    let translateMode = false;
    let translating = false;
    let lastSelectionText = '';
    let selectionPollTimer = null;
    /** 鼠标经穿透区移向技能菜单时，避免立刻关闭 */
    let skillMenuCloseDelayTimer = null;
    const SKILL_MENU_CLOSE_DELAY_MS = 320;
    function cancelSkillMenuCloseDelay() {
      if (skillMenuCloseDelayTimer) {
        clearTimeout(skillMenuCloseDelayTimer);
        skillMenuCloseDelayTimer = null;
      }
    }
    function scheduleSkillMenuCloseFromHover() {
      if (!skillModeMenu || skillModeMenu.classList.contains('hidden')) return;
      cancelSkillMenuCloseDelay();
      skillMenuCloseDelayTimer = setTimeout(() => {
        skillMenuCloseDelayTimer = null;
        if (skillModeMenu && !skillModeMenu.classList.contains('hidden')) {
          skillModeMenu.classList.add('hidden');
        }
      }, SKILL_MENU_CLOSE_DELAY_MS);
    }
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

    // 🧼 点击洗澡按钮立即洗澡（简化模式）
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
      if (PetState.wash()) {
        SoundEngine.wash();
        animateItemBtn(btn);
        // 不在这里手动设置动画，由 app.js 的 state-change: washing 监听统一处理（QC Clean SWF）
        EffectsEngine.startRain(3500);
        BubbleSystem.show('下雨啦~洗得干干净净！🌧️✨', 3000);
        if (typeof PetDiary !== 'undefined') PetDiary.addEntry('wash', '洗了个舒服的澡，清爽！');
        setTimeout(() => {
          BubbleSystem.show('洗完啦！好清爽！✨', 2000);
          BehaviorEngine.resume();
        }, 3500);
      } else {
        setTimeout(() => BehaviorEngine.resume(), 1000);
      }
      updateInventoryUI();
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

    // 🧩 技能按钮：拉起技能菜单（语音对讲等；翻译入口已在 index.html 屏蔽）
    const btnSkill = document.getElementById('btn-skill');
    if (btnSkill) {
      btnSkill.addEventListener('mouseenter', () => {
        cancelSkillMenuCloseDelay();
      });
      btnSkill.addEventListener('click', (e) => {
        e.stopPropagation();
        BehaviorEngine.notifyInteraction();
        cancelSkillMenuCloseDelay();
        if (!skillModeMenu) return;
        const hidden = skillModeMenu.classList.contains('hidden');
        if (!hidden) {
          skillModeMenu.classList.add('hidden');
          return;
        }
        skillModeMenu.classList.remove('hidden');
        const rect = btnSkill.getBoundingClientRect();
        skillModeMenu.style.left = `${Math.max(8, rect.left - 14)}px`;
        skillModeMenu.style.top = `${Math.max(8, rect.top - 146)}px`;
      });
    }

    async function toggleVoiceBySkill() {
      if (typeof VoiceMode === 'undefined' || !VoiceMode.isSupported) {
        BubbleSystem.show('语音功能不可用', 2200);
        return;
      }
      const nowRecording = await VoiceMode.toggle();
      BubbleSystem.show(nowRecording ? '语音对讲已开启' : '语音对讲已关闭', 1500);
    }

    function setTranslateMode(enabled) {
      translateMode = !!enabled;
      if (typeof BubbleSystem !== 'undefined' && BubbleSystem.setTranslatePriority) {
        BubbleSystem.setTranslatePriority(translateMode);
      }
      if (translateToggleBtn) {
        translateToggleBtn.textContent = `翻译模式：${translateMode ? '开启' : '关闭'}`;
        translateToggleBtn.classList.toggle('active', translateMode);
      }
      if (translatePill) translatePill.classList.toggle('hidden', !translateMode);
      if (selectionPollTimer) {
        clearInterval(selectionPollTimer);
        selectionPollTimer = null;
      }
      if (translateMode) {
        // 划词翻译：轮询前台选中文本（高频短轮询，接近“即时”）
        selectionPollTimer = setInterval(() => {
          triggerTranslateSelection();
        }, 450);
      } else {
        lastSelectionText = '';
      }
      BubbleSystem.showTranslate?.(translateMode ? '翻译模式已开启' : '翻译模式已关闭', 1200);
    }
    translatePill?.addEventListener('click', () => setTranslateMode(false));
    document.addEventListener('mouseup', () => {
      if (translateMode) triggerTranslateSelection();
    }, true);

    if (skillModeMenu) {
      skillModeMenu.querySelectorAll('.voice-mode-item').forEach((item) => {
        item.addEventListener('click', async () => {
          const action = item.dataset.action;
          if (action === 'voice-toggle') {
            await toggleVoiceBySkill();
          } else if (action === 'translate-toggle') {
            setTranslateMode(!translateMode);
          } else if (action === 'meeting-notes') {
            if (window.MeetingNotes?.init && !window.__meetingNotesInitialized) {
              window.MeetingNotes.init();
              window.__meetingNotesInitialized = true;
            }
            document.dispatchEvent(new CustomEvent('meeting-notes:start'));
            const notes = (typeof MeetingNotes !== 'undefined' && MeetingNotes) || window.MeetingNotes;
            if (notes && notes.start) {
              await notes.start();
            } else {
              BubbleSystem.show('录音纪要暂不可用', 1600);
            }
          }
          cancelSkillMenuCloseDelay();
          skillModeMenu.classList.add('hidden');
        });
      });
      // 从技能按钮移动到菜单时，保持菜单可用，并取消「穿透导致的延迟关闭」
      skillModeMenu.addEventListener('mouseenter', () => {
        cancelSkillMenuCloseDelay();
        skillModeMenu.classList.remove('hidden');
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

    // 当窗口进入点击穿透（鼠标离开交互区）时关闭菜单；技能菜单延迟关闭，便于从按钮移到浮动菜单
    document.addEventListener('click-through:ignored', () => {
      if (voiceModeMenu && !voiceModeMenu.classList.contains('hidden')) {
        voiceModeMenu.classList.add('hidden');
      }
      if (skillModeMenu && !skillModeMenu.classList.contains('hidden')) {
        scheduleSkillMenuCloseFromHover();
      }
    });

    if (typeof VoiceMode !== 'undefined' && VoiceMode.onModeChange) {
      VoiceMode.onModeChange(() => {
        syncVoiceIdleLabel();
        updateVoiceMenuActive();
      });
    }
    syncVoiceIdleLabel();

    async function triggerTranslateSelection() {
      if (!translateMode || translating) return;
      const pick = await window.electronAPI?.getFrontSelectedText?.();
      const src = String(pick?.text || '').trim();
      if (!src || src.length < 1 || src === lastSelectionText) return;
      lastSelectionText = src;
      translating = true;
      try {
        if (typeof AIBrain === 'undefined' || !AIBrain.translateDirect) {
          BubbleSystem.showTranslate?.('翻译功能暂不可用', 1400);
          return;
        }
        const translated = await AIBrain.translateDirect(src);
        if (!translated) return;
        BubbleSystem.showTranslate?.(translated, 5200);
      } catch {
        BubbleSystem.showTranslate?.('翻译失败，请检查模型配置', 1600);
      } finally {
        translating = false;
      }
    }

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
      cancelSkillMenuCloseDelay();
      if (skillModeMenu && !skillModeMenu.classList.contains('hidden')) {
        skillModeMenu.classList.add('hidden');
      }
    }

    document.addEventListener('click', (e) => {
      // 关闭语音模式菜单
      if (voiceModeMenu && !e.target.closest('#voice-mode-menu') && !e.target.closest('#btn-skill')) {
        voiceModeMenu.classList.add('hidden');
      }
      if (skillModeMenu && !e.target.closest('#skill-mode-menu') && !e.target.closest('#btn-skill')) {
        cancelSkillMenuCloseDelay();
        skillModeMenu.classList.add('hidden');
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
