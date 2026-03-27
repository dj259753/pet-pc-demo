const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('skillsAPI', {
  // 获取真实 skills 列表（已安装 + 市场可用），支持关键词搜索和分页
  getSkills: (keyword = '', page = 1) => ipcRenderer.invoke('skills-get-list', { keyword, page }),

  // 安装 skill（返回 { ok, error? }）
  installSkill: (skillId, source) => ipcRenderer.invoke('skills-install', { skillId, source }),

  // 卸载 skill（返回 { ok, error? }）
  uninstallSkill: (skillId) => ipcRenderer.invoke('skills-uninstall', { skillId }),

  // 请求宠物发起配置对话
  configureSkill: (skillId, skillName) => ipcRenderer.send('skills-configure', { skillId, skillName }),

  // Git 仓库鉴权（skills 安装/更新共用）
  getAuthStatus: () => ipcRenderer.invoke('skills-get-auth-status'),
  saveAuthToken: (token) => ipcRenderer.invoke('skills-save-auth-token', { token }),
  openExternalUrl: (url) => ipcRenderer.invoke('open-external-url', url),

  // 关闭窗口
  hide: () => ipcRenderer.send('skills-hide'),
});
