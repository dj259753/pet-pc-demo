/**
 * gateway-process.js — OpenClaw Gateway 子进程管理
 * 从 QQClaw src/gateway-process.ts 移植
 * 负责 spawn Gateway 子进程、健康检查、崩溃恢复
 */

'use strict';

const { spawn, execFileSync } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { app, dialog } = require('electron');
const {
  DEFAULT_PORT,
  HEALTH_TIMEOUT_MS,
  HEALTH_POLL_INTERVAL_MS,
  CRASH_COOLDOWN_MS,
  resolveGatewayLogPath,
  resolveNodeBin,
  resolveNpmBin,
  resolveGatewayEntry,
  resolveGatewayCwd,
  resolveResourcesPath,
  resolveUserStateDir,
} = require('./constants');

// 诊断日志
const LOG_PATH = resolveGatewayLogPath();

function diagLog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stderr.write(line);
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, line);
  } catch {}
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function maskToken(token) {
  if (token.length <= 8) return '***';
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

class GatewayProcess {
  constructor(opts) {
    this.proc = null;
    this.state = 'stopped';   // 'stopped' | 'starting' | 'running' | 'stopping'
    this.port = opts.port ?? DEFAULT_PORT;
    this.token = opts.token;
    this.extraEnv = {};
    this.lastCrashTime = 0;
    this.onStateChange = opts.onStateChange || null;
    this.onAgentLog = opts.onAgentLog || null;  // 回调：解析到 agent 事件时触发
  }

  getState() { return this.state; }
  getPort() { return this.port; }
  getToken() { return this.token; }

  setToken(token) {
    const trimmed = token.trim();
    if (trimmed) this.token = trimmed;
  }

  setExtraEnv(env) {
    this.extraEnv = { ...this.extraEnv, ...env };
  }

  // 启动 Gateway 子进程
  async start() {
    if (this.state === 'running' || this.state === 'starting') return;

    // 崩溃冷却期
    const elapsed = Date.now() - this.lastCrashTime;
    if (this.lastCrashTime > 0 && elapsed < CRASH_COOLDOWN_MS) {
      await sleep(CRASH_COOLDOWN_MS - elapsed);
    }

    this._setState('starting');

    // Windows: 首次启动解压 tar.gz 资源包
    await this._extractTarGzResources();

    const nodeBin = resolveNodeBin();
    const entry = resolveGatewayEntry();
    const cwd = resolveGatewayCwd();

    diagLog(`--- gateway start ---`);
    diagLog(`platform=${process.platform} arch=${process.arch} packaged=${app.isPackaged}`);
    diagLog(`resourcesPath=${resolveResourcesPath()}`);
    diagLog(`nodeBin=${nodeBin} exists=${fs.existsSync(nodeBin)}`);
    diagLog(`entry=${entry} exists=${fs.existsSync(entry)}`);
    diagLog(`cwd=${cwd} exists=${fs.existsSync(cwd)}`);
    diagLog(`token=${maskToken(this.token)} port=${this.port}`);

    // 检查关键文件
    if (!fs.existsSync(nodeBin)) {
      diagLog('FATAL: node 二进制不存在');
      this._setState('stopped');
      return;
    }
    if (!fs.existsSync(entry)) {
      diagLog('FATAL: gateway 入口不存在');
      this._setState('stopped');
      return;
    }
    if (!fs.existsSync(cwd)) {
      diagLog(`FATAL: gateway 工作目录不存在: ${cwd}`);
      this._setState('stopped');
      return;
    }

    // 端口冲突处理
    const portBusy = await this._probeHealth();
    if (portBusy) {
      diagLog(`WARN: 端口 ${this.port} 已有服务响应，尝试自动停止旧 gateway`);
      await this._stopExistingGateway(nodeBin, entry, cwd);
    }

    // 组装 PATH
    const runtimeDir = path.join(resolveResourcesPath(), 'runtime');
    const pathParts = [runtimeDir, process.env.PATH ?? ''];
    const envPath = pathParts.join(path.delimiter);

    const args = [entry, 'gateway', 'run', '--port', String(this.port), '--bind', 'loopback'];
    diagLog(`spawn: ${nodeBin} ${args.join(' ')}`);

    this.proc = spawn(nodeBin, args, {
      cwd,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        OPENCLAW_NO_RESPAWN: '1',
        OPENCLAW_LENIENT_CONFIG: '1',
        OPENCLAW_GATEWAY_PORT: String(this.port),
        OPENCLAW_GATEWAY_TOKEN: this.token,
        OPENCLAW_DISABLE_BONJOUR: '1',
        OPENCLAW_NPM_BIN: resolveNpmBin(),
        OPENCLAW_STATE_DIR: resolveUserStateDir(),
        PATH: envPath,
        ...this.extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const childPid = this.proc.pid ?? -1;

    this.proc.on('error', (err) => {
      diagLog(`spawn error: ${err.message}`);
    });

    this.proc.stdout?.on('data', (d) => {
      const s = d.toString();
      process.stdout.write(`[gateway] ${s}`);
      diagLog(`stdout: ${s.trimEnd()}`);
      this._parseAgentLog(s);
    });
    this.proc.stderr?.on('data', (d) => {
      const s = d.toString();
      process.stderr.write(`[gateway] ${s}`);
      diagLog(`stderr: ${s.trimEnd()}`);
      this._parseAgentLog(s);
    });

    this.proc.on('exit', (code, signal) => {
      diagLog(`child exit: code=${code} signal=${signal} prevState=${this.state}`);
      if (this.state === 'stopping') {
        this._setState('stopped');
      } else if (this.state === 'running') {
        diagLog('WARN: gateway 运行中意外退出');
        this.lastCrashTime = Date.now();
        this._setState('stopped');
      } else {
        this.lastCrashTime = Date.now();
        this._setState('stopped');
      }
      this.proc = null;
    });

    // 轮询健康检查
    const healthy = await this._waitForHealth(HEALTH_TIMEOUT_MS, childPid);
    if (healthy) {
      await sleep(300);
      if (this._isChildAlive(childPid)) {
        diagLog('health check passed, child alive');
        this._setState('running');
      } else {
        diagLog('WARN: health check passed 但子进程已退出');
        this._setState('stopped');
      }
    } else {
      diagLog('FATAL: health check timeout');
      this.stop();
    }
  }

  // 停止 Gateway
  stop() {
    if (!this.proc || this.state === 'stopped' || this.state === 'stopping') return;
    this._setState('stopping');
    this.proc.kill('SIGTERM');

    const p = this.proc;
    setTimeout(() => {
      if (p && !p.killed) {
        p.kill('SIGKILL');
        this._setState('stopped');
      }
    }, 5000);
  }

  // 重启
  async restart() {
    this.stop();
    await sleep(1000);
    await this.start();
  }

  // ── 内部方法 ──

  async _stopExistingGateway(nodeBin, entry, cwd) {
    try {
      const stateDir = resolveUserStateDir();
      diagLog(`exec: gateway stop (stateDir=${stateDir})`);
      execFileSync(nodeBin, [entry, 'gateway', 'stop'], {
        cwd,
        timeout: 10_000,
        stdio: 'pipe',
        windowsHide: true,
        env: {
          ...process.env,
          OPENCLAW_NO_RESPAWN: '1',
          OPENCLAW_LENIENT_CONFIG: '1',
          OPENCLAW_STATE_DIR: stateDir,
        },
      });
      diagLog('旧 gateway 已停止');
    } catch (err) {
      diagLog(`旧 gateway stop 失败: ${err.message ?? err}`);
    }

    // 等端口释放（最多 5s）
    for (let i = 0; i < 10; i++) {
      await sleep(500);
      if (!(await this._probeHealth())) {
        diagLog('端口已释放');
        return;
      }
    }

    // 直接 kill
    diagLog(`WARN: 优雅停止超时，尝试直接 kill 端口 ${this.port}`);
    this._killProcessOnPort(this.port);

    for (let i = 0; i < 6; i++) {
      await sleep(500);
      if (!(await this._probeHealth())) {
        diagLog('端口已释放（kill 后）');
        return;
      }
    }
    diagLog('WARN: 等待端口释放超时，继续尝试启动');
  }

  _killProcessOnPort(port) {
    try {
      const { execSync } = require('child_process');
      let pids = [];

      if (process.platform === 'win32') {
        const output = execSync(
          `netstat -ano | findstr "LISTENING" | findstr ":${port} "`,
          { timeout: 5_000, encoding: 'utf8', windowsHide: true }
        ).trim();
        for (const line of output.split('\n')) {
          const parts = line.trim().split(/\s+/);
          const pid = parts[parts.length - 1];
          if (pid && /^\d+$/.test(pid)) pids.push(pid);
        }
      } else {
        const output = execSync(
          `lsof -ti :${port} -sTCP:LISTEN 2>/dev/null || true`,
          { timeout: 5_000, encoding: 'utf8' }
        ).trim();
        pids = output.split('\n').map(s => s.trim()).filter(Boolean);
      }

      const uniquePids = [...new Set(pids)];
      for (const pid of uniquePids) {
        const pidNum = Number(pid);
        if (pidNum > 0 && pidNum !== process.pid) {
          diagLog(`kill 端口占用进程: pid=${pid}`);
          try {
            if (process.platform === 'win32') {
              execSync(`taskkill /F /PID ${pidNum}`, { timeout: 5_000, windowsHide: true });
            } else {
              process.kill(pidNum, 'SIGTERM');
            }
          } catch (e) {
            diagLog(`kill pid=${pid} 失败: ${e.message}`);
            if (process.platform !== 'win32') {
              try { process.kill(pidNum, 'SIGKILL'); } catch {}
            }
          }
        }
      }
    } catch (err) {
      diagLog(`killProcessOnPort 失败: ${err.message ?? err}`);
    }
  }

  _probeHealth() {
    return new Promise(resolve => {
      const req = http.get(`http://127.0.0.1:${this.port}/`, (res) => {
        resolve(res.statusCode === 200);
        res.resume();
      });
      req.on('error', () => resolve(false));
      req.setTimeout(2000, () => { req.destroy(); resolve(false); });
    });
  }

  async _waitForHealth(timeoutMs, childPid) {
    if (childPid <= 0) return false;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this._isChildAlive(childPid)) {
        diagLog(`health check aborted: child exited pid=${childPid}`);
        return false;
      }
      if (await this._probeHealth()) return true;
      await sleep(HEALTH_POLL_INTERVAL_MS);
    }
    return false;
  }

  _isChildAlive(childPid) {
    return !!this.proc && this.proc.pid === childPid && this.proc.exitCode == null;
  }

  _setState(s) {
    const prev = this.state;
    this.state = s;
    diagLog(`state: ${prev} → ${s}`);
    if (this.onStateChange) this.onStateChange(s);
  }

  /**
   * 从 Gateway 子进程日志中解析 agent 事件
   * OpenClaw 的 pi-embedded-runner 会输出类似:
   *   "embedded run tool start: runId=xxx tool=read toolCallId=yyy"
   *   "embedded run tool end: runId=xxx tool=read toolCallId=yyy"
   *   "embedded run agent start: runId=xxx"
   *   "embedded run agent end: runId=xxx"
   *   "embedded run compaction start: runId=xxx"
   */
  _parseAgentLog(text) {
    if (!this.onAgentLog) return;
    const lines = text.split('\n');
    for (const line of lines) {
      // tool start
      let m = line.match(/embedded run tool start:.*?tool=(\S+)/);
      if (m) {
        this.onAgentLog({ type: 'tool_start', name: m[1] });
        continue;
      }
      // tool end
      m = line.match(/embedded run tool end:.*?tool=(\S+)/);
      if (m) {
        this.onAgentLog({ type: 'tool_end', name: m[1] });
        continue;
      }
      // agent start
      if (line.includes('embedded run agent start:')) {
        this.onAgentLog({ type: 'agent_start' });
        continue;
      }
      // agent end
      if (line.includes('embedded run agent end:')) {
        this.onAgentLog({ type: 'agent_end' });
        continue;
      }
      // compaction
      if (line.includes('embedded run compaction start:')) {
        this.onAgentLog({ type: 'compaction_start' });
        continue;
      }
    }
  }

  // Windows 首次启动：解压 tar.gz
  async _extractTarGzResources() {
    const resourcesBase = resolveResourcesPath();
    const targets = ['runtime', 'gateway'];

    for (const name of targets) {
      const tarGzPath = path.join(resourcesBase, `${name}.tar.gz`);
      const dirPath = path.join(resourcesBase, name);

      if (!fs.existsSync(tarGzPath)) continue;
      if (fs.existsSync(dirPath)) {
        diagLog(`[extract] ${name}/ 已存在，删除残留 ${name}.tar.gz`);
        try { fs.unlinkSync(tarGzPath); } catch {}
        continue;
      }

      let success = false;
      while (!success) {
        diagLog(`[extract] 检测到 ${name}.tar.gz，开始解压...`);
        const startTime = Date.now();
        try {
          execFileSync('tar', ['-xzf', tarGzPath, '-C', resourcesBase], {
            timeout: 120_000,
            windowsHide: true,
          });
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          diagLog(`[extract] ${name}.tar.gz 解压完成 (${elapsed}s)`);
          try { fs.unlinkSync(tarGzPath); } catch {}
          success = true;
        } catch (err) {
          diagLog(`[extract] ${name}.tar.gz 解压失败: ${err.message ?? err}`);
          if (fs.existsSync(dirPath)) {
            try { fs.rmSync(dirPath, { recursive: true, force: true }); } catch {}
          }
          const result = await dialog.showMessageBox({
            type: 'error',
            title: '资源初始化失败',
            message: '资源解压失败，请重试。',
            detail: `文件: ${name}.tar.gz\n错误: ${err.message ?? err}`,
            buttons: ['重试', '退出应用'],
            defaultId: 0,
          });
          if (result.response === 1) {
            app.quit();
            return;
          }
        }
      }
    }
  }
}

module.exports = { GatewayProcess };
