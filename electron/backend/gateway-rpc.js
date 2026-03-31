/**
 * gateway-rpc.js — Gateway WebSocket RPC 持久连接客户端
 * 
 * 参考 QQClaw 的 src/gateway-rpc.ts 和 chat-ui/ui/src/ui/gateway.ts 实现。
 * 在 Electron 主进程中建立 WebSocket 长连接到 Gateway，支持：
 * - Challenge-Response 握手
 * - chat.send RPC（发送消息到 Agent loop）
 * - chat.abort RPC（中止运行中的 Agent）
 * - 接收 chat/agent 事件推送（流式回复 + 工具调用进度）
 * - 自动重连（指数退避）
 */

'use strict';

const crypto = require('crypto');
const { WebSocket } = require('ws');

const TAG = '[gateway-rpc]';

// ── 协议常量 ──
const MIN_BACKOFF_MS = 800;
const MAX_BACKOFF_MS = 15000;
const BACKOFF_MULTIPLIER = 1.7;
const DEFAULT_SESSION_KEY = 'agent:main:main';

class GatewayRpcClient {
  constructor(opts) {
    this.url = opts.url;                     // ws://127.0.0.1:19790/
    this.token = opts.token;                 // Gateway auth token
    this.onChatEvent = opts.onChatEvent;     // (payload) => void — chat delta/final/error
    this.onAgentEvent = opts.onAgentEvent;   // (payload) => void — tool start/end, lifecycle
    this.onConnected = opts.onConnected;     // () => void
    this.onDisconnected = opts.onDisconnected; // () => void

    this.ws = null;
    this.pending = new Map();   // id → { resolve, reject }
    this.closed = false;
    this.backoffMs = MIN_BACKOFF_MS;
    this.connectNonce = null;
    this.connectSent = false;
    this.connectTimer = null;
    this.isReady = false;
    this.readyResolve = null;
    this.readyPromise = new Promise(r => { this.readyResolve = r; });

    // 当前活跃的 sessionKey（hello-ok snapshot 中获取）
    this.sessionKey = DEFAULT_SESSION_KEY;
  }

  // ── 生命周期 ──

  start() {
    this.closed = false;
    this.connect();
  }

  stop() {
    this.closed = true;
    this.isReady = false;
    this.connectSent = false;
    this.connectNonce = null;
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    this.flushPending(new Error('gateway client stopped'));
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }

  getSessionKey() {
    return this.sessionKey;
  }

  isConnected() {
    return this.isReady && this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  // ── 公开 RPC 方法 ──

  /**
   * 发送聊天消息（走 Agent loop）
   * @param {string} message - 消息文本
   * @param {string} [sessionKey] - 可选，默认 agent:main:main
   * @returns {Promise<object>} - chat.send 响应
   */
  async chatSend(message, sessionKey) {
    await this.whenReady();
    const key = sessionKey || this.sessionKey;
    const idempotencyKey = crypto.randomUUID();
    return this.sendRequest('chat.send', {
      sessionKey: key,
      message,
      deliver: false,
      idempotencyKey,
    });
  }

  /**
   * 中止当前运行
   * @param {string} [runId] - 可选，指定中止哪个 run
   * @param {string} [sessionKey] - 可选
   */
  async chatAbort(runId, sessionKey) {
    await this.whenReady();
    const key = sessionKey || this.sessionKey;
    const params = { sessionKey: key };
    if (runId) params.runId = runId;
    return this.sendRequest('chat.abort', params);
  }

  /**
   * 获取聊天历史
   */
  async chatHistory(sessionKey, limit = 50) {
    await this.whenReady();
    const key = sessionKey || this.sessionKey;
    return this.sendRequest('chat.history', {
      sessionKey: key,
      limit,
    });
  }

  // ── 内部连接管理 ──

  connect() {
    if (this.closed) return;
    console.log(`${TAG} websocket opening ${this.url}`);

    try {
      this.ws = new WebSocket(this.url);
    } catch (err) {
      console.error(`${TAG} WebSocket constructor error:`, err.message);
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      console.log(`${TAG} websocket opened`);
      this.queueConnect();
    });

    this.ws.on('message', (data) => {
      this.handleMessage(String(data));
    });

    this.ws.on('close', (code, reason) => {
      const r = String(reason || '');
      this.ws = null;
      this.isReady = false;
      console.warn(`${TAG} websocket closed code=${code} reason=${r}`);
      this.flushPending(new Error(`gateway closed (${code}): ${r}`));
      if (this.onDisconnected) this.onDisconnected();
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      console.error(`${TAG} websocket error:`, err.message);
    });
  }

