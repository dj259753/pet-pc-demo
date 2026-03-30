'use strict';
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');
const { exec, execSync } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const HOME = os.homedir();

// ─── 允许读取本地 HTTP（本地端口探测需要）───
app.commandLine.appendSwitch('disable-features', 'BlockInsecurePrivateNetworkRequests');

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width:    1050,   // 700 × 1.5
    height:   750,    // 500 × 1.5
    minWidth: 840,
    minHeight: 600,
    resizable: true,
    frame: true,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 16 },
    vibrancy: 'under-window',
    visualEffectState: 'active',
    backgroundColor: '#F2F2F7',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  // win.webContents.openDevTools({ mode: 'detach' }); // 调试时打开
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

// ══════════════════════════════════════════════════
// IPC: 端口扫描（主进程用 fetch + lsof）
// ══════════════════════════════════════════════════

function getFullEnv() {
  const env = { ...process.env };
  const extra = ['/usr/local/bin','/opt/homebrew/bin','/opt/homebrew/sbin','/usr/bin','/bin','/usr/sbin','/sbin'];
  const cur = env.PATH || '';
  const missing = extra.filter(p => !cur.includes(p));
  if (missing.length) env.PATH = missing.join(':') + ':' + cur;
  return env;
}

// 探测端口是否存活，同时尝试从响应体识别 clawType
// 返回: { alive: bool, detectedType: 'openclaw'|'qqclaw'|null }
async function probePort(port, token = '') {
  try {
    const url = `http://127.0.0.1:${port}/v1/models`;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(1500),
    });
    const alive = res.status === 200 || res.status === 401 || res.status === 403;
    if (!alive) return { alive: false, detectedType: null };

    let detectedType = null;
    if (res.status === 200) {
      try {
        const body = await res.json();
        const modelIds = (body?.data || []).map(m => String(m?.id || '').toLowerCase()).join(' ');
        const bodyStr  = JSON.stringify(body).toLowerCase();
        if (bodyStr.includes('openclaw') || modelIds.includes('openclaw')) {
          detectedType = 'openclaw';
        } else if (bodyStr.includes('qqclaw') || modelIds.includes('qqclaw')) {
          detectedType = 'qqclaw';
        }
        const serverName = String(body?.server_name || body?.server_type || '').toLowerCase();
        if (!detectedType && serverName) {
          if (serverName.includes('openclaw')) detectedType = 'openclaw';
          else if (serverName.includes('qqclaw')) detectedType = 'qqclaw';
        }
      } catch {}
    }
    return { alive: true, detectedType };
  } catch {
    return { alive: false, detectedType: null };
  }
}

function extractTokenFromConfig(cfg) {
  return String(
    cfg?.token ||
    cfg?.api_key ||
    cfg?.apiKey ||
    cfg?.auth?.token ||
    cfg?.gateway?.auth?.token ||
    cfg?.gateway?.http?.auth?.token ||
    ''
  ).trim();
}

// 读取本地 openclaw.json 里的 token / 端口 / model
// 优先读 .openclaw（更常见），qqclaw 退而次之
function readClawConfigFrom(configPath) {
  try {
    if (!fs.existsSync(configPath)) return null;
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const token = extractTokenFromConfig(cfg);
    const port  = String(cfg?.gateway?.port || cfg?.gateway?.apiPort || '').trim();
    const modelRaw = cfg?.agents?.defaults?.model;
    const model = String(
      typeof modelRaw === 'string' ? modelRaw :
      (modelRaw?.primary || modelRaw?.name || '')
    ).trim();
    return { token, port, model, source: configPath };
  } catch {
    return null;
  }
}

function readLocalClawConfig() {
  const ocPath = path.join(HOME, '.openclaw', 'openclaw.json');
  const qqPath = path.join(HOME, '.qqclaw',  'openclaw.json');
  const ocCfg = readClawConfigFrom(ocPath);
  const qqCfg = readClawConfigFrom(qqPath);
  const ocValid = ocCfg && (ocCfg.token || ocCfg.port);
  const qqValid = qqCfg && (qqCfg.token || qqCfg.port);
  if (ocValid) return ocCfg;
  if (qqValid) return qqCfg;
  return { token: '', port: '', model: '', source: '' };
}

