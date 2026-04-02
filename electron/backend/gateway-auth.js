/**
 * gateway-auth.js — Gateway Token 生成与管理
 * 从 QQClaw src/gateway-auth.ts 移植
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { resolveUserConfigPath } = require('./constants');
const { backupCurrentUserConfig } = require('./config-backup');

const FILE_ORIGIN_NULL = 'null';

/** 为 Electron file:// 页面补全 Control UI 的 null origin 白名单 */
function ensureControlUiAllowedOriginsInConfig(config) {
  config.gateway ??= {};
  config.gateway.controlUi ??= {};

  const controlUi = config.gateway.controlUi;
  const rawAllowedOrigins = Array.isArray(controlUi.allowedOrigins) ? controlUi.allowedOrigins : [];
  const normalized = rawAllowedOrigins
    .filter(v => typeof v === 'string')
    .map(v => v.trim())
    .filter(Boolean);

  if (!normalized.some(v => v.toLowerCase() === FILE_ORIGIN_NULL)) {
    normalized.push(FILE_ORIGIN_NULL);
  }
  controlUi.allowedOrigins = normalized;
}

/** 统一整理 gateway.auth：确保 mode=token 且 token 存在 */
function ensureGatewayAuthTokenInConfig(config) {
  config.gateway ??= {};
  config.gateway.auth ??= {};

  const auth = config.gateway.auth;
  const token = typeof auth.token === 'string' ? auth.token.trim() : '';
  const resolvedToken = token || crypto.randomBytes(16).toString('hex');

  auth.mode = 'token';
  auth.token = resolvedToken;

  if (typeof config.gateway.mode !== 'string' || !config.gateway.mode.trim()) {
    config.gateway.mode = 'local';
  }

  return resolvedToken;
}

/**
 * 从 openclaw.json 读取（或补全）gateway token。
 * @param {object} opts - { persist?: boolean }
 * @returns {string} token
 */
function resolveGatewayAuthToken(opts = {}) {
  const configPath = resolveUserConfigPath();
  if (!fs.existsSync(configPath)) {
    return crypto.randomBytes(16).toString('hex');
  }

  let config;
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    config = JSON.parse(raw);
  } catch {
    return crypto.randomBytes(16).toString('hex');
  }

  // 只读模式
  if (opts.persist === false) {
    const token = typeof config.gateway?.auth?.token === 'string' ? config.gateway.auth.token.trim() : '';
    return token || crypto.randomBytes(16).toString('hex');
  }

  const before = JSON.stringify(config);
  const token = ensureGatewayAuthTokenInConfig(config);
  const after = JSON.stringify(config);

  if (before !== after) {
    try {
      backupCurrentUserConfig();
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    } catch {}
  }

  return token;
}

/**
 * DMG 内置 Gateway：必须开启 HTTP `/v1/chat/completions`（宠物渲染进程直连本机 Gateway），
 * 并允许 Electron `file://` 对应的 `null` origin（与 shell 安装脚本改 openclaw.json 的行为一致）。
 * 仅走应用内向导、从未跑过 install.sh 的用户依赖此处补全。
 */
function mergePetGatewayDefaultsForBundledApp(config) {
  ensureControlUiAllowedOriginsInConfig(config);
  config.gateway ??= {};
  config.gateway.http ??= {};
  config.gateway.http.endpoints ??= {};
  const chat = config.gateway.http.endpoints.chatCompletions ??= {};
  if (chat.enabled !== false) {
    chat.enabled = true;
  }
}

module.exports = {
  ensureGatewayAuthTokenInConfig,
  resolveGatewayAuthToken,
  ensureControlUiAllowedOriginsInConfig,
  mergePetGatewayDefaultsForBundledApp,
};
