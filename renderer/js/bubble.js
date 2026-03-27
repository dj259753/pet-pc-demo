/* ═══════════════════════════════════════════
   气泡弹窗系统（多条堆叠版）
   - 最多显示 3 条最近消息
   - 最新在下方，旧消息在上方变淡
   - 超过 50 字截断 + 箭头，点击跳 CMD 对话
   ═══════════════════════════════════════════ */

const BubbleSystem = (() => {
  const stackEl = document.getElementById('bubble-stack');
  const listEl = document.getElementById('bubble-list');

  const MAX_VISIBLE = 3;     // 最多同时显示 3 条
  const MAX_CHARS = 100;     // 超过 100 字截断
  const DEFAULT_DURATION = 6000;  // 默认显示时长
  const FADE_DURATION = 8000;     // 旧消息额外存活时长
  const THROTTLE_MS = 3000;       // 全局节流：3秒内只允许1条新消息

  let hideTimer = null;      // 全部隐藏的定时器
  let typeTimer = null;      // 打字机定时器
  let thinkingInterval = null;
  let lastShowTime = 0;      // 上次 show() 的时间戳
  let pendingText = null;    // 节流期间暂存的消息
  let pendingTimer = null;   // 节流延迟定时器

  // 消息队列（每条 { text, fullText, el, timer } ）
  const messages = [];

  // ─── 随机台词库 ───
  const PHRASES = {
    idle: [
      '今天天气真好呀~',
      '主人在忙什么呢？',
      '好无聊，陪我玩嘛！',
      '嘿嘿，我是你的小企鹅~',
      '(打哈欠) 有点困了...',
      '想吃饼干了...',
    ],
    hungry: [
      '肚子好饿啊...🍪',
      '主人！快给我吃的！',
      '再不喂我就要饿晕啦！',
      '我闻到了饼干的味道...',
    ],
    dirty: [
      '身上好痒，需要洗澡了...',
      '我已经很脏了啦！🧼',
      '请用肥皂帮我搓搓~',
      '不洗澡的企鹅不是好企鹅！',
    ],
    tired: [
      '好累啊，需要咖啡☕',
      '精力不够了...',
      '让我休息一下嘛...',
      '(瞌睡中) Zzz...',
    ],
    happy: [
      '太开心啦！🎉',
      '嘿嘿嘿，谢谢主人！',
      '今天也要加油鸭！',
      '❤️ 最喜欢你了！',
    ],
    working: [
      '电脑在拼命运转...💦',
      'CPU 好热啊，我来帮你看着！',
      '主人在忙，我也假装工作...',
      '嗡嗡嗡...系统高负荷运行中',
    ],
    thinking: [
      '让我想想...🤔',
      '正在思考中...',
      '这个问题很有趣呢...',
    ],
  };

  // ─── 创建一条气泡 DOM ───
  function createBubbleEl(displayText, fullText, isExpandable, isTruncated = false) {
    const item = document.createElement('div');
    item.className = 'bubble-item';
    if (isExpandable) item.classList.add('expandable');

    const textSpan = document.createElement('span');
    textSpan.className = 'bubble-text-content';
    if (isTruncated) textSpan.classList.add('truncated');
    textSpan.textContent = displayText;
    item.appendChild(textSpan);

    if (isExpandable) {
      const arrow = document.createElement('span');
      arrow.className = 'bubble-arrow';
      arrow.textContent = '›';
      item.appendChild(arrow);

      // 点击可展开气泡 → 打开 CMD 终端面板
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        if (typeof PanelManager !== 'undefined' && PanelManager.togglePanel) {
          PanelManager.togglePanel('chat');
        }
      });
    }

    return { el: item, textSpan };
  }

  // ─── 截断文本 ───
  function truncate(text) {
    if (text.length <= MAX_CHARS) return { display: text, truncated: false };
    return { display: text.substring(0, MAX_CHARS), truncated: true };
  }

  // ─── 更新旧消息样式（变淡） ───
  function updateFadeStyles() {
    messages.forEach((msg, i) => {
      if (i < messages.length - 1) {
        msg.el.classList.add('faded');
      } else {
        msg.el.classList.remove('faded');
      }
    });
  }

  // ─── 移除一条消息 ───
  function removeMessage(msg) {
    const idx = messages.indexOf(msg);
    if (idx !== -1) messages.splice(idx, 1);
    if (msg.el && msg.el.parentNode) msg.el.remove();
    if (msg.timer) clearTimeout(msg.timer);

    updateFadeStyles();

    // 如果没有消息了，隐藏整个容器
    if (messages.length === 0) {
      stackEl.classList.add('hidden');
    }
  }

  // ─── 添加一条消息到堆叠 ───
  function pushMessage(text, duration = DEFAULT_DURATION, isAI = false) {
    // 清掉思考气泡
    hideThinking();
    clearInterval(typeTimer);

    const fullText = isAI ? `🐧 ${text}` : text;
    const { display, truncated } = truncate(fullText);

    const { el, textSpan } = createBubbleEl('', fullText, truncated, truncated);

    // 如果已经达到上限，移掉最旧的
    while (messages.length >= MAX_VISIBLE) {
      removeMessage(messages[0]);
    }

    // 追加到列表
    listEl.appendChild(el);

    const msg = {
      el,
      textSpan,
      fullText,
      timer: null,
    };
    messages.push(msg);

    // 显示容器
    stackEl.classList.remove('hidden');

    // 更新淡化样式
    updateFadeStyles();

    // 打字机效果（仅最新一条）
    let charIdx = 0;
    const displayChars = display;
    typeTimer = setInterval(() => {
      if (charIdx < displayChars.length) {
        textSpan.textContent = displayChars.substring(0, charIdx + 1);
        charIdx++;
      } else {
        clearInterval(typeTimer);
      }
    }, 40);

    // 定时移除
    msg.timer = setTimeout(() => {
      removeMessage(msg);
    }, duration);

    // 旧消息续命（确保堆叠可见）
    messages.forEach((m, i) => {
      if (i < messages.length - 1 && m.timer) {
        clearTimeout(m.timer);
        m.timer = setTimeout(() => {
          removeMessage(m);
        }, duration + FADE_DURATION);
      }
    });

    return msg;
  }

  // ─── 显示气泡（带全局节流，3秒内最多1条） ───
  function show(text, duration = 6000) {
    const now = Date.now();
    const elapsed = now - lastShowTime;

    if (elapsed < THROTTLE_MS) {
      // 节流期间：暂存最新一条，等节流结束后再显示
      pendingText = { text, duration };
      if (!pendingTimer) {
        pendingTimer = setTimeout(() => {
          pendingTimer = null;
          if (pendingText) {
            const p = pendingText;
            pendingText = null;
            lastShowTime = Date.now();
            pushMessage(p.text, p.duration, false);
          }
        }, THROTTLE_MS - elapsed);
      }
      return;
    }

    lastShowTime = now;
    pendingText = null;
    clearTimeout(pendingTimer);
    pendingTimer = null;
    pushMessage(text, duration, false);
  }

  // ─── 根据状态随机冒泡 ───
  function randomBubble() {
    const state = PetState.state;
    const stats = PetState.stats;

    let pool;
    if (stats.hunger <= 20) pool = PHRASES.hungry;
    else if (stats.clean <= 20) pool = PHRASES.dirty;
    else if (stats.energy <= 20) pool = PHRASES.tired;
    else if (state === 'working') pool = PHRASES.working;
    else if (state === 'happy') pool = PHRASES.happy;
    else if (state === 'thinking') pool = PHRASES.thinking;
    else pool = PHRASES.idle;

    const text = pool[Math.floor(Math.random() * pool.length)];
    show(text);
  }

  // ─── 思考中气泡（循环跳动的 ...） ───
  function showThinking() {
    clearInterval(typeTimer);
    clearInterval(thinkingInterval);

    // 创建一个思考气泡项
    const { el, textSpan } = createBubbleEl('.', '', false);
    el.classList.add('bubble-thinking');

    // 如果超限，移除最旧的
    while (messages.length >= MAX_VISIBLE) {
      removeMessage(messages[0]);
    }

    listEl.appendChild(el);

    const msg = { el, textSpan, fullText: '...', timer: null, isThinking: true };
    messages.push(msg);

    stackEl.classList.remove('hidden');
    updateFadeStyles();

    // 循环展示跳动的点
    let dots = 0;
    const frames = ['.', '..', '...'];
    textSpan.textContent = frames[0];
    thinkingInterval = setInterval(() => {
      dots = (dots + 1) % frames.length;
      textSpan.textContent = frames[dots];
    }, 500);
  }

  function hideThinking() {
    clearInterval(thinkingInterval);
    thinkingInterval = null;

    // 移除所有思考气泡
    const thinkingMsgs = messages.filter(m => m.isThinking);
    thinkingMsgs.forEach(m => removeMessage(m));
  }

  // ─── 流式输出：实时更新最新气泡文字 ───
  let streamingMsg = null;

  function updateStreamingBubble(text) {
    if (!text || !text.trim()) return;
    const display = text.length > MAX_CHARS ? text.substring(0, MAX_CHARS) : text;

    if (streamingMsg && streamingMsg.el && streamingMsg.el.parentNode) {
      // 直接更新现有气泡
      streamingMsg.textSpan.textContent = display;
      // 重置定时器，防止流式途中被移除
      if (streamingMsg.timer) clearTimeout(streamingMsg.timer);
      streamingMsg.timer = setTimeout(() => removeMessage(streamingMsg), DEFAULT_DURATION);
      return;
    }

    // 首次流式输出：先清掉 thinking 气泡，创建新气泡
    hideThinking();
    clearInterval(typeTimer);

    const { el, textSpan } = createBubbleEl(display, display, false);
    el.classList.add('bubble-streaming');

    while (messages.length >= MAX_VISIBLE) removeMessage(messages[0]);
    listEl.appendChild(el);

    const msg = { el, textSpan, fullText: display, timer: null, isStreaming: true };
    messages.push(msg);
    streamingMsg = msg;

    stackEl.classList.remove('hidden');
    updateFadeStyles();

    textSpan.textContent = display;
    msg.timer = setTimeout(() => { removeMessage(msg); streamingMsg = null; }, DEFAULT_DURATION);
  }

  // ─── 显示 AI 回复（流式结束后调用，做最终确认） ───
  function showAIReply(text) {
    hideThinking();
    // 清掉流式气泡（流式结束，换成最终完整版本）
    if (streamingMsg) {
      removeMessage(streamingMsg);
      streamingMsg = null;
    }
    pushMessage(text, DEFAULT_DURATION, true);
  }

  // ─── 显示语音识别中的文字（实时更新，不节流） ───
  let voiceRecognizingMsg = null;

  function showVoiceRecognizing(text) {
    hideThinking();

    const displayText = '[听] ' + text;
    const { display, truncated } = truncate(displayText);

    if (voiceRecognizingMsg && voiceRecognizingMsg.el && voiceRecognizingMsg.el.parentNode) {
      // 直接更新现有气泡文字（不重新创建，避免闪烁）
      voiceRecognizingMsg.textSpan.textContent = display;
      voiceRecognizingMsg.fullText = displayText;
      // 重置定时器（保持气泡可见）
      if (voiceRecognizingMsg.timer) clearTimeout(voiceRecognizingMsg.timer);
      voiceRecognizingMsg.timer = setTimeout(() => {
        removeMessage(voiceRecognizingMsg);
        voiceRecognizingMsg = null;
      }, 60000);
      return;
    }

    // 首次创建语音识别气泡
    const { el, textSpan } = createBubbleEl(display, displayText, false, truncated);
    el.classList.add('bubble-voice-recognizing');

    // 如果超限，移除最旧的
    while (messages.length >= MAX_VISIBLE) {
      removeMessage(messages[0]);
    }

    listEl.appendChild(el);

    const msg = {
      el,
      textSpan,
      fullText: displayText,
      timer: null,
      isVoiceRecognizing: true,
    };
    messages.push(msg);
    voiceRecognizingMsg = msg;

    // 直接显示文字（不走打字机效果，实时更新需要快）
    textSpan.textContent = display;

    stackEl.classList.remove('hidden');
    updateFadeStyles();

    msg.timer = setTimeout(() => {
      removeMessage(msg);
      voiceRecognizingMsg = null;
    }, 60000);
  }

  function hideVoiceRecognizing() {
    if (voiceRecognizingMsg) {
      removeMessage(voiceRecognizingMsg);
      voiceRecognizingMsg = null;
    }
  }

  // ─── 隐藏全部 ───
  function hide() {
    clearTimeout(hideTimer);
    clearInterval(typeTimer);
    hideThinking();

    // 清空所有消息
    messages.forEach(m => {
      if (m.timer) clearTimeout(m.timer);
    });
    messages.length = 0;
    listEl.innerHTML = '';
    stackEl.classList.add('hidden');
  }

  // ─── 语音识别流式字幕（屏幕中下方独立窗口，通过主进程控制） ───
  let subtitleTimer = null;

  function showSubtitle(text) {
    if (window.electronAPI && window.electronAPI.subtitleShow) {
      window.electronAPI.subtitleShow(text);
    }
    // 重置自动隐藏定时器
    if (subtitleTimer) clearTimeout(subtitleTimer);
    subtitleTimer = setTimeout(() => {
      hideSubtitle();
    }, 60000);
  }

  function hideSubtitle() {
    if (window.electronAPI && window.electronAPI.subtitleHide) {
      window.electronAPI.subtitleHide();
    }
    if (subtitleTimer) { clearTimeout(subtitleTimer); subtitleTimer = null; }
  }

  // ─── 更新进度气泡（专用，不走节流，实时覆盖更新） ───
  let updateProgressMsg = null;

  function showUpdateProgress(text) {
    const display = text.length > MAX_CHARS ? text.substring(0, MAX_CHARS) : text;

    if (updateProgressMsg && updateProgressMsg.el && updateProgressMsg.el.parentNode) {
      // 直接更新内容，重置计时器
      updateProgressMsg.textSpan.textContent = display;
      if (updateProgressMsg.timer) clearTimeout(updateProgressMsg.timer);
      updateProgressMsg.timer = setTimeout(() => {
        removeMessage(updateProgressMsg);
        updateProgressMsg = null;
      }, 60000);
      return;
    }

    // 首次创建
    hideThinking();
    const { el, textSpan } = createBubbleEl(display, display, false);
    el.classList.add('bubble-update-progress');

    while (messages.length >= MAX_VISIBLE) removeMessage(messages[0]);
    listEl.appendChild(el);

    const msg = { el, textSpan, fullText: display, timer: null };
    messages.push(msg);
    updateProgressMsg = msg;
    textSpan.textContent = display;

    stackEl.classList.remove('hidden');
    updateFadeStyles();

    msg.timer = setTimeout(() => {
      removeMessage(msg);
      updateProgressMsg = null;
    }, 60000);
  }

  return { show, hide, randomBubble, showAIReply, showThinking, hideThinking, showVoiceRecognizing, hideVoiceRecognizing, showSubtitle, hideSubtitle, updateStreamingBubble, showUpdateProgress };
})();