async function probeChatEndpoint(url, token = '', model = 'openclaw:main') {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(1800),
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        temperature: 0,
        max_tokens: 1,
        stream: false,
      }),
    });
    return res.status !== 404;
  } catch {
    return false;
  }
}

async function detectChatApiUrl(port, token = '', model = 'openclaw:main') {
  const candidates = [
    `/v1/chat/completions`,
    `/openai/v1/chat/completions`,
    `/api/openai/v1/chat/completions`,
    `/api/v1/chat/completions`,
    `/chat/completions`,
  ];
  for (const pathname of candidates) {
    const url = `http://127.0.0.1:${port}${pathname}`;
    if (await probeChatEndpoint(url, token, model)) return url;
  }
  return '';
}

function ensureChatCompletionsEnabled(configPath) {
  try {
    if (!configPath || !fs.existsSync(configPath)) return { changed: false, error: '' };
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    cfg.gateway = cfg.gateway || {};
    cfg.gateway.http = cfg.gateway.http || {};
    cfg.gateway.http.endpoints = cfg.gateway.http.endpoints || {};
    const current = cfg.gateway.http.endpoints.chatCompletions;
    if (current && typeof current === 'object' && current.enabled === true) {
      return { changed: false, error: '' };
    }
    cfg.gateway.http.endpoints.chatCompletions = {
      ...(current && typeof current === 'object' ? current : {}),
      enabled: true,
    };
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
    return { changed: true, error: '' };
  } catch (e) {
    return { changed: false, error: e.message };
  }
}

// 判断端口归属：四级优先级
// 1. API 响应体自报
// 2. 配置文件来源路径
// 3. 只安装了其中一个
// 4. 端口号兜底
function guessClawType(port, installed, configSource, detectedType) {
  if (detectedType) return detectedType;
  if (configSource) {
    if (configSource.includes('/.openclaw/')) return 'openclaw';
    if (configSource.includes('/.qqclaw/'))  return 'qqclaw';
  }
  if (installed.openclaw && !installed.qqclaw) return 'openclaw';
  if (installed.qqclaw  && !installed.openclaw) return 'qqclaw';
  const n = Number(port);
  if (n === 19789) return 'qqclaw';
  if (n === 18789) return 'openclaw';
  return 'openclaw';
}

// 检测本地是否已安装（通过配置文件是否存在）
function detectLocalInstall() {
  const qqclaw  = fs.existsSync(path.join(HOME, '.qqclaw', 'openclaw.json'));
  const openclaw = fs.existsSync(path.join(HOME, '.openclaw', 'openclaw.json'));
  return { qqclaw, openclaw };
}

