/* ═══════════════════════════════════════════
   语音模式 - 流式 ASR (腾讯云实时语音识别)
   边说边显示文字，实时流式识别
   操作方式：
     1. 点击按钮切换（开始/结束）
     2. Cmd+K 按一下进入聆听 / 再按一下结束
   ═══════════════════════════════════════════ */

const VoiceMode = (() => {
  'use strict';

  // ─── 状态 ───
  let isRecording = false;       // 用户期望的持续聆听状态
  let isSessionRunning = false;  // 当前 ASR 会话是否正在运行
  let isBusy = false;          // 防止快速重复点击
  let isSupported = false;
  let asrAvailable = false;
  let micPermStatus = 'unknown'; // 系统麦克风权限状态

  // ─── 流式识别缓存 ───
  let currentText = '';         // 当前流式识别的文字
  let finalText = '';           // 最终确认的文字

  // ─── 回调 ───
  let onResultCallback = null;
  let onStartCallback = null;
  let onStopCallback = null;
  let onErrorCallback = null;
  let onStreamingCallback = null;
  let onModeChangeCallback = null;
  let onSegmentCallback = null;   // realtime 模式：每次 VAD 分段完成后触发（用于清空字幕）

  // ─── 模式 ───
  const MODE_SINGLE = 'single';
  const MODE_REALTIME = 'realtime';
  let mode = MODE_REALTIME;

  // ─── 连续监听 + 音量VAD 参数 ───
  const VAD_FRAME_MS = 40;
  let VAD_START_FRAMES = 8;        // 约 320ms，降低背景声误触发
  let VAD_END_FRAMES = 25;         // 约 1000ms，1秒静音即判定说话结束
  let VAD_MARGIN_DB = 14;          // 相对噪声底 +14dB 才判定为语音
  let VAD_MIN_DBFS = -38;          // 提高绝对门限，过滤远处低音量人声
  const VAD_MIN_SPEECH_MS = 500;   // 最短有效语音时长
  const AUTO_RESTART_DELAY_MS = 120;
  const NOISE_PROFILES = {
    1: { name: '灵敏', marginDb: 10, minDbfs: -45, startFrames: 7, endFrames: 25 },
    2: { name: '均衡', marginDb: 12, minDbfs: -42, startFrames: 8, endFrames: 25 },
    3: { name: '抗噪', marginDb: 14, minDbfs: -38, startFrames: 8, endFrames: 25 },
    4: { name: '强抗噪', marginDb: 16, minDbfs: -35, startFrames: 9, endFrames: 25 },
  };
  let noiseLevel = 3;
  let noiseFloorDb = -62;
  let speechActive = false;
  let speechStartFrames = 0;
  let silenceFrames = 0;
  let segmentHasSpeech = false;
  let segmentSpeechStartAt = 0;
  let isAutoSegmenting = false;

  // ─── 初始化 ───
  async function init() {
    // 加载模式配置
    try {
      const stored = localStorage.getItem('voice_mode_type');
      if (stored === MODE_SINGLE || stored === MODE_REALTIME) mode = stored;
    } catch {}
    loadNoiseProfile();

    // 音频采集已移到主进程（ffmpeg），渲染进程只需 electronAPI 可用
    if (!window.electronAPI || !window.electronAPI.asrStart) {
      console.warn('[Voice] electronAPI.asrStart 不可用');
      isSupported = false;
      return;
    }

    isSupported = true;

    // 检测腾讯云 ASR 可用性
    if (window.electronAPI && window.electronAPI.asrCheck) {
      try {
        const result = await window.electronAPI.asrCheck();
        asrAvailable = result.available;
        if (result.micStatus) micPermStatus = result.micStatus;
        console.log(`🎤 ASR (${result.engine}): ${asrAvailable ? '可用 ✅' : '不可用 ❌'}, 麦克风: ${micPermStatus}`);
      } catch (e) {
        console.warn('🎤 ASR 检测失败:', e);
        asrAvailable = false;
      }
    }

    // 单独检测麦克风权限（如果 asr-check 没返回 micStatus）
    if (micPermStatus === 'unknown' && window.electronAPI?.checkMicPermission) {
      try {
        const mp = await window.electronAPI.checkMicPermission();
        micPermStatus = mp.status || 'unknown';
      } catch {}
    }

    // 监听主进程推送的流式识别结果（腾讯云 ASR 的结果从 WebSocket 回调推送）
    if (window.electronAPI && window.electronAPI.onAsrStreamingResult) {
      window.electronAPI.onAsrStreamingResult((data) => {
        // 注意：这里不检查 isRecording，因为分段停止期间仍需接收最终结果
        const text = data.text || '';
        console.log(`[Voice] 流式结果: "${text}" isFinal=${data.isFinal}`);
        if (text && text !== currentText) {
          currentText = text;
          if (isSessionRunning && onStreamingCallback) onStreamingCallback(currentText);
        }
        // 如果是一句话结束，更新 finalText
        if (data.isFinal && data.text) {
          finalText = data.text;
        }
      });
    }

    if (window.electronAPI && window.electronAPI.onAsrVolume) {
      window.electronAPI.onAsrVolume(({ db }) => {
        if (mode !== MODE_REALTIME) return;
        if (!isRecording || !isSessionRunning) return;
        if (typeof db !== 'number' || !Number.isFinite(db)) return;
        processVad(db);
      });
    }

    registerKeyBindings();

    // 监听 ASR 配置更新（用户在设置面板保存后触发），自动刷新可用性
    if (window.electronAPI && window.electronAPI.onAsrConfigUpdated) {
      window.electronAPI.onAsrConfigUpdated(async () => {
        console.log('🎤 收到 asr-config-updated，重新检测 ASR 可用性...');
        if (window.electronAPI.asrCheck) {
          try {
            const result = await window.electronAPI.asrCheck();
            asrAvailable = result.available;
            if (result.micStatus) micPermStatus = result.micStatus;
            console.log(`🎤 ASR 可用性已刷新: ${asrAvailable ? '可用 ✅' : '不可用 ❌'}`);
          } catch (e) {
            console.warn('🎤 ASR 重新检测失败:', e);
          }
        }
      });
    }

    // 监听 ffmpeg 权限拒绝事件（来自主进程 stderr 检测）
    if (window.electronAPI && window.electronAPI.onAsrMicPermissionDenied) {
      window.electronAPI.onAsrMicPermissionDenied(() => {
        console.warn('🎤 ffmpeg 报告麦克风权限被拒绝');
        micPermStatus = 'denied';
        if (isRecording) {
          isRecording = false;
          isSessionRunning = false;
          if (onStopCallback) onStopCallback({ reason: 'mic-denied' });
          if (onErrorCallback) onErrorCallback('mic-denied');
        }
      });
    }

    console.log('🎤 语音模式初始化完成 (腾讯云 ASR 流式识别)');
  }

  // ─── Cmd+K 按一下切换聆听模式 ───
  function registerKeyBindings() {
    document.addEventListener('keydown', (e) => {
      let targetKey = 'k';
      if (typeof SystemSettings !== 'undefined' && SystemSettings.getState) {
        const shortcut = SystemSettings.getState()?.shortcuts?.voice || 'CommandOrControl+K';
        const m = String(shortcut).match(/^CommandOrControl\+([A-Z])$/i);
        if (m) targetKey = m[1].toLowerCase();
      }
      if ((e.metaKey || e.ctrlKey) && String(e.key || '').toLowerCase() === targetKey) {
        e.preventDefault();
        // 按一下切换：录音中→停止，空闲→开始
        toggle();
      }
    });
  }

  // ─── 切换录音（异步，返回 Promise<boolean>） ───
  async function toggle() {
    if (!isSupported) {
      if (onErrorCallback) onErrorCallback('not-supported');
      return false;
    }
    // 忙碌时优先处理“停止”请求，避免结束要多次点击
    if (isBusy) {
      if (isRecording || isSessionRunning) {
        await stopRecording();
        return false;
      }
      return isRecording;
    }
    if (isRecording) {
      await stopRecording();
      return false;
    } else {
      const started = await startRecording();
      return started;
    }
  }

  // ─── 开始持续录音 + 流式识别 ───
  async function startRecording() {
    if (!isSupported) {
      if (onErrorCallback) onErrorCallback('not-supported');
      return false;
    }
    if (isRecording || isBusy) return isRecording;

    if (!asrAvailable) {
      if (onErrorCallback) onErrorCallback('asr-unavailable');
      return false;
    }

    // ── 先检查系统麦克风权限（macOS 沙盒需要） ──
    if (window.electronAPI && window.electronAPI.checkMicPermission) {
      try {
        const permResult = await window.electronAPI.checkMicPermission();
        const permStatus = permResult.status;
        console.log(`[Voice] 系统麦克风权限: ${permStatus}`);

        if (permStatus === 'denied' || permStatus === 'restricted') {
          // 已拒绝 → 给用户提示，引导去系统偏好设置
          if (onErrorCallback) onErrorCallback('mic-denied');
          return false;
        }

        if (permStatus === 'not-determined') {
          // 未决定 → 主动请求
          const reqResult = await window.electronAPI.requestMicPermission();
          if (!reqResult.granted) {
            if (onErrorCallback) onErrorCallback('mic-denied');
            return false;
          }
          console.log('[Voice] ✅ 麦克风权限已获取');
        }
        // granted → 继续
      } catch (e) {
        console.warn('[Voice] 权限检测异常，继续尝试:', e);
      }
    }

    try {
      isBusy = true;
      isRecording = true;
      resetVadState();
      await startAsrSession();
      isRecording = true;
      isBusy = false;

      if (onStartCallback) onStartCallback();
      console.log('[Voice] ✅ 持续聆听已开启（VAD 自动分段）');
      return true;

    } catch (e) {
      console.error('[Voice] ❌ 启动录音失败:', e);
      isBusy = false;
      isRecording = false;

      if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
        if (onErrorCallback) onErrorCallback('not-allowed');
      } else {
        if (onErrorCallback) onErrorCallback('start-failed');
      }
      return false;
    }
  }

  // ─── 手动停止持续录音 ───
  async function stopRecording() {
    if (!isRecording && !isSessionRunning) return;
    isRecording = false;
    isBusy = true;

    // 立即通知 UI 状态变更（不等 ASR session 结束），让按钮即时响应
    if (onStopCallback) onStopCallback({ reason: 'manual-stop' });

    try {
      const fullText = await stopAsrSessionAndCollectText();
      if (fullText && onResultCallback) onResultCallback(fullText);
      isBusy = false;
    } catch (e) {
      console.error('[Voice] stopRecording error:', e);
      isBusy = false;
      if (onErrorCallback) onErrorCallback('transcription-error');
    }
  }

  async function startAsrSession() {
    currentText = '';
    finalText = '';
    console.log('[Voice] 正在启动 ASR + ffmpeg...');
    let startResult;
    try {
      startResult = await window.electronAPI.asrStart();
    } catch (asrErr) {
      throw new Error(asrErr.message || '语音识别启动失败');
    }
    if (!startResult || startResult.error) {
      throw new Error((startResult && startResult.error) || '语音识别启动失败');
    }
    isSessionRunning = true;
  }

  async function stopAsrSessionAndCollectText() {
    if (!isSessionRunning) return '';
    isSessionRunning = false;
    console.log('[Voice] 正在停止当前语音分段...');
    const finalResult = await window.electronAPI.asrStop();
    const stopText = (finalResult && finalResult.text) || '';
    let fullText;
    if (finalText && stopText && stopText.includes(finalText)) {
      fullText = stopText.trim();
    } else if (finalText && stopText) {
      fullText = (finalText + stopText).trim();
    } else {
      fullText = (finalText || stopText).trim();
    }
    return fullText;
  }

  function resetVadState() {
    noiseFloorDb = -62;
    speechActive = false;
    speechStartFrames = 0;
    silenceFrames = 0;
    segmentHasSpeech = false;
    segmentSpeechStartAt = 0;
    isAutoSegmenting = false;
  }

  function applyNoiseProfile(level) {
    const lv = Number(level);
    const profile = NOISE_PROFILES[lv];
    if (!profile) return false;
    noiseLevel = lv;
    VAD_MARGIN_DB = profile.marginDb;
    VAD_MIN_DBFS = profile.minDbfs;
    VAD_START_FRAMES = profile.startFrames;
    VAD_END_FRAMES = profile.endFrames;
    return true;
  }

  function loadNoiseProfile() {
    try {
      const stored = Number(localStorage.getItem('voice_noise_level') || '3');
      if (!applyNoiseProfile(stored)) applyNoiseProfile(3);
    } catch {
      applyNoiseProfile(3);
    }
  }

  function setNoiseLevel(level) {
    const ok = applyNoiseProfile(level);
    if (!ok) return false;
    try { localStorage.setItem('voice_noise_level', String(noiseLevel)); } catch {}
    return true;
  }

  function processVad(db) {
    // 静音状态下慢速更新噪声底
    if (!speechActive && db < 0) {
      noiseFloorDb = noiseFloorDb * 0.97 + db * 0.03;
    }
    const threshold = Math.max(noiseFloorDb + VAD_MARGIN_DB, VAD_MIN_DBFS);
    const speakingNow = db >= threshold;

    if (!speechActive) {
      if (speakingNow) {
        speechStartFrames++;
        if (speechStartFrames >= VAD_START_FRAMES) {
          speechActive = true;
          segmentHasSpeech = true;
          segmentSpeechStartAt = Date.now();
          silenceFrames = 0;
        }
      } else {
        speechStartFrames = 0;
      }
      return;
    }

    // speechActive 时判断结束
    if (speakingNow) {
      silenceFrames = 0;
    } else {
      silenceFrames++;
    }

    const speechDuration = Date.now() - segmentSpeechStartAt;
    if (silenceFrames >= VAD_END_FRAMES && speechDuration >= VAD_MIN_SPEECH_MS) {
      finalizeAutoSegment();
    }
  }

  async function finalizeAutoSegment() {
    if (!isRecording || !isSessionRunning || isAutoSegmenting) return;
    isAutoSegmenting = true;

    // 先快照当前流式文本（stop 之前拿，stop 后主进程会重置）
    const snapshotText = (finalText || currentText || '').trim();

    try {
      // 标记 session 已停止，阻止 volume 回调继续触发 VAD
      isSessionRunning = false;
      currentText = '';
      finalText = '';

      // 等 stop 真正完成（quick 模式：不等 ASR 最终结果，立刻关闭 WebSocket）
      // 这样 asr-start 不会被 asr-stop 的 3 秒等待阻塞
      await window.electronAPI.asrStop({ quick: true });

      // 有效文本送出
      if (segmentHasSpeech && snapshotText && onResultCallback) {
        onResultCallback(snapshotText);
      }

      // 通知外部清空字幕
      if (onSegmentCallback) onSegmentCallback(snapshotText);

      resetVadState();

      // 重启新 session，继续监听下一句
      if (isRecording) {
        await new Promise(r => setTimeout(r, AUTO_RESTART_DELAY_MS));
        await startAsrSession();
      }
    } catch (e) {
      console.error('[Voice] 自动分段失败:', e);
      if (onErrorCallback) onErrorCallback('transcription-error');
    } finally {
      isAutoSegmenting = false;
    }
  }

  function setMode(nextMode) {
    if (nextMode !== MODE_SINGLE && nextMode !== MODE_REALTIME) return;
    if (mode === nextMode) return;
    mode = nextMode;
    try { localStorage.setItem('voice_mode_type', mode); } catch {}
    if (onModeChangeCallback) onModeChangeCallback(mode);
  }

  function onModeChange(cb) { onModeChangeCallback = cb; }

  // ─── 事件注册 ───
  function onResult(cb) { onResultCallback = cb; }
  function onStart(cb) { onStartCallback = cb; }
  function onStop(cb) { onStopCallback = cb; }
  function onError(cb) { onErrorCallback = cb; }
  function onStreaming(cb) { onStreamingCallback = cb; }
  function onSegment(cb) { onSegmentCallback = cb; }

  return {
    init,
    toggle,
    startRecording,
    stopRecording,
    onResult,
    onStart,
    onStop,
    onError,
    onStreaming,
    onSegment,
    onModeChange,
    setMode,
    setNoiseLevel,
    get noiseLevel() { return noiseLevel; },
    get noiseProfileName() { return (NOISE_PROFILES[noiseLevel] || NOISE_PROFILES[3]).name; },
    MODE_SINGLE,
    MODE_REALTIME,
    get mode() { return mode; },
    get isRecording() { return isRecording; },
    get isBusy() { return isBusy; },
    get isSupported() { return isSupported; },
    get asrAvailable() { return asrAvailable; },
    get micPermStatus() { return micPermStatus; },
  };
})();
