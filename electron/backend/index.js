/**
 * index.js — Backend 统一入口
 * 整合 Gateway 生命周期管理、Provider 配置、Workspace 初始化
 * 
 * 使用方式：
 *   const backend = require('./backend');
 *   await backend.init();        // 首次启动/恢复
 *   backend.registerIPC(ipcMain); // 注册 IPC handlers
 */

'use strict';

const { ipcMain, BrowserWindow } = require('electron');
const constants = require('./constants');
const { GatewayProcess } = require('./gateway-process');
const { GatewayRpcClient } = require('./gateway-rpc');
const { resolveGatewayAuthToken, ensureGatewayAuthTokenInConfig } = require('./gateway-auth');
const { readUserConfig, writeUserConfig, verifyCustom, saveProviderConfig, getCurrentProviderConfig } = require('./provider-config');
const { backupCurrentUserConfig, recordSetupBaselineConfigSnapshot, recordLastKnownGoodConfigSnapshot, getConfigRecoveryData } = require('./config-backup');
const { ensureWorkspace, getDefaultPetSoul } = require('./workspace-init');

let gateway = null;
let rpcClient = null;   // Gateway WebSocket RPC 客户端

/**
 * 初始化 Backend
 * - 确保 workspace 目录结构
 * - 如果配置已完成，启动 Gateway
 * - 返回 { setupRequired, gatewayState }
 */
async function init() {
  // 1. 确保 workspace 存在
  ensureWorkspace();

  // 2. 检查是否需要首次配置
  if (!constants.isSetupComplete()) {
    console.log('[backend] 首次启动，需要配置向导');
    return { setupRequired: true, gatewayState: 'stopped' };
  }

  // 3. 配置已完成，启动 Gateway
  console.log('[backend] 配置已完成，启动 Gateway...');
  const state = await startGateway();
  return { setupRequired: false, gatewayState: state };
}

/**
 * 启动 Gateway 子进程
 */
async function startGateway() {
  if (gateway && gateway.getState() === 'running') {
    console.log('[backend] Gateway 已在运行');
    return 'running';
  }

  // 读取或生成 auth token
  const token = resolveGatewayAuthToken();

  gateway = new GatewayProcess({
    port: constants.DEFAULT_PORT,
    token,
    onStateChange: (state) => {
      console.log(`[backend] Gateway state: ${state}`);
      // 通知所有窗口 Gateway 状态变化
      const { BrowserWindow } = require('electron');
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('gateway-state-changed', state);
        }
      }
    },
    onAgentLog: (evt) => {
      // 将 agent 事件转发给渲染进程（用于气泡展示工具执行进度）
      const { BrowserWindow } = require('electron');
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('agent-event', evt);
        }
      }
    },
  });

  await gateway.start();

  if (gateway.getState() === 'running') {
    // 记录"最近一次可启动"快照
    recordLastKnownGoodConfigSnapshot();
    console.log(`[backend] Gateway 启动成功: http://127.0.0.1:${gateway.getPort()}`);

    // 建立 WebSocket RPC 长连接（用于 Agent chat loop）
    connectGatewayRpc();
  }

  return gateway.getState();
}

/**
 * 建立 Gateway WebSocket RPC 长连接
 */
function connectGatewayRpc() {
  // 先断开旧连接
  if (rpcClient) {
    rpcClient.stop();
    rpcClient = null;
  }

  if (!gateway || gateway.getState() !== 'running') return;

  const port = gateway.getPort();
  const token = gateway.getToken();

  rpcClient = new GatewayRpcClient({
    url: `ws://127.0.0.1:${port}/`,
    token,
    onChatEvent: (payload) => {
      // 转发 chat 事件到所有渲染进程
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('gateway-chat-event', payload);
        }
      }
    },
    onAgentEvent: (payload) => {
      // 转发 agent 事件到所有渲染进程
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('gateway-agent-event', payload);
        }
      }
    },
    onConnected: () => {
      console.log('[backend] Gateway RPC 已连接');
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('gateway-rpc-connected');
        }
      }
    },
    onDisconnected: () => {
      console.log('[backend] Gateway RPC 已断开');
    },
  });

  rpcClient.start();
}

/**
 * 停止 Gateway
 */
function stopGateway() {
  if (rpcClient) {
    rpcClient.stop();
    rpcClient = null;
  }
  if (gateway) {
    gateway.stop();
    gateway = null;
  }
}

/**
 * 获取 Gateway 连接信息（给 ai-brain.js 用）
 */