ipcMain.handle('scan-ports', async () => {
  const localCfg   = readLocalClawConfig();
  const installed  = detectLocalInstall();

  // lsof 扫描正在监听的 node/claw 相关端口
  let lsofPorts = [];
  try {
    const env = getFullEnv();
    const { stdout } = await execAsync(
      `lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -E 'node|claw|openclaw|codebuddy|workbuddy|qqclaw' | awk '{for(i=1;i<=NF;i++) if($i~/\\(LISTEN\\)/){split($(i-1),a,":");print a[length(a)];break}}'`,
      { env, timeout: 4000 }
    );
    lsofPorts = stdout.trim().split('\n').filter(Boolean).map(Number).filter(n => n > 0);
  } catch {}

  // 待探测端口列表（优先级：配置文件 > lsof > 常见默认）
  const DEFAULT_PORTS = [18789, 19789, 19791, 18888, 8080, 3000];
  const scanPorts = [...new Set([
    ...(localCfg.port ? [Number(localCfg.port)] : []),
    ...lsofPorts,
    ...DEFAULT_PORTS,
  ])];

  // 逐个探测
  let foundPort = null;
  let foundType = null;
  for (const port of scanPorts) {
    const { alive, detectedType } = await probePort(port, localCfg.token);
    if (alive) {
      foundPort = port;
      foundType = guessClawType(port, installed, localCfg.source, detectedType);
      break;
    }
  }

  const model = localCfg.model || (foundType === 'qqclaw' ? 'qqclaw:main' : 'openclaw:main');
  let apiUrl = foundPort ? await detectChatApiUrl(foundPort, localCfg.token, model) : '';
  let needsRestart = false;
  let repairNote = '';

  // OpenClaw 某些版本只开了 /v1/models，没开 chat endpoint；这里自动修正配置并提示重启
  if (foundPort && foundType === 'openclaw' && !apiUrl) {
    const repaired = ensureChatCompletionsEnabled(localCfg.source);
    if (repaired.changed) {
      needsRestart = true;
      repairNote = '已自动开启 OpenClaw 的 HTTP chatCompletions 端点，请重启 OpenClaw 后重新检测';
    } else if (repaired.error) {
      repairNote = `未检测到可用对话接口，且自动修复失败：${repaired.error}`;
    } else {
      repairNote = '未检测到可用的 OpenAI 兼容对话接口，请检查 OpenClaw 网关配置';
    }
  }

  return {
    found:     !!foundPort,
    port:      foundPort,
    type:      foundType,          // 'qqclaw' | 'openclaw' | null
    token:     localCfg.token,
    model,
    apiUrl,
    chatReady: !!apiUrl,
    needsRestart,
    repairNote,
    installed: installed,          // { qqclaw: bool, openclaw: bool }
    lsofPorts,
  };
});

// ══════════════════════════════════════════════════
// IPC: 写 AI 配置 + 安装 Agent Skills
// ══════════════════════════════════════════════════

ipcMain.handle('install-skills', async (event, { apiUrl, token, model, clawType }) => {
  try {
    // ── 根据 clawType 决定目录前缀 ──
    // QQClaw → ~/.qqclaw/  |  OpenClaw → ~/.openclaw/
    const clawHome = clawType === 'qqclaw'
      ? path.join(HOME, '.qqclaw')
      : path.join(HOME, '.openclaw');
    const agentDir  = path.join(clawHome, 'agents', 'qq-pet');
    const skillsDir = path.join(clawHome, 'workspace', 'skills', 'qq-pet');

    // 1. 写 ai-config.json（供宠物 App 读取）
    const cfgDir = path.join(HOME, '.qq-pet', 'config');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(
      path.join(cfgDir, 'ai-config.json'),
      JSON.stringify({
        provider:  clawType || 'openclaw',
        api_url:   apiUrl  || '',
        api_key:   token   || '',
        model:     model   || 'openclaw:main',
        claw_home: clawHome,          // 记录 Claw 根目录，宠物 App 里 skills 列表用
        skills_dir: skillsDir,        // 记录对应的 skills 目录
        agent_dir:  agentDir,
      }, null, 2)
    );

    // 2. 创建 Agent workspace
    const memDir = path.join(agentDir, 'memory');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(memDir,   { recursive: true });

    // 3. 复制 SOUL.md / IDENTITY.md / AGENTS.yml
    const bundledAgentDir = getAgentSrcDir();
    const agentFiles = ['SOUL.md', 'IDENTITY.md', 'AGENTS.yml'];
    const copied = [];
    for (const f of agentFiles) {
      const src = path.join(bundledAgentDir, f);
      const dst = path.join(agentDir, f);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dst);
        copied.push(f);
      }
    }

    // 4. 初始化记忆文件
    const memFile = path.join(memDir, 'MEMORY.md');
    if (!fs.existsSync(memFile)) {
      fs.writeFileSync(memFile,
        `# 🐧 小Q的记忆\n\n## 关于主人\n- 还不太了解主人，需要多互动才能记住更多！\n\n## 重要的事\n- 今天是我来到主人桌面的第一天！\n`
      );
    }

    // 5. 写入 Skill 标记文件（供 Claw 识别）
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, '_skillhub_meta.json'),
      JSON.stringify({ name: 'qq-pet', installedAt: Date.now(), source: 'bundled', version: '0.1.3' }, null, 2)
    );

    // 6. 随机性格
    const MBTI = ['ENFP','INFP','ENFJ','INFJ','ENTP','INTP','ENTJ','INTJ','ESFP','ISFP','ESFJ','ISFJ','ESTP','ISTP','ESTJ','ISTJ'];
    const personality = MBTI[Math.floor(Math.random() * MBTI.length)];
    fs.writeFileSync(
      path.join(agentDir, 'personality.json'),
      JSON.stringify({ assignedMBTI: personality, assignedDate: new Date().toISOString() }, null, 2)
    );

    return { ok: true, personality, copied, agentDir, skillsDir };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ══════════════════════════════════════════════════
