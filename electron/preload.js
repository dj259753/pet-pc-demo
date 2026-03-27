const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ─── 拖拽 ───
  dragStart: (pos) => ipcRenderer.send('drag-start', pos),
  dragMove: (pos) => ipcRenderer.send('drag-move', pos),
  dragEnd: () => ipcRenderer.send('drag-end'),

  // ─── 屏幕 & 窗口 ───
  getScreenSize: () => ipcRenderer.invoke('get-screen-size'),
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
  sendQuickChatUserMsg: (text) => ipcRenderer.send('quick-chat-user-msg', { text }),

  // ─── Skills 接入窗口 ───
  openSkillsWindow: () => ipcRenderer.send('open-skills-window'),
  onSkillInstalled: (callback) => ipcRenderer.on('skill-installed', (_, data) => callback(data)),
  onSkillConfigureChat: (callback) => ipcRenderer.on('skill-configure-chat', (_, data) => callback(data)),

  // ─── AI 配置（从 ~/.qq-pet/config/ai-config.json 读取） ───
  getAIConfig: () => ipcRenderer.invoke('get-ai-config'),
  delegateToWorkBuddy: (payload) => ipcRenderer.invoke('workbuddy-delegate', payload),
  checkUpdatesNow: () => ipcRenderer.invoke('check-updates-now'),
  onUpdateAvailable: (callback) => ipcRenderer.on('update-available', (_, data) => callback(data)),
  onUpdateProgress: (callback) => ipcRenderer.on('update-progress', (_, data) => callback(data)),

  // ─── 语音模式 ───
  notifyVoiceStart: () => ipcRenderer.send('voice-mode-start'),
  notifyVoiceStop: () => ipcRenderer.send('voice-mode-stop'),
  onToggleVoiceMode: (callback) => ipcRenderer.on('toggle-voice-mode', () => callback()),

  // ─── 流式 ASR (腾讯云) ───
  getAsrConfig: () => ipcRenderer.invoke('get-asr-config'),
  saveAsrConfig: (data) => ipcRenderer.invoke('save-asr-config', data),
  asrCheck: () => ipcRenderer.invoke('asr-check'),
  asrStart: () => ipcRenderer.invoke('asr-start'),
  asrFeed: (data) => ipcRenderer.invoke('asr-feed', data),
  asrStop: (opts) => ipcRenderer.invoke('asr-stop', opts || {}),
  onAsrStreamingResult: (callback) => ipcRenderer.on('asr-streaming-result', (_, data) => callback(data)),
  onAsrVolume: (callback) => ipcRenderer.on('asr-volume', (_, data) => callback(data)),

  // ─── 语音识别字幕（屏幕中下方独立窗口） ───
  subtitleShow: (text) => ipcRenderer.send('subtitle-show', { text }),
  subtitleHide: () => ipcRenderer.send('subtitle-hide'),

  // ─── 点击穿透 ───
  setIgnoreMouse: (ignore) => ipcRenderer.send('set-ignore-mouse', { ignore }),
});