function getGatewayInfo() {
  if (!gateway || gateway.getState() !== 'running') {
    return { running: false, url: '', token: '', model: '' };
  }

  const config = readUserConfig();
  const primary = config?.agents?.defaults?.model?.primary || '';
  const [providerKey, ...modelParts] = primary.split('/');
  const modelID = modelParts.join('/');
  const provider = config?.models?.providers?.[providerKey];

  return {
    running: true,
    // AI Brain 直接往 Gateway 发请求，Gateway 会路由到配置的 provider
    url: `http://127.0.0.1:${gateway.getPort()}/v1`,
    token: gateway.getToken(),
    model: primary,  // 格式: providerKey/modelID
    // 也返回原始信息供直接调用
    directUrl: provider?.baseUrl || '',
    directKey: provider?.apiKey || '',
    directModel: modelID,
  };
}

/**
 * 注册所有 Backend IPC Handlers
 */
function registerIPC() {
  // ── 配置向导相关 ──

  // 验证 AI Provider
  ipcMain.handle('backend-verify-provider', async (_event, { apiKey, baseURL, modelID }) => {
    try {
      await verifyCustom(apiKey, baseURL, modelID);
      return { success: true };
    } catch (err) {
      return { success: false, message: err.message };
    }
  });

  // 保存 AI 配置并启动 Gateway
  ipcMain.handle('backend-save-provider', async (_event, { apiKey, baseURL, modelID }) => {
    try {
      // 保存 provider 配置
      const config = saveProviderConfig(apiKey, baseURL, modelID);
      // 确保 gateway auth token
      ensureGatewayAuthTokenInConfig(config);
      writeUserConfig(config);
      // 记录基线快照
      recordSetupBaselineConfigSnapshot();
      // 启动 Gateway
      const state = await startGateway();
      return { success: true, gatewayState: state };
    } catch (err) {
      return { success: false, message: err.message };
    }
  });

  // 获取当前 Provider 配置（供设置页显示）
  ipcMain.handle('backend-get-provider-config', () => {
    return getCurrentProviderConfig();
  });

  // 获取 Gateway 连接信息（给 ai-brain.js 用）
  ipcMain.handle('backend-get-gateway-info', () => {
    return getGatewayInfo();
  });

  // 获取 Gateway 状态
  ipcMain.handle('backend-get-gateway-state', () => {
    return gateway ? gateway.getState() : 'stopped';
  });

  // 重启 Gateway
  ipcMain.handle('backend-restart-gateway', async () => {
    try {
      if (gateway) {
        await gateway.restart();
        return { success: true, state: gateway.getState() };
      }
      const state = await startGateway();
      return { success: true, state };
    } catch (err) {
      return { success: false, message: err.message };
    }
  });

  // 配置恢复数据
  ipcMain.handle('backend-get-recovery-data', () => {
    return getConfigRecoveryData();
  });

  // 检查 setup 是否完成
  ipcMain.handle('backend-is-setup-complete', () => {
    return constants.isSetupComplete();
  });

  // ── Gateway RPC 聊天（走完整 Agent loop） ──

  // 发送聊天消息（Agent loop 模式）
  ipcMain.handle('gateway-chat-send', async (_event, { message, sessionKey }) => {
    if (!rpcClient || !rpcClient.isConnected()) {
      return { success: false, error: 'Gateway RPC 未连接' };
    }
    try {
      const result = await rpcClient.chatSend(message, sessionKey);
      return { success: true, result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 中止当前运行
  ipcMain.handle('gateway-chat-abort', async (_event, { runId, sessionKey } = {}) => {
    if (!rpcClient || !rpcClient.isConnected()) {
      return { success: false, error: 'Gateway RPC 未连接' };
    }
    try {
      await rpcClient.chatAbort(runId, sessionKey);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 获取聊天历史
  ipcMain.handle('gateway-chat-history', async (_event, { sessionKey, limit } = {}) => {
    if (!rpcClient || !rpcClient.isConnected()) {
      return { success: false, error: 'Gateway RPC 未连接' };
    }
    try {
      const result = await rpcClient.chatHistory(sessionKey, limit);
      return { success: true, result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 获取 RPC 连接状态
  ipcMain.handle('gateway-rpc-status', () => {
    return {
      connected: rpcClient ? rpcClient.isConnected() : false,
      sessionKey: rpcClient ? rpcClient.getSessionKey() : null,
    };
  });

  console.log('[backend] IPC handlers 已注册');
}

module.exports = {
  init,
  startGateway,
  stopGateway,
  connectGatewayRpc,
  getGatewayInfo,
  registerIPC,
  constants,
};
