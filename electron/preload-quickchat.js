const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('quickChatAPI', {
  sendMessage: (text, attachments = []) => ipcRenderer.send('quick-chat-send', { text, attachments }),
  pickFiles: () => ipcRenderer.invoke('quick-chat-pick-files'),
  readClipboardImage: () => ipcRenderer.invoke('quick-chat-read-clipboard-image'),
  hide: () => ipcRenderer.send('quick-chat-hide'),
  closeWindow: () => ipcRenderer.send('quick-chat-close'),

  // 监听 AI 回复（从主窗口转发过来）
  onAIReply: (callback) => ipcRenderer.on('ai-reply', (_, { text }) => callback(text)),

  // 监听 AI 流式输出（逐 token 回调）
  onAIStreamChunk: (callback) => ipcRenderer.on('ai-stream-chunk', (_, { text }) => callback(text)),

  // 监听用户消息（从主窗口转发的语音文本等）
  onUserMsg: (callback) => ipcRenderer.on('user-msg', (_, { text }) => callback(text)),

  // 监听 Agent 工具执行进度（tool_start/tool_end/agent_start/agent_end）
  onToolProgress: (callback) => ipcRenderer.on('agent-tool-progress', (_, evt) => callback(evt)),

  // ─── Gateway RPC（直接走完整 Agent loop） ───
  gatewayChatSend: (message) => ipcRenderer.invoke('gateway-chat-send', { message }),
  gatewayChatAbort: () => ipcRenderer.invoke('gateway-chat-abort', {}),
  gatewayChatHistory: (sessionKey, limit) => ipcRenderer.invoke('gateway-chat-history', { sessionKey, limit }),
  gatewayRpcStatus: () => ipcRenderer.invoke('gateway-rpc-status'),
  onGatewayChatEvent: (callback) => ipcRenderer.on('gateway-chat-event', (_, payload) => callback(payload)),
  onGatewayAgentEvent: (callback) => ipcRenderer.on('gateway-agent-event', (_, payload) => callback(payload)),

  // 打开外部 URL（系统浏览器）
  openUrl: (url) => ipcRenderer.invoke('open-external-url', url),

  // 打开本地文件/文件夹（Finder / 默认程序）
  openLocalPath: (filePath) => ipcRenderer.invoke('open-local-path', filePath),
});
