const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ─── 拖拽 ───
  dragStart: (pos) => ipcRenderer.send('drag-start', pos),
  dragMove: (pos) => ipcRenderer.send('drag-move', pos),
  dragEnd: () => ipcRenderer.send('drag-end'),

  // ─── 屏幕 & 窗口 ───
  getScreenSize: () => ipcRenderer.invoke('get-screen-size'),
  getScreenContext: () => ipcRenderer.invoke('get-screen-context'),
  getWindowPosition: () => ipcRenderer.invoke('get-window-position'),
  setWindowPosition: (pos) => ipcRenderer.send('set-window-position', pos),
  resizeWindow: (size) => ipcRenderer.send('resize-window', size),

  // ─── 置顶控制 ───
  getAlwaysOnTop: () => ipcRenderer.invoke('get-always-on-top'),
  setAlwaysOnTop: (enabled) => ipcRenderer.send('set-always-on-top', enabled),

  // ─── 系统信息 ───
  getSystemInfo: () => ipcRenderer.invoke('get-system-info'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getSystemSettings: () => ipcRenderer.invoke('get-system-settings'),
  saveSystemSettings: (settings) => ipcRenderer.invoke('save-system-settings', settings),

  // ─── 面板切换事件 ───
  onTogglePanel: (callback) => ipcRenderer.on('toggle-panel', (_, panel) => callback(panel)),

  // ─── 开始菜单 ───
  onOpenStartMenu: (callback) => ipcRenderer.on('open-start-menu', () => callback()),

  // ─── 退出应用 ───
  quitApp: () => ipcRenderer.send('quit-app'),
  openExternalUrl: (url) => ipcRenderer.invoke('open-external-url', url),

  // ─── 右键菜单 ───
  showContextMenu: () => ipcRenderer.send('show-context-menu'),
  onMainWindowBlur: (callback) => ipcRenderer.on('main-window-blur', () => callback()),
  // quick-chat 发消息 → 主窗口宠物进入 thinking 状态
  onPetStartThinking: (callback) => ipcRenderer.on('pet-start-thinking', () => callback()),

  // ─── 番茄钟 Focus Mode ───
  onStartFocusMode: (callback) => ipcRenderer.on('start-focus-mode', () => callback()),
  onStopFocusMode: (callback) => ipcRenderer.on('stop-focus-mode', () => callback()),
  focusModeStart: () => ipcRenderer.send('focus-mode-start'),
  focusModeStop: () => ipcRenderer.send('focus-mode-stop'),
  onFocusDistraction: (callback) => ipcRenderer.on('focus-distraction', (_, data) => callback(data)),
  moveToCenter: () => ipcRenderer.send('move-to-center'),

  // ─── 剪贴板背包 ───
  onClipboardNew: (callback) => ipcRenderer.on('clipboard-new', (_, data) => callback(data)),
  getClipboardHistory: () => ipcRenderer.invoke('get-clipboard-history'),
  clipboardCopy: (text) => ipcRenderer.send('clipboard-copy', { text }),

  // ─── 文件拖拽 (Claw AI) ───
  readDroppedFile: (filePath) => ipcRenderer.invoke('read-dropped-file', filePath),

  // ─── 进程管理 ───
  getProcessList: () => ipcRenderer.invoke('get-process-list'),
  killProcess: (pid) => ipcRenderer.invoke('kill-process', pid),

  // ─── 系统感知 ───
  onBatteryUpdate: (callback) => ipcRenderer.on('battery-update', (_, data) => callback(data)),
  onDiskMounted: (callback) => ipcRenderer.on('disk-mounted', (_, data) => callback(data)),

  // ─── Claw AI 联动 ───
  onClawStatus: (callback) => ipcRenderer.on('claw-status', (_, data) => callback(data)),
  sendClawAction: (data) => ipcRenderer.send('claw-action', data),

  // ─── 全局快捷键唤起快捷对话 ───
  onToggleQuickChat: (callback) => ipcRenderer.on('toggle-quick-chat', () => callback()),

  // ─── 屏幕居中快捷对话窗口通信 ───
  openQuickChat: () => ipcRenderer.send('open-quick-chat-window'),
  onQuickChatMessage: (callback) => ipcRenderer.on('quick-chat-message', (_, data) => callback(data)),
  onQuickChatOpened: (callback) => ipcRenderer.on('quick-chat-opened', () => callback()),
  onQuickChatClosed: (callback) => ipcRenderer.on('quick-chat-closed', () => callback()),
  sendQuickChatReply: (text) => ipcRenderer.send('quick-chat-reply', { text }),
  sendQuickChatStreamChunk: (text) => ipcRenderer.send('quick-chat-stream-chunk', { text }),
  sendQuickChatToolProgress: (evt) => ipcRenderer.send('quick-chat-tool-progress', evt),
  sendQuickChatUserMsg: (text) => ipcRenderer.send('quick-chat-user-msg', { text }),
  openLocalPath: (filePath) => ipcRenderer.invoke('open-local-path', filePath),

  // ─── Skills 接入窗口 ───
  openSkillsWindow: () => ipcRenderer.send('open-skills-window'),

  onSkillInstalled: (callback) => ipcRenderer.on('skill-installed', (_, data) => callback(data)),
  onSkillConfigureChat: (callback) => ipcRenderer.on('skill-configure-chat', (_, data) => callback(data)),

  // ─── AI 配置向导 ───
  openAiSetup: () => ipcRenderer.invoke('open-ai-setup'),
  onAiConfigUpdated: (callback) => ipcRenderer.on('ai-config-updated', () => callback()),
  onAsrConfigUpdated: (callback) => ipcRenderer.on('asr-config-updated', () => callback()),

  // ─── Agent 自我进化：Soul/Identity/Memory 文件读写 ───
  agentReadFile:   (filePath)          => ipcRenderer.invoke('agent-read-file',   filePath),
  agentWriteFile:  (filePath, content) => ipcRenderer.invoke('agent-write-file',  filePath, content),
  agentAppendFile: (filePath, content) => ipcRenderer.invoke('agent-append-file', filePath, content),

  // ─── AI 配置（从 ~/.qq-pet/config/ai-config.json 读取） ───
  getAIConfig: () => ipcRenderer.invoke('get-ai-config'),

  // ─── Gateway RPC 聊天（走完整 Agent loop，工具调用会被实际执行） ───
  gatewayChatSend: (message, sessionKey) => ipcRenderer.invoke('gateway-chat-send', { message, sessionKey }),
  gatewayChatAbort: (runId, sessionKey) => ipcRenderer.invoke('gateway-chat-abort', { runId, sessionKey }),
  gatewayChatHistory: (sessionKey, limit) => ipcRenderer.invoke('gateway-chat-history', { sessionKey, limit }),
  gatewayRpcStatus: () => ipcRenderer.invoke('gateway-rpc-status'),

  // 监听 Gateway chat 事件（delta/final/error/aborted）
  onGatewayChatEvent: (callback) => ipcRenderer.on('gateway-chat-event', (_, payload) => callback(payload)),
  // 监听 Gateway agent 事件（tool start/end, lifecycle start/end）
  onGatewayAgentEvent: (callback) => ipcRenderer.on('gateway-agent-event', (_, payload) => callback(payload)),
  // 监听 Gateway RPC 连接就绪
  onGatewayRpcConnected: (callback) => ipcRenderer.on('gateway-rpc-connected', () => callback()),

  delegateToWorkBuddy: (payload) => ipcRenderer.invoke('workbuddy-delegate', payload),
  checkUpdatesNow: () => ipcRenderer.invoke('check-updates-now'),
  onUpdateAvailable: (callback) => ipcRenderer.on('update-available', (_, data) => callback(data)),
  onUpdateProgress:  (callback) => ipcRenderer.on('update-progress',  (_, data) => callback(data)),
  onUpdateBubble:    (callback) => ipcRenderer.on('update-bubble',    (_, data) => callback(data)),

  // ─── 语音模式 ───
  notifyVoiceStart: () => ipcRenderer.send('voice-mode-start'),
  notifyVoiceStop: () => ipcRenderer.send('voice-mode-stop'),
  onToggleVoiceMode: (callback) => ipcRenderer.on('toggle-voice-mode', () => callback()),
  onToggleMeetingNotes: (callback) => ipcRenderer.on('toggle-meeting-notes', () => callback()),
  onMeetingNotesCommand: (callback) => ipcRenderer.on('meeting-notes-command', (_, payload) => callback(payload || {})),
  openMeetingNotesWindow: () => ipcRenderer.send('meeting-notes-window-open'),
  closeMeetingNotesWindow: () => ipcRenderer.send('meeting-notes-window-close'),
  updateMeetingNotesWindow: (payload) => ipcRenderer.send('meeting-notes-window-update', payload || {}),
  onGlobalVoiceInputToggle: (callback) => ipcRenderer.on('global-voice-input-toggle', (_, payload) => callback(payload)),
  sendGlobalVoiceInputResult: (payload) => ipcRenderer.send('global-voice-input-result', payload),

  // ─── 流式 ASR (腾讯云) ───
  getAsrConfig: () => ipcRenderer.invoke('get-asr-config'),
  saveAsrConfig: (data) => ipcRenderer.invoke('save-asr-config', data),
  asrCheck: () => ipcRenderer.invoke('asr-check'),
  asrStart: () => ipcRenderer.invoke('asr-start'),
  asrFeed: (data) => ipcRenderer.invoke('asr-feed', data),
  asrStop: (opts) => ipcRenderer.invoke('asr-stop', opts || {}),
  onAsrStreamingResult: (callback) => ipcRenderer.on('asr-streaming-result', (_, data) => callback(data)),
  onAsrVolume: (callback) => ipcRenderer.on('asr-volume', (_, data) => callback(data)),
  onAsrMicPermissionDenied: (callback) => ipcRenderer.on('asr-mic-permission-denied', () => callback()),

  // ─── 麦克风系统权限（macOS） ───
  checkMicPermission:  () => ipcRenderer.invoke('check-mic-permission'),
  requestMicPermission: () => ipcRenderer.invoke('request-mic-permission'),
  openMicSystemPrefs:  () => ipcRenderer.invoke('open-mic-system-prefs'),

  // ─── 日志管理 ───
  getLogFiles:       () => ipcRenderer.invoke('get-log-files'),
  readLogTail:       (opts) => ipcRenderer.invoke('read-log-tail', opts || {}),
  openLogDir:        () => ipcRenderer.invoke('open-log-dir'),
  collectDiagnostics: () => ipcRenderer.invoke('collect-diagnostics'),
  writeClipboard: (text) => ipcRenderer.invoke('write-clipboard', text),
  getFrontSelectedText: () => ipcRenderer.invoke('get-front-selected-text'),
  meetingNotesSaveWav: (payload) => ipcRenderer.invoke('meeting-notes-save-wav', payload || {}),
  meetingNotesBuildDocx: (payload) => ipcRenderer.invoke('meeting-notes-build-docx', payload || {}),

  // ─── 语音识别字幕（屏幕中下方独立窗口） ───
  subtitleShow: (text) => ipcRenderer.send('subtitle-show', { text }),
  subtitleHide: () => ipcRenderer.send('subtitle-hide'),

  // ─── 点击穿透 ───
  setIgnoreMouse: (ignore) => ipcRenderer.send('set-ignore-mouse', { ignore }),

  // ─── Backend Gateway 控制 ───
  backendVerifyProvider: (params) => ipcRenderer.invoke('backend-verify-provider', params),
  backendSaveProvider: (params) => ipcRenderer.invoke('backend-save-provider', params),
  backendGetProviderConfig: () => ipcRenderer.invoke('backend-get-provider-config'),
  backendGetGatewayInfo: () => ipcRenderer.invoke('backend-get-gateway-info'),
  backendGetGatewayState: () => ipcRenderer.invoke('backend-get-gateway-state'),
  backendRestartGateway: () => ipcRenderer.invoke('backend-restart-gateway'),
  backendIsSetupComplete: () => ipcRenderer.invoke('backend-is-setup-complete'),
  onGatewayStateChanged: (callback) => ipcRenderer.on('gateway-state-changed', (_, state) => callback(state)),
  onAgentEvent: (callback) => ipcRenderer.on('agent-event', (_, evt) => callback(evt)),
});