  scheduleReconnect() {
    if (this.closed) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * BACKOFF_MULTIPLIER, MAX_BACKOFF_MS);
    console.warn(`${TAG} scheduling reconnect in ${delay}ms`);
    this.readyPromise = new Promise(r => { this.readyResolve = r; });
    setTimeout(() => this.connect(), delay);
  }

  flushPending(err) {
    for (const [, p] of this.pending) {
      p.reject(err);
    }
    this.pending.clear();
  }

  queueConnect() {
    this.connectNonce = null;
    this.connectSent = false;
    if (this.connectTimer) clearTimeout(this.connectTimer);
    // 等 challenge 事件；750ms 内未收到则直接发送（兼容老版本）
    this.connectTimer = setTimeout(() => {
      this.sendConnect();
    }, 750);
  }

  sendConnect() {
    if (this.connectSent) return;
    this.connectSent = true;
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }

    const params = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: 'gateway-client',
        displayName: 'QQ宠物',
        version: '1.0',
        platform: process.platform,
        mode: 'webchat',
      },
      auth: { token: this.token },
      role: 'operator',
      scopes: ['operator.admin'],
      caps: ['tool-events'],
    };

    this.sendRequest('connect', params)
      .then((hello) => {
        console.log(`${TAG} connect handshake ok`);
        this.backoffMs = MIN_BACKOFF_MS;
        this.isReady = true;
        if (this.readyResolve) this.readyResolve();

        // 从 snapshot 提取 sessionKey
        const snapshot = hello && hello.snapshot;
        if (snapshot && snapshot.sessionDefaults && snapshot.sessionDefaults.mainSessionKey) {
          this.sessionKey = snapshot.sessionDefaults.mainSessionKey;
          console.log(`${TAG} sessionKey from snapshot: ${this.sessionKey}`);
        }

        if (this.onConnected) this.onConnected();
      })
      .catch((err) => {
        console.error(`${TAG} connect handshake failed:`, err.message);
        if (this.ws) {
          try { this.ws.close(4008, 'connect failed'); } catch {}
        }
      });
  }

  handleMessage(raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error(`${TAG} message parse error`);
      return;
    }

    // Challenge 事件
    if (parsed.type === 'event' && parsed.event === 'connect.challenge') {
      const nonce = parsed.payload && parsed.payload.nonce;
      if (nonce) {
        this.connectNonce = nonce;
        this.sendConnect();
      }
      return;
    }

    // 其他事件
    if (parsed.type === 'event') {
      this.dispatchEvent(parsed);
      return;
    }

    // 响应帧
    if (parsed.type === 'res') {
      const pending = this.pending.get(parsed.id);
      if (!pending) return;
      this.pending.delete(parsed.id);
      if (parsed.ok) {
        pending.resolve(parsed.payload);
      } else {
        const errMsg = parsed.error && parsed.error.message ? parsed.error.message : 'request failed';
        pending.reject(new Error(errMsg));
      }
    }
  }

  dispatchEvent(evt) {
    if (evt.event === 'chat') {
      console.log(`${TAG} chat event: state=${evt.payload?.state} runId=${(evt.payload?.runId || '').slice(0,8)}`);
      if (this.onChatEvent) {
        try { this.onChatEvent(evt.payload); } catch (e) {
          console.error(`${TAG} chat event handler error:`, e);
        }
      }
      return;
    }

    if (evt.event === 'agent') {
      const p = evt.payload || {};
      console.log(`${TAG} agent event: stream=${p.stream} phase=${p.data?.phase} name=${p.data?.name || ''}`);
      if (this.onAgentEvent) {
        try { this.onAgentEvent(evt.payload); } catch (e) {
          console.error(`${TAG} agent event handler error:`, e);
        }
      }
      return;
    }

    // 其他事件（presence, cron 等）暂不处理
  }

  sendRequest(method, params) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('gateway not connected'));
    }
    const id = crypto.randomUUID();
    const frame = { type: 'req', id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(frame));
    });
  }

  whenReady() {
    if (this.isReady) return Promise.resolve();
    return this.readyPromise;
  }
}

module.exports = { GatewayRpcClient };
