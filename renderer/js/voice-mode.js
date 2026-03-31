/* ═══════════════════════════════════════════
   语音模式 - 流式 ASR (腾讯云实时语音识别)
   麦克风采集：Web Audio API (getUserMedia)，零外部依赖
   ═══════════════════════════════════════════ */

const VoiceMode = (() => {
  'use strict';

  // ─── 状态 ───
  let isRecording = false;
  let isSessionRunning = false;
  let isBusy = false;
  let isSupported = false;
  let asrAvailable = false;
  let micPermStatus = 'unknown';

  // ─── 流式识别缓存 ───
  let currentText = '';
  let finalText = '';

  // ─── Web Audio 相关 ───
  let audioCtx = null;
  let micStream = null;
  let micSource = null;
  let scriptProcessor = null;
  let pcmBuffer = [];           // 未满帧的剩余字节
  const FRAME_SIZE = 1280;      // 腾讯云 ASR 推荐 40ms 帧 = 16kHz × 2B × 0.04s = 1280B
  let micChunks = 0;
  let micBytesSent = 0;
  let lastVolumeEmitAt = 0;

  // ─── 回调 ───
  let onResultCallback = null;
  let onStartCallback = null;
  let onStopCallback = null;
  let onErrorCallback = null;
  let onStreamingCallback = null;
  let onModeChangeCallback = null;
  let onSegmentCallback = null;

  // ─── 模式 ───
  const MODE_SINGLE = 'single';
  const MODE_REALTIME = 'realtime';
  let mode = MODE_REALTIME;

  // ─── VAD 参数 ───
  const VAD_FRAME_MS = 40;
  let VAD_START_FRAMES = 8;
  let VAD_END_FRAMES = 25;
  let VAD_MARGIN_DB = 14;
  let VAD_MIN_DBFS = -38;
  const VAD_MIN_SPEECH_MS = 500;
  const AUTO_RESTART_DELAY_MS = 120;
  const NOISE_PROFILES = {
    1: { name: '灵敏',  marginDb: 10, minDbfs: -45, startFrames: 7, endFrames: 25 },
    2: { name: '均衡',  marginDb: 12, minDbfs: -42, startFrames: 8, endFrames: 25 },
    3: { name: '抗噪',  marginDb: 14, minDbfs: -38, startFrames: 8, endFrames: 25 },
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

  // ─── 工具：Float32 → Int16 PCM ───
  function float32ToInt16(float32Array) {
    const int16 = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return int16;
  }

  // ─── 工具：计算 PCM 帧的 dBFS（用于 VAD + 音量条）───
  function calcFrameDb(int16Array) {
    if (!int16Array || int16Array.length === 0) return -100;
    let sumSq = 0;
    for (let i = 0; i < int16Array.length; i++) sumSq += int16Array[i] * int16Array[i];
    const rms = Math.sqrt(sumSq / int16Array.length);
    if (rms <= 0) return -100;
    const db = 20 * Math.log10(rms / 32768);
    return Number.isFinite(db) ? db : -100;
  }

  // ─── 初始化 ───
  async function init() {
    try {
      const stored = localStorage.getItem('voice_mode_type');
      if (stored === MODE_SINGLE || stored === MODE_REALTIME) mode = stored;
    } catch {}
    loadNoiseProfile();

    if (!window.electronAPI || !window.electronAPI.asrStart) {
      console.warn('[Voice] electronAPI.asrStart 不可用');
      isSupported = false;
      return;
    }

    isSupported = true;

    // 检测 ASR 可用性
    if (window.electronAPI.asrCheck) {
      try {
        const result = await window.electronAPI.asrCheck();
        asrAvailable = result.available;
        if (result.micStatus) micPermStatus = result.micStatus;
        console.log(`🎤 ASR (${result.engine}): ${asrAvailable ? '可用 ✅' : '不可用 ❌'}`);
      } catch (e) {
        console.warn('🎤 ASR 检测失败:', e);
        asrAvailable = false;
      }
    }

    // 监听主进程推送的流式识别结果
    if (window.electronAPI.onAsrStreamingResult) {
      window.electronAPI.onAsrStreamingResult((data) => {
        const text = data.text || '';
        console.log(`[Voice] 流式结果: "${text}" isFinal=${data.isFinal}`);
        if (text && text !== currentText) {
          currentText = text;
          if (isSessionRunning && onStreamingCallback) onStreamingCallback(currentText);
        }
        if (data.isFinal && data.text) {
          finalText = data.text;
        }
      });
    }

    // 监听 ASR 配置更新
    if (window.electronAPI.onAsrConfigUpdated) {
      window.electronAPI.onAsrConfigUpdated(async () => {
        console.log('🎤 收到 asr-config-updated，重新检测...');
        if (window.electronAPI.asrCheck) {
          try {
            const result = await window.electronAPI.asrCheck();
            asrAvailable = result.available;
            console.log(`🎤 ASR 可用性已刷新: ${asrAvailable ? '可用 ✅' : '不可用 ❌'}`);
          } catch (e) {
            console.warn('🎤 ASR 重新检测失败:', e);
          }
        }
      });
    }

    registerKeyBindings();
    console.log('🎤 语音模式初始化完成 (Web Audio API + 腾讯云 ASR)');
  }

  // ─── 快捷键 ───
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
        toggle();
      }
    });
  }

  // ─── 切换录音 ───
  async function toggle() {
    if (!isSupported) { if (onErrorCallback) onErrorCallback('not-supported'); return false; }
    if (isBusy) {
      if (isRecording || isSessionRunning) { await stopRecording(); return false; }
      return isRecording;
    }
    if (isRecording) { await stopRecording(); return false; }
    return await startRecording();
  }

  // ─── 开始录音 ───
  async function startRecording() {
    if (!isSupported || isRecording || isBusy) return isRecording;
    if (!asrAvailable) { if (onErrorCallback) onErrorCallback('asr-unavailable'); return false; }

    try {
      isBusy = true;
      isRecording = true;
      resetVadState();
      await startAsrSession();
      isBusy = false;
      if (onStartCallback) onStartCallback();
      console.log('[Voice] ✅ 持续聆听已开启（Web Audio VAD 自动分段）');
      return true;
    } catch (e) {
      console.error('[Voice] ❌ 启动录音失败:', e);
      isBusy = false;
      isRecording = false;
      stopMic();
      if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
        if (onErrorCallback) onErrorCallback('not-allowed');
      } else {
        if (onErrorCallback) onErrorCallback('start-failed');
      }
      return false;
    }
  }

  // ─── 停止录音 ───
  async function stopRecording() {
    if (!isRecording && !isSessionRunning) return;
    isRecording = false;
    isBusy = true;
    if (onStopCallback) onStopCallback({ reason: 'manual-stop' });
    try {
      const fullText = await stopAsrSessionAndCollectText();
      if (fullText && onResultCallback) onResultCallback(fullText);
    } catch (e) {
      console.error('[Voice] stopRecording error:', e);
      if (onErrorCallback) onErrorCallback('transcription-error');
    }
    isBusy = false;
  }

  // ─── 启动 ASR 会话（建立 WS + 开麦） ───
  async function startAsrSession() {
    currentText = '';
    finalText = '';
    console.log('[Voice] 正在连接 ASR WebSocket...');

    const startResult = await window.electronAPI.asrStart();
    if (!startResult || startResult.error) {
      throw new Error((startResult && startResult.error) || '语音识别启动失败');
    }

    // WebSocket 建好后，才开麦克风
    await startMic();
    isSessionRunning = true;
  }

  // ─── 停止 ASR 会话 ───
  async function stopAsrSessionAndCollectText() {
    if (!isSessionRunning) return '';
    isSessionRunning = false;
    stopMic();
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

  // ─── 开麦：Web Audio API ───
  async function startMic() {
    stopMic(); // 先确保清理旧的

    // getUserMedia 会触发系统麦克风权限弹框
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: 16000,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });

    // AudioContext 统一用 16kHz（即使系统硬件不支持，浏览器会自动重采样）
    audioCtx = new AudioContext({ sampleRate: 16000 });
    micSource = audioCtx.createMediaStreamSource(micStream);

    // ScriptProcessor 每次给 4096 个 float32 样本（约 256ms）
    // 对于 16kHz：4096 samples × 2B/sample = 8192B，内部拆成 6 帧 (1280B)
    scriptProcessor = audioCtx.createScriptProcessor(4096, 1, 1);

    scriptProcessor.onaudioprocess = (e) => {
      if (!isSessionRunning) return;

      const float32 = e.inputBuffer.getChannelData(0);
      const int16 = float32ToInt16(float32);

      // 音量 → VAD（realtime 模式下触发自动分段）
      const now = Date.now();
      if (now - lastVolumeEmitAt >= 80) {
        lastVolumeEmitAt = now;
        const db = calcFrameDb(int16);
        if (mode === MODE_REALTIME && isRecording) {
          processVad(db);
        }
        // 推音量给渲染进程自己（已去掉 onAsrVolume 的主进程路径，直接本地用）
        if (onVolumeCallback) onVolumeCallback(db);
      }

      // 把 int16 追加到 pcmBuffer，按 FRAME_SIZE 切帧发给主进程
      const bytes = Buffer.from(int16.buffer);
      pcmBuffer.push(bytes);

      let combined = Buffer.concat(pcmBuffer);
      pcmBuffer = [];

      while (combined.length >= FRAME_SIZE) {
        const frame = combined.slice(0, FRAME_SIZE);
        combined = combined.slice(FRAME_SIZE);
        micChunks++;
        micBytesSent += frame.length;

        if (window.electronAPI && window.electronAPI.asrFeed) {
          window.electronAPI.asrFeed(frame.buffer);
        }
      }

      // 剩余不满帧的字节留到下次
      if (combined.length > 0) pcmBuffer.push(combined);

      if (micChunks > 0 && micChunks % 50 === 0) {
        console.log(`🎤 WebAudio→ASR: ${micChunks} frames, ${micBytesSent}B sent`);
      }
    };

    micSource.connect(scriptProcessor);
    // 不连 destination，避免扬声器回放自己的声音
    scriptProcessor.connect(audioCtx.destination);

    console.log('🎤 Web Audio 麦克风采集已启动 (sampleRate:', audioCtx.sampleRate, ')');
    micPermStatus = 'granted';
  }

  // ─── 停麦 ───
  function stopMic() {
    try { if (scriptProcessor) { scriptProcessor.disconnect(); scriptProcessor.onaudioprocess = null; } } catch {}
    try { if (micSource) micSource.disconnect(); } catch {}
    try { if (micStream) micStream.getTracks().forEach(t => t.stop()); } catch {}
    try { if (audioCtx && audioCtx.state !== 'closed') audioCtx.close(); } catch {}
    scriptProcessor = null;
    micSource = null;
    micStream = null;
    audioCtx = null;
    pcmBuffer = [];
    micChunks = 0;
    micBytesSent = 0;
    console.log('🎤 Web Audio 麦克风采集已停止');
  }

  // ─── VAD ───
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
    const profile = NOISE_PROFILES[Number(level)];
    if (!profile) return false;
    noiseLevel = Number(level);
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
    } catch { applyNoiseProfile(3); }
  }

  function setNoiseLevel(level) {
    const ok = applyNoiseProfile(level);
    if (!ok) return false;
    try { localStorage.setItem('voice_noise_level', String(noiseLevel)); } catch {}
    return true;
  }

  function processVad(db) {
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

    const snapshotText = (finalText || currentText || '').trim();

    try {
      isSessionRunning = false;
      currentText = '';
      finalText = '';

      stopMic();
      await window.electronAPI.asrStop({ quick: true });

      if (segmentHasSpeech && snapshotText && onResultCallback) {
        onResultCallback(snapshotText);
      }
      if (onSegmentCallback) onSegmentCallback(snapshotText);

      resetVadState();

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

  // ─── 内部音量回调（供 VAD 之外的 UI 使用，如果有的话）───
  let onVolumeCallback = null;
  function onVolume(cb) { onVolumeCallback = cb; }

  function onModeChange(cb) { onModeChangeCallback = cb; }
  function onResult(cb)   { onResultCallback = cb; }
  function onStart(cb)    { onStartCallback = cb; }
  function onStop(cb)     { onStopCallback = cb; }
  function onError(cb)    { onErrorCallback = cb; }
  function onStreaming(cb){ onStreamingCallback = cb; }
  function onSegment(cb)  { onSegmentCallback = cb; }

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
    onVolume,
    setMode,
    setNoiseLevel,
    get isSupported()    { return isSupported; },
    get asrAvailable()   { return asrAvailable; },
    get isRecording()    { return isRecording; },
    get isSessionRunning(){ return isSessionRunning; },
    get micPermStatus()  { return micPermStatus; },
    get currentMode()    { return mode; },
    get noiseLevel()     { return noiseLevel; },
  };
})();
