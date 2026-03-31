/* ═══════════════════════════════════════════
   应用主入口 - 串联所有模块
   ═══════════════════════════════════════════ */

(function App() {
  'use strict';

  // ─── 快捷对话相关 ───
  let quickChatVisible = false;
  let quickChatTimeout = null;
  let lastOfflineSleepAt = 0;

  // ─── 初始化所有子系统 ───
  function init() {
    console.log('🐧 QQ宠物启动中...');

    // 1. 启动精灵渲染
    SpriteRenderer.start();
    SpriteRenderer.setAnimation('idle');

    // 2. 初始化拖拽
    DragSystem.init();

    // 3. 初始化面板
    PanelManager.init();
    PanelManager.updateInventoryUI();

    // 4. 初始化 AI 对话
    ChatSystem.init();

    // 5. 初始化任务栏
    TaskbarUI.init();
    TaskbarUI.updateBars();

    // 6. 启动系统监控
    SystemMonitor.start();

    // 7. 启动行为引擎（自走、打哈欠、睡觉）
    BehaviorEngine.init();

    // 8. 初始化特效引擎（下雨、踢球、咖啡杯）
    EffectsEngine.init();

    // 9. 初始化快捷对话
    initQuickChat();

    // 10. 初始化番茄钟 Focus Mode
    FocusMode.init();

    // 11. 初始化剪贴板背包
    ClipboardBag.init();

    // 12. 初始化文件拖拽 (Claw AI)
    FileDrop.init();

    // 13. 初始化进程管理器
    ProcessManager.init();

    // 14. 初始化桌面牧羊人
    DesktopShepherd.init();

    // 15. 初始化日记系统
    PetDiary.init();

    // 16. 初始化 Claw AI 联动
    if (typeof ClawBridge !== 'undefined') ClawBridge.init();

    // 17. 初始化右键菜单
    initContextMenu();

    // 17.0 同步"关于"面板版本号（读取本地 app 版本）
    syncAboutVersion();

    // 17.1 初始化系统设置面板
    if (typeof SystemSettings !== 'undefined') {
      SystemSettings.init();
    }

    // 17.1 监听主进程的"打开设置菜单"事件（右键菜单→设置）
    if (window.electronAPI && window.electronAPI.onOpenStartMenu) {
      window.electronAPI.onOpenStartMenu(() => {
        const startMenu = document.getElementById('start-menu');
        if (startMenu && startMenu.classList.contains('hidden')) {
          startMenu.classList.remove('hidden');
          SoundEngine.menuOpen();
        }
      });
    }

    // 更新通知（主进程检测到新版本后推送）
    if (window.electronAPI && window.electronAPI.onUpdateAvailable) {
      window.electronAPI.onUpdateAvailable(({ version }) => {
        BubbleSystem.show(`发现新版本 v${version}，可立即更新`, 4500);
      });
    }

    // 安装进度通知：通过 update-progress（标题+内容）
    if (window.electronAPI && window.electronAPI.onUpdateProgress) {
      window.electronAPI.onUpdateProgress(({ title, message }) => {
        const text = message ? `${title}\n${message}` : title;
        BubbleSystem.showUpdateProgress(text);
      });
    }

    // 安装进度通知：通过 update-bubble（精简文字，直接显示在气泡）
    if (window.electronAPI && window.electronAPI.onUpdateBubble) {
      window.electronAPI.onUpdateBubble(({ text }) => {
        BubbleSystem.showUpdateProgress(text);
      });
    }

    // 18. 初始化 AI 驱动系统（性格 → 记忆 → 大脑 → 主动说话）
    if (typeof Personality !== 'undefined') Personality.init();
    if (typeof PetMemory !== 'undefined') PetMemory.init();
    if (typeof AIBrain !== 'undefined') {
      AIBrain.init();
      // 流式输出：边生成边实时更新气泡文字
      if (AIBrain.onStreamingReply) {
        AIBrain.onStreamingReply((partialText) => {
          BubbleSystem.updateStreamingBubble(partialText);
          // 同步转发给对话终端窗口（流式显示）
          if (window.electronAPI && window.electronAPI.sendQuickChatStreamChunk) {
            window.electronAPI.sendQuickChatStreamChunk(partialText);
          }
        });
      }
      // Agent 工具执行进度：实时展示 agent 正在做什么
      if (AIBrain.onToolProgress) {
        AIBrain.onToolProgress((evt) => {
          BubbleSystem.showToolProgress(evt);
          // 同步转发给对话终端窗口
          if (window.electronAPI && window.electronAPI.sendQuickChatToolProgress) {
            window.electronAPI.sendQuickChatToolProgress(evt);
          }
        });
      }
    }
    if (typeof ProactiveChat !== 'undefined') ProactiveChat.init();

    // 19. 初始化语音模式（Cmd+K 按住说话）
    initVoiceMode();

    // 20. 初始化点击穿透（透明区域穿透点击）
    if (typeof ClickThrough !== 'undefined') ClickThrough.init();

    // 21. 入场动画
    const petContainer = document.getElementById('pet-container');
    petContainer.classList.add('bounce-in');
    setTimeout(() => petContainer.classList.remove('bounce-in'), 700);

    // ─── 事件监听 ───

    // 状态变化 → 同步动画（使用 QC playOnce 机制，动画播完才切换）
    PetState.on('state-change', ({ state }) => {
      const bh = BehaviorEngine.currentBehavior;
      if (bh === BehaviorEngine.BEHAVIOR.WALKING ||
          bh === BehaviorEngine.BEHAVIOR.YAWNING ||
          bh === BehaviorEngine.BEHAVIOR.SLEEPING) {
        return;
      }
      if (FocusMode.isActive && state !== 'error') return;

      const mood = PetState.mood || 'peaceful';

      // 回到 Stand 的通用回调
      function backToStand() {
        const stand = SpriteRenderer.qcLoaded ? SpriteRenderer.getQCStand(mood) : null;
        SpriteRenderer.setAnimation(stand || 'idle');
      }

      if (!SpriteRenderer.qcLoaded) {
        // 无 QC → 走 legacy 映射
        SpriteRenderer.setAnimation(state);
        return;
      }

      switch (state) {
        case 'eating': {
          const anim = SpriteRenderer.getQCCommon('eat');
          if (anim) {
            SpriteRenderer.loadQCSheet(anim).then(() => {
              SpriteRenderer.playOnce(anim, backToStand);
            });
          }
          break;
        }
        case 'washing': {
          const anim = SpriteRenderer.getQCCommon('clean');
          if (anim) {
            SpriteRenderer.loadQCSheet(anim).then(() => {
              SpriteRenderer.playOnce(anim, backToStand);
            });
          }
          break;
        }
        case 'talking': {
          const anim = SpriteRenderer.getQCSpeak(mood);
          if (anim) {
            SpriteRenderer.loadQCSheet(anim).then(() => {
              SpriteRenderer.setAnimation(anim);
            });
          }
          break;
        }
        case 'idle':
        case 'happy':
        case 'sad':
        case 'thinking':
        default:
          // 这些不播一次性动画，直接切 Stand（不打断正在播的）
          SpriteRenderer.setAnimation(SpriteRenderer.getQCStand(mood) || 'idle');
          break;
      }
    });

    // 心情变化 → 切换对应心情的 Stand 动画（含站↔趴过渡）
    PetState.on('mood-change', ({ mood, old }) => {
      console.log('🐧 心情变化:', old, '→', mood);
      if (!SpriteRenderer.qcLoaded) return;
      SpriteRenderer.preloadMoodSheets(mood);

      // ─── happy↔prostrate 过渡动画（复刻原版 Etoj/Jtoc） ───
      // happy → prostrate: 播 Etoj（站→趴），播完切 prostrate-Stand
      // prostrate → happy: 播 Jtoc（趴→站），播完切 happy-Stand
      const isHappyToProstrate = old === 'happy' && mood === 'prostrate';
      const isProstrateToHappy = old === 'prostrate' && mood === 'happy';

      if (isHappyToProstrate) {
        const etoj = SpriteRenderer.getQCCommon('etoj');
        if (etoj) {
          SpriteRenderer.loadQCSheet(etoj).then(() => {
            SpriteRenderer.playOnce(etoj, () => {
              const stand = SpriteRenderer.getQCStand(mood);
              SpriteRenderer.setAnimation(stand || 'idle');
            });
          });
          return;
        }
      } else if (isProstrateToHappy) {
        const jtoc = SpriteRenderer.getQCCommon('jtoc');
        if (jtoc) {
          SpriteRenderer.loadQCSheet(jtoc).then(() => {
            SpriteRenderer.playOnce(jtoc, () => {
              const stand = SpriteRenderer.getQCStand(mood);
              SpriteRenderer.setAnimation(stand || 'idle');
            });
          });
          return;
        }
      }

      // 普通心情切换：直接切 Stand（不打断正在播的）
      const stand = SpriteRenderer.getQCStand(mood);
      if (stand) SpriteRenderer.setAnimation(stand);
    });

    // 每分钟数值衰减
    setInterval(() => {
      PetState.decay();
    }, 60000);

    // 随机冒泡由 ProactiveChat 调度引擎接管（5秒检查一次，AI驱动）

    // 首次入场动画 + 打招呼（AI 驱动；无网络则直接睡眠）
    setTimeout(async () => {
      // ─── 入场动画：从 Enter1/Enter3 随机选一个播放 ───
      if (SpriteRenderer.qcLoaded && SpriteRenderer.QC_COMMON.enter.length > 0) {
        // 只用 Enter1 和 Enter3（Enter2 太简陋）
        const enterPool = SpriteRenderer.QC_COMMON.enter.filter(
          name => name === 'Enter1' || name === 'Enter3'
        );
        const pool = enterPool.length > 0 ? enterPool : SpriteRenderer.QC_COMMON.enter;
        const enterAnim = pool[Math.floor(Math.random() * pool.length)];

        console.log('🐧 播放入场动画:', enterAnim);

        try {
          await SpriteRenderer.loadQCSheet(enterAnim);
          // 播入场动画，播完后切 Stand → 再打招呼
          await new Promise(resolve => {
            SpriteRenderer.playOnce(enterAnim, resolve);
          });
        } catch (e) {
          console.warn('入场动画播放失败:', e);
        }

        // 入场动画播完，切到站姿
        const mood = PetState.mood || 'peaceful';
        const stand = SpriteRenderer.getQCStand(mood);
        SpriteRenderer.setAnimation(stand || 'idle');
      }

      // ─── 打招呼 ───
      if (typeof AIBrain !== 'undefined') {
        try {
          const aiGreeting = await AIBrain.speak('startup_greeting', {
            description: '刚启动，和主人打招呼',
            constraint: '一句自然开场，20-35字，友好简洁，不要卖萌',
          });
          if (aiGreeting) {
            BubbleSystem.show(aiGreeting, 4000);
            SoundEngine.happy();
            return;
          }
        } catch {}
      }
      enterOfflineSleep('没网了，我先睡着了。连上网再叫我。');
    }, 1000);

    console.log('🐧 所有系统就绪！(v3.0 AI驱动主动说话/性格/记忆/情绪)');
  }

  async function syncAboutVersion() {
    const versionEl = document.getElementById('about-version');
    try {
      if (window.electronAPI && window.electronAPI.getAppVersion) {
        const version = await window.electronAPI.getAppVersion();
        if (versionEl) versionEl.textContent = `v${version}`;
        const settingsVersionEl = document.getElementById('settings-version');
        if (settingsVersionEl) settingsVersionEl.textContent = `v${version}`;
        const startMenuVersionEl = document.getElementById('start-menu-version');
        if (startMenuVersionEl) startMenuVersionEl.textContent = `QQ Pet v${version}`;
      }
    } catch (e) {
      console.warn('读取应用版本失败:', e);
    }
  }

  // ─── 右键菜单 ───
  function initContextMenu() {
    const petContainer = document.getElementById('pet-container');
    petContainer.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startMenu = document.getElementById('start-menu');
      if (!startMenu) return;
      const margin = 8;
      startMenu.classList.remove('hidden');
      const rect = startMenu.getBoundingClientRect();
      const maxLeft = window.innerWidth - rect.width - margin;
      const maxTop = window.innerHeight - rect.height - margin;
      // 优先贴近状态栏（hover-panel）右侧展示，尽量不挡住宠物主体
      let left = e.clientX;
      let top = e.clientY;
      const hoverPanel = document.getElementById('hover-panel');
      if (hoverPanel) {
        const hp = hoverPanel.getBoundingClientRect();
        if (hp && hp.width > 0 && hp.height > 0) {
          const rightCandidate = hp.right + 10;
          const leftCandidate = hp.left - rect.width - 10;
          if (rightCandidate <= maxLeft) {
            left = rightCandidate;
          } else if (leftCandidate >= margin) {
            left = leftCandidate;
          }
          top = hp.bottom - rect.height;
        }
      }
      left = Math.max(margin, Math.min(left, maxLeft));
      top = Math.max(margin, Math.min(top, maxTop));
      startMenu.style.left = `${left}px`;
      startMenu.style.top = `${top}px`;
      if (typeof SoundEngine !== 'undefined') {
        SoundEngine.menuOpen();
      }
    });
  }

  // ─── 互动随机回复（单击企鹅时） ───
  const patReplies = [
    '嗯？怎么啦~🐧',
    '主人找我有事吗？',
    '在呢在呢~✨',
    '嘿！别拍我啦 😆',
    '有什么吩咐？🐧',
    '诶嘿~被发现了！',
    '主人好~👋',
    '干嘛干嘛~🐧💦',
    '我在听呢！',
    '又来逗我玩~😏',
    '嗯哼？👀',
    '主人想我了吧~😊',
  ];

  // ─── 抚摸随机回复 ───
  const strokeReplies = [
    '好舒服~继续摸~😊',
    '嗯嗯…好痒好痒🤭',
    '咕噜咕噜~💕',
    '主人的手好温暖✨',
    '再摸摸这里~🐧',
    '开心！💖',
    '别停嘛~😆',
    '幸福~🥰',
  ];

  // ─── 抚摸检测状态 ───
  let strokeTimer = null;
  let strokeStartAt = 0;
  let strokeTriggered = false;
  let lastStrokeTime = 0;
  const STROKE_MIN_DURATION_MS = 1000;  // 连续抚摸1秒触发
  const STROKE_SESSION_GAP_MS = 450;   // 超过该间隔无移动视为抚摸中断
  const STROKE_COOLDOWN = 3000;        // 抚摸冷却 3s
  const STROKE_HIT_SHRINK_FACTOR = 1.3; // 抚摸热区缩小 1.3 倍，减少误触
  let isMouseDownOnPet = false;     // 记录鼠标是否按下（按下时不算抚摸）

  // ─── 语音模式（Cmd+K 按住说话 / 按钮切换） ───
  let voiceListeningBubble = null;  // 聆听中的气泡引用

  async function initVoiceMode() {
    if (typeof VoiceMode === 'undefined') {
      console.warn('🎤 VoiceMode 模块未加载，语音功能禁用');
      return;
    }

    await VoiceMode.init();

    if (!VoiceMode.isSupported) {
      console.warn('🎤 浏览器不支持语音功能');
      return;
    }

    if (!VoiceMode.asrAvailable) {
      console.warn('🎤 ASR 引擎不可用');
      // 不 return，让用户可以看到错误提示
    }

    // ─── 流式中间结果：实时显示正在说的话（屏幕中下方字幕） ───
    VoiceMode.onStreaming((text) => {
      if (text && text.trim()) {
        // 底部字幕显示流式识别文字
        BubbleSystem.showSubtitle(text.trim());
      } else {
        // 无有效流式文本时，及时收起字幕框，避免长时间占屏
        BubbleSystem.hideSubtitle();
      }
    });

    // ─── realtime 模式：每句 VAD 分段送出后，立即清空字幕，准备显示下一句 ───
    if (VoiceMode.onSegment) {
      VoiceMode.onSegment(() => {
        BubbleSystem.hideSubtitle();
      });
    }

    // ─── 开始录音 ───
    VoiceMode.onStart(() => {
      console.log('🎤 进入聆听模式 (腾讯云 ASR)');
      SoundEngine.voiceStart();

      // 通知主进程
      if (window.electronAPI && window.electronAPI.notifyVoiceStart) {
        window.electronAPI.notifyVoiceStart();
      }

      // 暂停行为引擎（站定不动）
      BehaviorEngine.pause();
      BehaviorEngine.notifyInteraction();

      // 企鹅进入聆听动画
      SpriteRenderer.setAnimation('happy');

      // 宠物头顶显示 "我在听呢" 气泡
      BubbleSystem.show('我在听呢', 60000);
    });

    // ─── 停止录音 → 等待最终识别结果 ───
    VoiceMode.onStop(() => {
      console.log('🎤 停止录音，等待最终识别结果...');
      SoundEngine.voiceStop();

      // 通知主进程
      if (window.electronAPI && window.electronAPI.notifyVoiceStop) {
        window.electronAPI.notifyVoiceStop();
      }

      // 隐藏底部字幕（保留到最终结果出来）
      // 注意：不立即隐藏字幕，等 onResult 拿到最终文字后再隐藏

      // 隐藏头顶的「我在听呢」气泡
      BubbleSystem.hide();

      // 重置语音对讲按钮状态
      resetVoiceButton();
    });

    // ─── 识别结果：送入 AI 对话流程 ───
    VoiceMode.onResult((text) => {
      console.log('🎤 语音识别结果:', text);

      // 隐藏底部字幕
      BubbleSystem.hideSubtitle();
      // 隐藏语音识别气泡（旧版兼容）
      BubbleSystem.hideVoiceRecognizing();

      // realtime 模式下不清空气泡（"我在听呢"要保留，让用户知道还在聆听）
      // single 模式下才清空
      if (!VoiceMode.isRecording || VoiceMode.mode !== VoiceMode.MODE_REALTIME) {
        BubbleSystem.hide();
      }

      if (!text || text.trim().length === 0) {
        // 没有有效内容，恢复正常
        BubbleSystem.show('啥也没听到...再说一次?', 3000);
        SpriteRenderer.setAnimation('idle');
        BehaviorEngine.resume();
        return;
      }

      // 语音识别结果送入 AI 对话（带语音标记）
      // realtime 模式下用队列串行处理，避免并发互相覆盖
      enqueueVoiceMessage(text.trim());
    });

    // ─── 错误处理 ───
    VoiceMode.onError((error) => {
      console.warn('🎤 语音识别错误:', error);
      SoundEngine.voiceError();
      BubbleSystem.hide();
      BubbleSystem.hideSubtitle();

      // 重置语音对讲按钮状态
      resetVoiceButton();

      let errMsg = '听不清楚...';
      if (error === 'not-supported') {
        errMsg = '语音功能不可用';
      } else if (error === 'mic-denied') {
        errMsg = '🎤 麦克风权限未开启\n请到「系统设置 → 隐私与安全性 → 麦克风」中开启';
        // 尝试自动打开系统偏好设置
        if (window.electronAPI?.openMicSystemPrefs) {
          window.electronAPI.openMicSystemPrefs();
        }
      } else if (error === 'not-allowed' || error === 'permission-denied') {
        errMsg = '🎤 需要麦克风权限\n请在系统设置中允许访问麦克风';
        if (window.electronAPI?.openMicSystemPrefs) {
          window.electronAPI.openMicSystemPrefs();
        }
      } else if (error === 'asr-unavailable') {
        errMsg = '语音服务不可用，请检查网络或腾讯云配置';
      } else if (error === 'transcription-error') {
        errMsg = '语音识别出错了';
      } else if (error === 'start-failed') {
        errMsg = '语音启动失败';
      }

      BubbleSystem.show(errMsg, 3000);
      SpriteRenderer.setAnimation('idle');
      BehaviorEngine.resume();
    });

    console.log('🎤 语音模式就绪 (点击按钮 / 按 Cmd+K 切换聆听模式)');

    // ─── 监听全局快捷键 Cmd+K（从主进程 IPC 发来） ───
    if (window.electronAPI && window.electronAPI.onToggleVoiceMode) {
      window.electronAPI.onToggleVoiceMode(async () => {
        console.log('⌨️ 收到全局 Cmd+K → 切换语音模式');
        const result = await VoiceMode.toggle();
        // 同步按钮 UI
        const btnVoice = document.getElementById('btn-voice');
        const voiceIcon = document.getElementById('voice-icon');
        const voiceLabel = document.getElementById('voice-label');
        if (result) {
          // 开始录音
          if (btnVoice) btnVoice.classList.add('recording');
          if (voiceIcon) voiceIcon.textContent = '\u25A0';  // ■ 停止
          if (voiceLabel) voiceLabel.textContent = '停止';
        }
        // 停止录音的 UI 重置在 onStop 回调中已处理
      });
    }
  }

  function resetVoiceButton() {
    const btnVoice = document.getElementById('btn-voice');
    const voiceIcon = document.getElementById('voice-icon');
    const voiceLabel = document.getElementById('voice-label');
    if (btnVoice) btnVoice.classList.remove('recording');
    if (voiceIcon) voiceIcon.textContent = '\u25CF';  // ● 圆点
    if (voiceLabel) {
      const label = (typeof VoiceMode !== 'undefined' && VoiceMode.mode === VoiceMode.MODE_REALTIME)
        ? '实时通话'
        : '语音对讲';
      voiceLabel.textContent = label;
    }
  }

  // ─── 快捷对话系统 ───
  function initQuickChat() {
    const quickChat = document.getElementById('quick-chat');
    const quickInput = document.getElementById('quick-chat-input');
    const quickSend = document.getElementById('quick-chat-send');
    const petContainer = document.getElementById('pet-container');

    // 单击企鹅 → 互动（AI驱动回复 + 情绪联动）
    petContainer.addEventListener('click', (e) => {
      if (DragSystem.isDragging) return;
      if (document.body.classList.contains('soap-cursor')) return;

      // 如果吸附在边缘，点击恢复
      if (typeof EdgeSnap !== 'undefined' && EdgeSnap.isSnapped) {
        EdgeSnap.unsnap();
        return;
      }

      BehaviorEngine.notifyInteraction();

      // 如果对话框开着，不处理互动
      if (quickChatVisible) return;

      // 通知互动系统
      if (typeof ProactiveChat !== 'undefined') ProactiveChat.notifyInteraction();
      if (typeof Personality !== 'undefined') Personality.onEvent('interacted');
      if (typeof PetMemory !== 'undefined') PetMemory.addEvent('interacted', '主人拍了拍我~');

      // 互动：播放 QC 互动动画（播完一遍自动回 Stand）
      SoundEngine.happy();
      const patMood = PetState.mood || 'peaceful';
      const patAnim = SpriteRenderer.qcLoaded ? SpriteRenderer.getQCInteract(patMood) : null;
      if (patAnim) {
        SpriteRenderer.loadQCSheet(patAnim).then(() => {
          SpriteRenderer.playOnce(patAnim, () => {
            const stand = SpriteRenderer.getQCStand(patMood);
            SpriteRenderer.setAnimation(stand || 'idle');
          });
        });
      } else {
        SpriteRenderer.forceSetAnimation('happy_jump');
      }

      // 尝试 AI 生成互动回复，失败降级到本地台词
      if (typeof AIBrain !== 'undefined') {
        AIBrain.speak('interacted', {
          description: '主人拍了拍宠物，想互动',
            constraint: '一句简短互动回应，可以是打招呼/撒娇/卖萌/吐槽，15-30字，自然随意',
          }).then(reply => {
            if (reply) {
              BubbleSystem.show(reply, 2500);
            } else {
              enterOfflineSleep('没网了，我先睡着了。连上网再聊。');
            }
        });
      } else {
          enterOfflineSleep('没网了，我先睡着了。');
      }

      if (typeof PetDiary !== 'undefined') PetDiary.addEntry('interact', '主人拍了拍我~');
    });

    // ─── 抚摸检测：鼠标在宠物上滑动（无点击） ───
    petContainer.addEventListener('mousedown', () => { isMouseDownOnPet = true; });
    document.addEventListener('mouseup', () => { isMouseDownOnPet = false; });

    function resetStrokeSession() {
      strokeStartAt = 0;
      strokeTriggered = false;
    }

    function isInStrokeZone(e) {
      const rect = petContainer.getBoundingClientRect();
      const scale = 1 / STROKE_HIT_SHRINK_FACTOR;
      const insetX = (rect.width * (1 - scale)) / 2;
      const insetY = (rect.height * (1 - scale)) / 2;
      return (
        e.clientX >= rect.left + insetX &&
        e.clientX <= rect.right - insetX &&
        e.clientY >= rect.top + insetY &&
        e.clientY <= rect.bottom - insetY
      );
    }

    petContainer.addEventListener('mouseleave', () => {
      clearTimeout(strokeTimer);
      resetStrokeSession();
    });

    petContainer.addEventListener('mousemove', (e) => {
      // 拖拽中、鼠标按下、肥皂模式、吸附状态 → 不算抚摸
      if (DragSystem.isDragging || isMouseDownOnPet || document.body.classList.contains('soap-cursor')
          || (typeof EdgeSnap !== 'undefined' && EdgeSnap.isSnapped)) {
        clearTimeout(strokeTimer);
        resetStrokeSession();
        return;
      }

      if (!isInStrokeZone(e)) {
        clearTimeout(strokeTimer);
        resetStrokeSession();
        return;
      }

      const now = Date.now();
      // 冷却中
      if (now - lastStrokeTime < STROKE_COOLDOWN) return;

      clearTimeout(strokeTimer);
      strokeTimer = setTimeout(() => { resetStrokeSession(); }, STROKE_SESSION_GAP_MS);

      if (!strokeStartAt) strokeStartAt = now;
      if (strokeTriggered) return;

      if (now - strokeStartAt >= STROKE_MIN_DURATION_MS) {
        strokeTriggered = true;
        lastStrokeTime = now;

        BehaviorEngine.notifyInteraction();

        // 通知互动系统
        if (typeof ProactiveChat !== 'undefined') ProactiveChat.notifyInteraction();
        if (typeof Personality !== 'undefined') Personality.onEvent('stroked');
        if (typeof PetMemory !== 'undefined') PetMemory.addEvent('stroked', '被主人抚摸了~');

        // 抚摸动画：用当前心情的 H1/H5，playOnce 会先打断当前动画
        if (SpriteRenderer.qcLoaded) {
          const m2mood = PetState.mood || 'peaceful';
          const strokeAnim = SpriteRenderer.getQCStroke(m2mood);
          if (strokeAnim) {
            BehaviorEngine.pause();
            SpriteRenderer.playOnce(strokeAnim, () => {
              const stand = SpriteRenderer.getQCStand(m2mood);
              SpriteRenderer.setAnimation(stand || 'idle');
              BehaviorEngine.resume();
            });
          }
        } else {
          SpriteRenderer.forceSetAnimation('happy');
        }

        // 连续抚摸 2 秒后，仅 50% 概率说话，降低打扰
        if (Math.random() < 0.5 && typeof AIBrain !== 'undefined') {
          AIBrain.speak('stroked', {
            description: '被主人抚摸了',
            constraint: '一句自然反馈，15-30字，语气温和，不要幼态化',
          }).then(reply => {
            if (reply) BubbleSystem.show(reply, 2000);
          }).catch(() => {});
        }

        // 抚摸增加清洁值一点点
        PetState.setStat('clean', PetState.stats.clean + 2);
        if (typeof PetDiary !== 'undefined') PetDiary.addEntry('stroke', '被主人温柔地抚摸了~');
      }
    });

    // 本地快捷键（默认 cmd/ctrl+u，可在系统设置中自定义）
    document.addEventListener('keydown', (e) => {
      if (matchesShortcut(e, 'talk')) {
        e.preventDefault();
        BehaviorEngine.notifyInteraction();
        // Electron 环境 → 调用主进程打开屏幕居中独立窗口
        if (window.electronAPI && window.electronAPI.openQuickChat) {
          window.electronAPI.openQuickChat();
        } else {
          // 非 Electron 降级到内嵌对话框
          if (quickChatVisible) {
            hideQuickChat();
          } else {
            showQuickChat();
          }
        }
      }
    });

    quickSend.addEventListener('click', () => {
      sendQuickMessage();
    });

    quickInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && quickInput.value.trim()) {
        sendQuickMessage();
      }
      if (e.key === 'Escape') {
        hideQuickChat();
      }
    });

    quickChat.addEventListener('click', (e) => {
      e.stopPropagation();
    });

    document.addEventListener('click', (e) => {
      if (quickChatVisible &&
          !e.target.closest('#quick-chat') &&
          !e.target.closest('#pet-container') &&
          !e.target.closest('#btn-talk')) {
        hideQuickChat();
      }
    });

    // 对讲按钮通过自定义事件打开对话框
    document.addEventListener('open-quick-chat', () => {
      // Electron 环境 → 调用主进程打开屏幕居中独立窗口
      if (window.electronAPI && window.electronAPI.openQuickChat) {
        window.electronAPI.openQuickChat();
      } else if (!quickChatVisible) {
        showQuickChat();
      }
    });

    // 全局快捷键（从主进程通过 IPC 发来）— 已改为屏幕居中独立窗口
    // 保留旧的 toggle-quick-chat 作为兜底（非 Electron 环境）
    if (window.electronAPI && window.electronAPI.onToggleQuickChat) {
      window.electronAPI.onToggleQuickChat(() => {
        // Electron 环境下由主进程处理，不再使用内嵌对话框
        // 如果需要兜底，可以启用下面的逻辑
        // if (quickChatVisible) { hideQuickChat(); } else { showQuickChat(); }
      });
    }

    // ─── 屏幕居中快捷对话窗口通信 ───
    if (window.electronAPI && window.electronAPI.onQuickChatMessage) {
      // 接收来自独立快捷对话窗口的消息
      window.electronAPI.onQuickChatMessage(({ text, attachments = [] }) => {
        if (!text) return;
        handleQuickChatMessage(text, attachments);
      });
    }
    if (window.electronAPI && window.electronAPI.onQuickChatOpened) {
      window.electronAPI.onQuickChatOpened(() => {
        BehaviorEngine.pause();
      });
    }
    if (window.electronAPI && window.electronAPI.onQuickChatClosed) {
      window.electronAPI.onQuickChatClosed(() => {
        BehaviorEngine.resume();
      });
    }

    // ─── Skill 配置对话引导 ───
    if (window.electronAPI && window.electronAPI.onSkillConfigureChat) {
      window.electronAPI.onSkillConfigureChat(({ skillId, skillName }) => {
        const displayName = skillName || skillId || '这个技能';

        // 企鹅先冒泡提示，进入思考动画
        BubbleSystem.show(`好的，我来查一下「${displayName}」怎么用～`, 3000);
        SpriteRenderer.setAnimation('thinking');
        SoundEngine.click();

        // 模拟用户发送的消息文本
        const userQuery = `教我怎么使用「${displayName}」这个 skill，包括如何配置和触发方式`;

        // 打开对话窗口，然后模拟用户发消息 + 触发 AI 真正处理
        setTimeout(() => {
          if (window.electronAPI && window.electronAPI.openQuickChat) {
            window.electronAPI.openQuickChat();
          }
          setTimeout(() => {
            // 在对话窗口显示用户气泡
            if (window.electronAPI && window.electronAPI.sendQuickChatUserMsg) {
              window.electronAPI.sendQuickChatUserMsg(userQuery);
            }
            // 触发 AI Brain 真正去查阅 skill 并回答
            handleQuickChatMessage(userQuery);
          }, 500);
        }, 600);
      });
    }
  }

  function matchesShortcut(e, type) {
    const fallbackKey = type === 'voice' ? 'k' : 'u';
    let shortcut = `CommandOrControl+${fallbackKey.toUpperCase()}`;
    if (typeof SystemSettings !== 'undefined' && SystemSettings.getState) {
      shortcut = SystemSettings.getState()?.shortcuts?.[type] || shortcut;
    }
    const m = String(shortcut).match(/^CommandOrControl\+([A-Z])$/i);
    if (!m) return false;
    const key = m[1].toLowerCase();
    return (e.metaKey || e.ctrlKey) && String(e.key || '').toLowerCase() === key;
  }

  function showQuickChat() {
    const quickChat = document.getElementById('quick-chat');
    const quickInput = document.getElementById('quick-chat-input');
    quickChat.classList.remove('hidden');
    quickChatVisible = true;
    quickInput.value = '';

    // 将对话框定位到屏幕中央（不再跟随企鹅头顶）
    positionQuickChatCenter();

    setTimeout(() => quickInput.focus(), 100);

    BehaviorEngine.pause();

    clearTimeout(quickChatTimeout);
    quickChatTimeout = setTimeout(() => {
      if (quickChatVisible) hideQuickChat();
    }, 30000);
  }

  // 将对话框定位到屏幕中央
  function positionQuickChatCenter() {
    const quickChat = document.getElementById('quick-chat');
    // 固定居中，不再跟随企鹅位置
    quickChat.style.left = '50%';
    quickChat.style.top = '50%';
    quickChat.style.transform = 'translate(-50%, -50%)';
  }

  function hideQuickChat() {
    const quickChat = document.getElementById('quick-chat');
    quickChat.classList.add('hidden');
    quickChatVisible = false;
    clearTimeout(quickChatTimeout);

    BehaviorEngine.resume();
  }

  function sendQuickMessage() {
    const quickInput = document.getElementById('quick-chat-input');
    const text = quickInput.value.trim();
    if (!text) return;

    quickInput.value = '';
    SoundEngine.click();

    // 立即关闭对话框
    hideQuickChat();

    // 通知互动系统
    if (typeof ProactiveChat !== 'undefined') ProactiveChat.notifyInteraction();
    if (typeof Personality !== 'undefined') Personality.onEvent('chat');

    // 企鹅进入思考状态：站定不动 + 思考动画 + 「...」气泡
    BehaviorEngine.pause();
    PetState.setState(PetState.STATES.THINKING, 30000);
    SpriteRenderer.setAnimation('thinking');
    BubbleSystem.showThinking();

    ChatSystem.addLine(text, 'user');
    if (typeof PetDiary !== 'undefined') PetDiary.addEntry('chat', `和主人聊天: "${text.substring(0, 20)}${text.length > 20 ? '...' : ''}"`);
    if (typeof PetMemory !== 'undefined') {
      PetMemory.addDialogue('user', text);
      PetMemory.addEvent('chat', `和主人聊天: "${text.substring(0, 20)}"`);
    }

    // 异步获取回复，通过气泡展示
    getQuickReply(text).then(reply => {
      if (!reply) {
        enterOfflineSleep('没网了，我先睡着了。连上网再继续。');
        ChatSystem.addLine('[系统] 无网络或模型不可用，宠物已睡眠', 'system');
        return;
      }
      PetState.setState(PetState.STATES.TALKING, 3000);
      SpriteRenderer.setAnimation('talking');
      BubbleSystem.showAIReply(reply);
      SoundEngine.aiReply();
      ChatSystem.addLine(reply, 'ai');

      if (typeof PetMemory !== 'undefined') {
        PetMemory.addDialogue('assistant', reply);
      }

      // 异步提取记忆（不阻塞 UI）
      if (typeof AIBrain !== 'undefined') {
        const convo = `用户: ${text}\n宠物: ${reply}`;
        AIBrain.summarizeForMemory(convo).then(memories => {
          if (memories && typeof PetMemory !== 'undefined') {
            memories.forEach(m => PetMemory.addImportantConversation(m));
          }
        });
      }

      setTimeout(() => {
        PetState.autoState();
        BehaviorEngine.resume();
      }, 3000);
    });
  }

  // ─── 处理来自屏幕居中快捷对话窗口的消息 ───
  async function handleQuickChatMessage(text, attachments = []) {
    SoundEngine.click();

    // 通知互动系统
    if (typeof ProactiveChat !== 'undefined') ProactiveChat.notifyInteraction();
    if (typeof Personality !== 'undefined') Personality.onEvent('chat');

    // 企鹅进入思考状态
    BehaviorEngine.pause();
    PetState.setState(PetState.STATES.THINKING, 30000);
    SpriteRenderer.setAnimation('thinking');
    BubbleSystem.showThinking();

    const attachmentHint = attachments.length > 0 ? ` [附件${attachments.length}]` : '';
    ChatSystem.addLine(`${text}${attachmentHint}`, 'user');
    if (typeof PetDiary !== 'undefined') PetDiary.addEntry('chat', `和主人聊天: "${text.substring(0, 20)}${text.length > 20 ? '...' : ''}"${attachmentHint}`);
    if (typeof PetMemory !== 'undefined') {
      PetMemory.addDialogue('user', `${text}${attachmentHint}`);
      PetMemory.addEvent('chat', `和主人聊天: "${text.substring(0, 20)}"`);
    }

    // 异步获取回复（复杂任务优先委托 WorkBuddy 本体）
    getRoutedReply(text, attachments).then(reply => {
      if (!reply) {
        enterOfflineSleep('没网了，我先睡着了。连上网再叫醒我。');
        ChatSystem.addLine('[系统] 无网络或模型不可用，宠物已睡眠', 'system');
        if (window.electronAPI && window.electronAPI.sendQuickChatReply) {
          window.electronAPI.sendQuickChatReply('网络不可用，我先睡着了。联网后再叫我继续处理。');
        }
        return;
      }
      PetState.setState(PetState.STATES.TALKING, 3000);
      SpriteRenderer.setAnimation('talking');
      BubbleSystem.showAIReply(reply);
      SoundEngine.aiReply();
      ChatSystem.addLine(reply, 'ai');

      // 转发 AI 回复给对话终端窗口
      if (window.electronAPI && window.electronAPI.sendQuickChatReply) {
        window.electronAPI.sendQuickChatReply(reply);
      }

      if (typeof PetMemory !== 'undefined') {
        PetMemory.addDialogue('assistant', reply);
      }

      if (typeof AIBrain !== 'undefined') {
        const convo = `用户: ${text}${attachmentHint}\n宠物: ${reply}`;
        AIBrain.summarizeForMemory(convo).then(memories => {
          if (memories && typeof PetMemory !== 'undefined') {
            memories.forEach(m => PetMemory.addImportantConversation(m));
          }
        });
      }

      setTimeout(() => {
        PetState.autoState();
        BehaviorEngine.resume();
      }, 3000);
    });
  }

  // ─── 语音消息队列（realtime 模式串行处理，避免并发覆盖状态） ───
  const voiceMessageQueue = [];
  let voiceQueueProcessing = false;

  function enqueueVoiceMessage(text) {
    voiceMessageQueue.push(text);
    if (!voiceQueueProcessing) {
      processVoiceQueue();
    }
  }

  async function processVoiceQueue() {
    if (voiceQueueProcessing || voiceMessageQueue.length === 0) return;
    voiceQueueProcessing = true;
    while (voiceMessageQueue.length > 0) {
      const text = voiceMessageQueue.shift();
      await handleVoiceMessage(text);
    }
    voiceQueueProcessing = false;
  }

  // ─── 处理语音对讲消息（ASR 结果 → 对话 + AI 回复） ───
  async function handleVoiceMessage(text) {
    SoundEngine.click();

    // 通知互动系统
    if (typeof ProactiveChat !== 'undefined') ProactiveChat.notifyInteraction();
    if (typeof Personality !== 'undefined') Personality.onEvent('chat');

    // [已移除] 语音结束后不再自动打开对话终端窗口

    // 企鹅进入思考状态
    BehaviorEngine.pause();
    PetState.setState(PetState.STATES.THINKING, 30000);
    SpriteRenderer.setAnimation('thinking');
    BubbleSystem.showThinking();

    // 在对话窗口中标注语音来源
    ChatSystem.addLine(`[语音] ${text}`, 'user');
    if (typeof PetDiary !== 'undefined') PetDiary.addEntry('voice_chat', `语音对讲: "${text.substring(0, 20)}${text.length > 20 ? '...' : ''}"`);
    if (typeof PetMemory !== 'undefined') {
      PetMemory.addDialogue('user', text);
      PetMemory.addEvent('voice_chat', `语音对讲: "${text.substring(0, 20)}"`);
    }

    // 异步获取回复（流式输出：getQuickReply → chat() → 边生成边通过 updateStreamingBubble 更新气泡）
    const reply = await getQuickReply(text);
    if (!reply) {
      enterOfflineSleep('没网了，我先睡着了。连上网再继续语音对讲。');
      ChatSystem.addLine('[系统] 无网络或模型不可用，宠物已睡眠', 'system');
      return;
    }
    PetState.setState(PetState.STATES.TALKING, 3000);
    SpriteRenderer.setAnimation('talking');
    BubbleSystem.showAIReply(reply);
    SoundEngine.aiReply();
    ChatSystem.addLine(reply, 'ai');

    if (typeof PetMemory !== 'undefined') {
      PetMemory.addDialogue('assistant', reply);
    }

    if (typeof AIBrain !== 'undefined') {
      const convo = `用户(语音): ${text}\n宠物: ${reply}`;
      AIBrain.summarizeForMemory(convo).then(memories => {
        if (memories && typeof PetMemory !== 'undefined') {
          memories.forEach(m => PetMemory.addImportantConversation(m));
        }
      });
    }

    // realtime 模式下不 resume（保持聆听态），single 模式才恢复
    if (!VoiceMode.isRecording || VoiceMode.mode !== VoiceMode.MODE_REALTIME) {
      setTimeout(() => {
        PetState.autoState();
        BehaviorEngine.resume();
      }, 3000);
    }
  }

  // ─── 快捷对话的多轮历史（保留最近 10 轮） ───
  const quickChatHistory = [];

  async function getRoutedReply(text, attachments = []) {
    if (shouldDelegateToWorkBuddy(text, attachments)) {
      const delegated = await getWorkBuddyReply(text, attachments);
      if (delegated) return delegated;
    }
    return getQuickReply(text, attachments);
  }

  async function getQuickReply(text, attachments = []) {
    try {
      // 优先通过 AIBrain（带性格/记忆/情绪 prompt）
      if (typeof AIBrain !== 'undefined') {
        const reply = await AIBrain.chat(text, quickChatHistory, { attachments });
        // 记录到历史
        const attachmentDesc = buildAttachmentSummary(attachments);
        const userText = attachmentDesc ? `${text}\n${attachmentDesc}` : text;
        quickChatHistory.push({ role: 'user', text: userText });
        quickChatHistory.push({ role: 'assistant', text: reply });
        while (quickChatHistory.length > 20) quickChatHistory.shift();
        return reply;
      }
      return null;
    } catch {
      return null;
    }
  }

  function buildAttachmentSummary(attachments = []) {
    if (!attachments.length) return '';
    const lines = attachments.map((att, i) => {
      const kind = att.type === 'image' ? '图片' : '文件';
      return `${i + 1}. ${kind}: ${att.name || '未命名'} (${att.path || '无路径'})`;
    });
    return `用户附带了 ${attachments.length} 个附件：\n${lines.join('\n')}`;
  }

  function shouldDelegateToWorkBuddy(text, attachments = []) {
    if (attachments.length > 0) return true;
    const t = (text || '').toLowerCase();
    const keywords = [
      '帮我实现', '帮我修改', '写代码', '调试', '报错', '修复',
      '优化', '重构', '设计方案', '分析', '排查', '部署', '脚本',
      'run', 'build', 'test', 'debug', 'refactor', 'implement',
    ];
    return keywords.some(k => t.includes(k));
  }

  async function getWorkBuddyReply(text, attachments = []) {
    try {
      if (!window.electronAPI || !window.electronAPI.delegateToWorkBuddy) return null;
      const attachmentSummary = buildAttachmentSummary(attachments);
      const result = await window.electronAPI.delegateToWorkBuddy({
        userText: text,
        attachmentSummary,
        history: quickChatHistory.slice(-20),
      });
      if (!result || !result.ok || !result.reply) return null;
      return `我把这件复杂任务交给主执行引擎处理了，结果如下：\n${result.reply}`;
    } catch (e) {
      return null;
    }
  }

  function enterOfflineSleep(message = '没网了，我先睡着了。') {
    const now = Date.now();
    if (now - lastOfflineSleepAt < 20000) return;
    lastOfflineSleepAt = now;
    BubbleSystem.hideThinking();
    PetState.setState(PetState.STATES.SLEEPING, 600000);
    SpriteRenderer.setAnimation('sleeping');
    BubbleSystem.show(message, 4500);
  }

  // 等待 DOM 加载完成
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