// IPC: 打开外部链接
// ══════════════════════════════════════════════════

ipcMain.handle('open-url', async (_, url) => {
  await shell.openExternal(url);
  return { ok: true };
});

// ══════════════════════════════════════════════════
// IPC: 启动宠物 + 退出
// ══════════════════════════════════════════════════

ipcMain.on('launch-pet', () => {
  const startSh = path.join(HOME, '.qq-pet', 'source', 'pc-pet-demo', 'start.sh');
  if (fs.existsSync(startSh)) {
    const { spawn } = require('child_process');
    spawn('bash', [startSh], { detached: true, stdio: 'ignore' }).unref();
  }
  setTimeout(() => app.quit(), 800);
});

ipcMain.on('quit', () => app.quit());

// ══════════════════════════════════════════════════
// IPC: 调试专用 — 强制模拟特定扫描状态（Cmd+D 触发）
// ══════════════════════════════════════════════════
ipcMain.handle('debug-scan-state', async (_, state) => {
  // state: 'found-qqclaw' | 'found-openclaw' | 'offline-qqclaw' | 'offline-openclaw' | 'none'
  const fakeResults = {
    'found-qqclaw':   { found: true,  port: 19789, type: 'qqclaw',   token: 'fake-token', model: 'openclaw:main', apiUrl: 'http://127.0.0.1:19789/v1/chat/completions', installed: { qqclaw: true,  openclaw: false }, lsofPorts: [19789] },
    'found-openclaw': { found: true,  port: 18789, type: 'openclaw', token: '',           model: 'openclaw:main', apiUrl: 'http://127.0.0.1:18789/v1/chat/completions', installed: { qqclaw: false, openclaw: true  }, lsofPorts: [18789] },
    'offline-qqclaw': { found: false, port: null,  type: null,       token: '',           model: '',              apiUrl: '',                                            installed: { qqclaw: true,  openclaw: false }, lsofPorts: [] },
    'offline-openclaw': { found: false, port: null, type: null,      token: '',           model: '',              apiUrl: '',                                            installed: { qqclaw: false, openclaw: true  }, lsofPorts: [] },
    'none':           { found: false, port: null,  type: null,       token: '',           model: '',              apiUrl: '',                                            installed: { qqclaw: false, openclaw: false }, lsofPorts: [] },
  };
  return fakeResults[state] || fakeResults['none'];
});

// ══════════════════════════════════════════════════
// 工具：找 Agent 源文件目录
// ══════════════════════════════════════════════════

function getAgentSrcDir() {
  // 打包后：Resources/agents/qq-pet
  if (process.resourcesPath) {
    const p = path.join(process.resourcesPath, 'agents', 'qq-pet');
    if (fs.existsSync(p)) return p;
  }
  // 开发模式：installer/ 同级的 agents/qq-pet
  return path.join(__dirname, '..', 'agents', 'qq-pet');
}
