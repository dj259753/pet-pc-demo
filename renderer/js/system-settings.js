/* ═══════════════════════════════════════════
   系统设置面板：置顶/自启动/主动对话/快捷键/层级
   ═══════════════════════════════════════════ */

const SystemSettings = (() => {
  'use strict';

  const DEFAULTS = {
    alwaysOnTop: true,
    autoLaunch: false,
    proactiveChat: true,
    layerMode: 'normal',
    shortcuts: {
      voice: 'CommandOrControl+K',
      talk: 'CommandOrControl+U',
    },
  };
  const NOISE_LABELS = {
    1: '灵敏',
    2: '均衡',
    3: '抗噪',
    4: '强抗噪',
  };

  let state = JSON.parse(JSON.stringify(DEFAULTS));

  function cloneState() {
    return {
      alwaysOnTop: !!state.alwaysOnTop,
      autoLaunch: !!state.autoLaunch,
      proactiveChat: !!state.proactiveChat,
      layerMode: state.layerMode || 'normal',
      shortcuts: {
        voice: state.shortcuts?.voice || DEFAULTS.shortcuts.voice,
        talk: state.shortcuts?.talk || DEFAULTS.shortcuts.talk,
      },
    };
  }

  async function init() {
    await loadFromMain();
    await loadAsrFromMain();
    await renderAiStatus();
    bindEvents();
    render();
    applyToRuntime();
  }

  async function loadFromMain() {
    if (!window.electronAPI || !window.electronAPI.getSystemSettings) return;
    try {
      const remote = await window.electronAPI.getSystemSettings();
      state = {
        ...DEFAULTS,
        ...remote,
        shortcuts: {
          ...DEFAULTS.shortcuts,
          ...(remote?.shortcuts || {}),
        },
      };
    } catch (e) {
      console.warn('读取系统设置失败:', e);
    }
  }

  // ─── ASR 配置（独立于 systemSettings，不存 secretKey 到前端内存） ───
  let asrCfg = { appId: '', secretId: '', secretKeySet: false, engineModelType: '16k_zh_large' };

  async function loadAsrFromMain() {
    if (!window.electronAPI?.getAsrConfig) return;
    try {
      const remote = await window.electronAPI.getAsrConfig();
      asrCfg = remote || asrCfg;
      renderAsrStatus();
    } catch (e) {
      console.warn('读取 ASR 配置失败:', e);
    }
  }

  function renderAsrStatus() {
    const appIdInput = document.getElementById('setting-asr-appid');
    const secretIdInput = document.getElementById('setting-asr-secretid');
    const statusEl = document.getElementById('setting-asr-status');
    const micStatusEl = document.getElementById('setting-mic-status');
    if (appIdInput) appIdInput.value = asrCfg.appId || '';
    if (secretIdInput) secretIdInput.value = asrCfg.secretId || '';
    // secretKey 不回填，只展示状态
    if (statusEl) {
      const ok = !!(asrCfg.appId && asrCfg.secretId && asrCfg.secretKeySet);
      statusEl.textContent = ok ? '✅ 已配置' : (asrCfg.appId || asrCfg.secretId ? '⚠️ 配置不完整' : '❌ 未配置');
      statusEl.style.color = ok ? '#4ade80' : (asrCfg.appId || asrCfg.secretId ? '#fbbf24' : '#f87171');
    }
    // 麦克风权限状态
    if (micStatusEl) {
      const permMap = {
        granted:          { text: '✅ 已授权', color: '#4ade80' },
        'not-determined': { text: '⚠️ 未授权（点击授权）', color: '#fbbf24' },
        denied:           { text: '❌ 已拒绝（点击去开启）', color: '#f87171' },
        restricted:       { text: '❌ 受限制', color: '#f87171' },
        unknown:          { text: '— 未知', color: '#9ca3af' },
      };
      const micPerm = typeof VoiceMode !== 'undefined' ? VoiceMode.micPermStatus : 'unknown';
      const info = permMap[micPerm] || permMap['unknown'];
      micStatusEl.textContent = info.text;
      micStatusEl.style.color = info.color;
      micStatusEl.style.cursor = (micPerm !== 'granted') ? 'pointer' : 'default';
    }
  }

  // ─── AI 配置状态显示 ───
  async function renderAiStatus() {
    const statusEl = document.getElementById('setting-ai-status');
    if (!statusEl) return;
    try {
      const cfg = await window.electronAPI?.getAIConfig?.();
      if (cfg && cfg.api_url && cfg.provider !== 'local') {
        const name = cfg.provider === 'qqclaw' ? 'QQClaw' : 'OpenClaw';
        statusEl.textContent = `✅ 已连接 ${name}`;
        statusEl.style.color = '#4ade80';
      } else {
        statusEl.textContent = '⚠️ 未配置（离线模式）';
        statusEl.style.color = '#fbbf24';
      }
    } catch {
      statusEl.textContent = '❌ 读取失败';
      statusEl.style.color = '#f87171';
    }
  }

  function bindEvents() {
    const btnTop = document.getElementById('setting-always-on-top');
    const btnAutoLaunch = document.getElementById('setting-auto-launch');
    const btnProactive = document.getElementById('setting-proactive-chat');
    const btnVoiceNoise = document.getElementById('setting-voice-noise');
    const btnSaveShortcuts = document.getElementById('setting-save-shortcuts');

    if (btnTop) {
      btnTop.addEventListener('click', async () => {
        state.alwaysOnTop = !state.alwaysOnTop;
        await persist();
        render();
      });
    }

    if (btnAutoLaunch) {
      btnAutoLaunch.addEventListener('click', async () => {
        state.autoLaunch = !state.autoLaunch;
        await persist();
        render();
      });
    }

    if (btnProactive) {
      btnProactive.addEventListener('click', async () => {
        state.proactiveChat = !state.proactiveChat;
        applyProactiveChat();
        await persist();
        render();
      });
    }

    if (btnVoiceNoise) {
      btnVoiceNoise.addEventListener('click', () => {
        const current = getNoiseLevel();
        const next = current >= 4 ? 1 : current + 1;
        if (typeof VoiceMode !== 'undefined' && VoiceMode.setNoiseLevel) {
          if (!VoiceMode.setNoiseLevel(next)) {
            BubbleSystem.show('语音抗噪设置失败', 2200);
            return;
          }
        } else {
          try { localStorage.setItem('voice_noise_level', String(next)); } catch {}
        }
        renderNoiseSetting();
        BubbleSystem.show(`语音抗噪：${next} 档（${NOISE_LABELS[next]}）`, 2200);
      });
    }

    document.querySelectorAll('input[name="layer-mode"]').forEach((radio) => {
      radio.addEventListener('change', async (e) => {
        const next = e.target.value;
        if (!next) return;
        state.layerMode = next;
        await persist();
        render();
      });
    });

    if (btnSaveShortcuts) {
      btnSaveShortcuts.addEventListener('click', async () => {
        const voiceInput = document.getElementById('setting-voice-shortcut');
        const talkInput = document.getElementById('setting-talk-shortcut');
        const voiceParsed = parseShortcutInput(voiceInput ? voiceInput.value : '');
        const talkParsed = parseShortcutInput(talkInput ? talkInput.value : '');
        if (!voiceParsed || !talkParsed) {
          BubbleSystem.show('快捷键格式错误，请用 cmd/ctrl+字母', 2600);
          return;
        }
        state.shortcuts.voice = voiceParsed;
        state.shortcuts.talk = talkParsed;
        await persist();
        render();
        BubbleSystem.show('快捷键已保存，立即生效', 2200);
      });
    }

    // ─── AI 配置检测 ───
    const btnAiSetup = document.getElementById('setting-open-ai-setup');
    if (btnAiSetup) {
      btnAiSetup.addEventListener('click', async () => {
        if (window.electronAPI?.openAiSetup) {
          await window.electronAPI.openAiSetup();
        } else {
          BubbleSystem.show('AI 配置向导不可用', 2200);
        }
      });
    }

    // ─── 麦克风权限授权 ───
    const micStatusEl = document.getElementById('setting-mic-status');
    if (micStatusEl) {
      micStatusEl.addEventListener('click', async () => {
        const micPerm = typeof VoiceMode !== 'undefined' ? VoiceMode.micPermStatus : 'unknown';
        if (micPerm === 'granted') return;
        if (micPerm === 'denied' || micPerm === 'restricted') {
          // 打开系统偏好设置
          BubbleSystem.show('正在打开系统设置...', 2000);
          if (window.electronAPI?.openMicSystemPrefs) await window.electronAPI.openMicSystemPrefs();
        } else {
          // 请求权限
          if (window.electronAPI?.requestMicPermission) {
            const r = await window.electronAPI.requestMicPermission();
            if (r.granted) {
              BubbleSystem.show('🎤 麦克风已授权！', 2200);
            } else if (r.needSystemPrefs) {
              BubbleSystem.show('请在系统设置中开启麦克风权限', 2500);
              if (window.electronAPI?.openMicSystemPrefs) await window.electronAPI.openMicSystemPrefs();
            } else {
              BubbleSystem.show('麦克风授权失败', 2200);
            }
            renderAsrStatus();
          }
        }
      });
    }

    // ─── 导出诊断日志 ───
    const btnExportLog = document.getElementById('setting-export-log');
    if (btnExportLog) {
      btnExportLog.addEventListener('click', async () => {
        btnExportLog.textContent = '收集中...';
        btnExportLog.disabled = true;
        try {
          if (window.electronAPI?.collectDiagnostics) {
            const r = await window.electronAPI.collectDiagnostics();
            if (r.ok) {
              // 写入剪贴板
              await navigator.clipboard.writeText(r.report);
              BubbleSystem.show('📋 诊断日志已复制到剪贴板！可以直接发给开发者', 4000);
            }
          } else if (window.electronAPI?.openLogDir) {
            await window.electronAPI.openLogDir();
            BubbleSystem.show('📁 日志目录已打开', 2200);
          }
        } catch (e) {
          BubbleSystem.show('导出失败: ' + e.message, 2600);
        } finally {
          btnExportLog.textContent = '📋 复制诊断日志';
          btnExportLog.disabled = false;
        }
      });
    }

    // ─── 打开日志目录 ───
    const btnOpenLog = document.getElementById('setting-open-log-dir');
    if (btnOpenLog) {
      btnOpenLog.addEventListener('click', async () => {
        if (window.electronAPI?.openLogDir) {
          await window.electronAPI.openLogDir();
        }
      });
    }

    // ─── ASR 配置保存 ───
    const btnSaveAsr = document.getElementById('setting-save-asr');
    if (btnSaveAsr) {
      btnSaveAsr.addEventListener('click', async () => {
        if (!window.electronAPI?.saveAsrConfig) return;
        const appId     = (document.getElementById('setting-asr-appid')?.value    || '').trim();
        const secretId  = (document.getElementById('setting-asr-secretid')?.value || '').trim();
        const secretKey = (document.getElementById('setting-asr-secretkey')?.value || '').trim();

        if (!appId || !secretId) {
          BubbleSystem.show('AppId 和 SecretId 不能为空', 2600);
          return;
        }

        const result = await window.electronAPI.saveAsrConfig({ appId, secretId, secretKey });
        if (result?.ok) {
          asrCfg.appId = appId;
          asrCfg.secretId = secretId;
          if (secretKey) asrCfg.secretKeySet = true;
          // 清空 secretKey 输入框（不留在内存）
          const skInput = document.getElementById('setting-asr-secretkey');
          if (skInput) skInput.value = '';
          renderAsrStatus();
          BubbleSystem.show('🎤 ASR 密钥已保存', 2200);
        } else {
          BubbleSystem.show(`保存失败: ${result?.error || '未知错误'}`, 2800);
        }
      });
    }
  }

  function parseShortcutInput(input) {
    const raw = String(input || '').trim().toLowerCase().replace(/\s+/g, '');
    const m = raw.match(/^(cmd\/ctrl|ctrl\/cmd|commandorcontrol)\+([a-z])$/);
    if (!m) return null;
    return `CommandOrControl+${m[2].toUpperCase()}`;
  }

  function formatShortcutForDisplay(shortcut) {
    const val = String(shortcut || '').replace(/\s+/g, '');
    const m = val.match(/^CommandOrControl\+([A-Z])$/i);
    if (m) return `cmd/ctrl+${m[1].toLowerCase()}`;
    return val;
  }

  async function persist() {
    applyToRuntime();
    if (!window.electronAPI || !window.electronAPI.saveSystemSettings) return;
    try {
      const saved = await window.electronAPI.saveSystemSettings(cloneState());
      if (saved?.ok === false) {
        BubbleSystem.show(`保存设置失败：${saved.error || '未知错误'}`, 2800);
      }
    } catch (e) {
      BubbleSystem.show('保存设置失败，请稍后重试', 2600);
      console.warn('保存系统设置失败:', e);
    }
  }

  function applyToRuntime() {
    applyProactiveChat();
    syncShortcutLabels();
  }

  function applyProactiveChat() {
    if (typeof ProactiveChat !== 'undefined' && ProactiveChat.setMuted) {
      ProactiveChat.setMuted(!state.proactiveChat);
    }
  }

  function syncShortcutLabels() {
    const talkEl = document.getElementById('talk-shortcut');
    const voiceEl = document.getElementById('voice-shortcut');
    if (talkEl) talkEl.textContent = formatShortcutForDisplay(state.shortcuts.talk);
    if (voiceEl) voiceEl.textContent = formatShortcutForDisplay(state.shortcuts.voice);
  }

  function renderToggle(btn, enabled) {
    if (!btn) return;
    btn.textContent = enabled ? '开' : '关';
    btn.classList.toggle('on', !!enabled);
  }

  function render() {
    renderToggle(document.getElementById('setting-always-on-top'), state.alwaysOnTop);
    renderToggle(document.getElementById('setting-auto-launch'), state.autoLaunch);
    renderToggle(document.getElementById('setting-proactive-chat'), state.proactiveChat);

    const voiceInput = document.getElementById('setting-voice-shortcut');
    const talkInput = document.getElementById('setting-talk-shortcut');
    if (voiceInput) voiceInput.value = formatShortcutForDisplay(state.shortcuts.voice);
    if (talkInput) talkInput.value = formatShortcutForDisplay(state.shortcuts.talk);

    const radios = document.querySelectorAll('input[name="layer-mode"]');
    radios.forEach((r) => { r.checked = r.value === state.layerMode; });

    const ver = document.getElementById('settings-version');
    const aboutVersion = document.getElementById('about-version');
    if (aboutVersion && ver) ver.textContent = aboutVersion.textContent;

    syncShortcutLabels();
    renderNoiseSetting();
    renderAsrStatus();
  }

  function getNoiseLevel() {
    if (typeof VoiceMode !== 'undefined' && Number.isInteger(Number(VoiceMode.noiseLevel))) {
      return Number(VoiceMode.noiseLevel);
    }
    try {
      const lv = Number(localStorage.getItem('voice_noise_level') || '3');
      return (lv >= 1 && lv <= 4) ? lv : 3;
    } catch {
      return 3;
    }
  }

  function renderNoiseSetting() {
    const btn = document.getElementById('setting-voice-noise');
    if (!btn) return;
    const lv = getNoiseLevel();
    btn.textContent = `${lv} 档（${NOISE_LABELS[lv] || '抗噪'}）`;
  }

  function getState() {
    return cloneState();
  }

  return {
    init,
    getState,
  };
})();
