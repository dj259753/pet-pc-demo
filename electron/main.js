const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, dialog, globalShortcut, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { exec, execSync, spawn } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

// ─── Chromium 渲染优化 ───
// Electron 28 / Chromium 120 渲染进程在 fontations_ffi (skrifa) 中有空指针崩溃风险
// 核心解决方案：音频采集已移到主进程（ffmpeg），不再在渲染进程使用 getUserMedia/AudioContext
// 以下 flags 作为额外保护保留
app.commandLine.appendSwitch('disable-features', 'FontationsFontBackend,SkiaFontations,Fontations');
app.commandLine.appendSwitch('disable-gpu-rasterization');

let mainWindow = null;
let quickChatWindow = null;  // 屏幕居中的快捷对话窗口
let skillsWindow = null;     // Skills 接入窗口
let subtitleWindow = null;   // 语音识别字幕窗口（屏幕中下方）
let tray = null;
let isDragging = false;
let dragOffset = { x: 0, y: 0 };

// ─── 番茄钟：活动窗口监控 ───
let focusModeActive = false;
let focusMonitorInterval = null;
const DISTRACTION_KEYWORDS = ['视频', '游戏', '购物', 'YouTube', 'Bilibili', 'Steam', 'Netflix', 'Taobao', '淘宝', '京东', '抖音', 'TikTok', 'Douyin', '哔哩哔哩', 'LOL', 'bilibili'];

// ─── 剪贴板监控 ───
let clipboardHistory = [];
let lastClipboardText = '';
let clipboardInterval = null;

// ─── 进程管理 ───
let psList = null;

// ─── 网络/电量/USB 监控 ───
let batteryInterval = null;
let diskWatchInterval = null;
let lastDiskList = [];
let updateCheckTimer = null;
let lastNotifiedVersion = '';
let isUpdatingNow = false;
let shortcutsRegistered = false;
const GIT_AUTH_GUIDE_URL = 'https://doc.weixin.qq.com/sheet/e3_AaIAHAZhAG0CN0j2SDZNGRsO5ozrM?scode=AJEAIQdfAAoDICeBgIAaIAHAZhAG0&tab=BB08J2';

const SYSTEM_SETTINGS_DEFAULTS = {
  alwaysOnTop: true,
  autoLaunch: false,
  proactiveChat: true,
  layerMode: 'normal', // always | normal | desktop
  shortcuts: {
    voice: 'CommandOrControl+K',
    talk: 'CommandOrControl+U',
  },
};
let systemSettings = JSON.parse(JSON.stringify(SYSTEM_SETTINGS_DEFAULTS));

function getSystemSettingsPath() {
  return path.join(os.homedir(), '.qq-pet', 'config', 'system-settings.json');
}

function normalizeSystemSettings(raw = {}) {
  const out = {
    ...SYSTEM_SETTINGS_DEFAULTS,
    ...raw,
    shortcuts: {
      ...SYSTEM_SETTINGS_DEFAULTS.shortcuts,
      ...(raw.shortcuts || {}),
    },
  };
  if (!['always', 'normal', 'desktop'].includes(out.layerMode)) {
    out.layerMode = 'normal';
  }
  return out;
}

function loadSystemSettings() {
  try {
    const p = getSystemSettingsPath();
    if (!fs.existsSync(p)) return normalizeSystemSettings({});
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return normalizeSystemSettings(raw);
  } catch (e) {
    console.warn('读取系统设置失败:', e.message);
    return normalizeSystemSettings({});
  }
}

function saveSystemSettingsToDisk(next) {
  try {
    const p = getSystemSettingsPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `${JSON.stringify(normalizeSystemSettings(next), null, 2)}\n`, 'utf-8');
    return true;
  } catch (e) {
    console.warn('保存系统设置失败:', e.message);
    return false;
  }
}

function applyWindowLayerMode(mode) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mode === 'always') {
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    return;
  }
  if (mode === 'desktop') {
    mainWindow.setAlwaysOnTop(false);
    mainWindow.setVisibleOnAllWorkspaces(false);
    return;
  }
  mainWindow.setAlwaysOnTop(true, 'floating');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
}

function applyMainWindowSettings() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!systemSettings.alwaysOnTop) {
    mainWindow.setAlwaysOnTop(false);
    return;
  }
  applyWindowLayerMode(systemSettings.layerMode || 'normal');
}

function applyAutoLaunchSetting() {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!systemSettings.autoLaunch,
      openAsHidden: true,
    });
  } catch (e) {
    console.warn('设置开机自启动失败:', e.message);
  }
}

function registerGlobalShortcutsFromSettings() {
  globalShortcut.unregisterAll();
  const talkShortcut = systemSettings.shortcuts?.talk || 'CommandOrControl+U';
  const voiceShortcut = systemSettings.shortcuts?.voice || 'CommandOrControl+K';
  const forceUpdateShortcut = process.platform === 'darwin' ? 'Command+Shift+U' : 'Control+Shift+U';

  const talkRegistered = globalShortcut.register(talkShortcut, () => {
    console.log(`⌨️ 全局快捷键 ${talkShortcut} 触发`);
    toggleQuickChatWindow();
  });
  const voiceRegistered = globalShortcut.register(voiceShortcut, () => {
    console.log(`⌨️ 全局快捷键 ${voiceShortcut} 触发 → 切换语音聆听`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('toggle-voice-mode');
    }
  });
  const forceUpdateRegistered = globalShortcut.register(forceUpdateShortcut, () => {
    console.log('⌨️ 全局快捷键 Cmd/Ctrl+Shift+U 触发 → 强制检查更新');
    checkForUpdates('manual');
  });
  shortcutsRegistered = talkRegistered && voiceRegistered;
  console.log(`⌨️ 全局快捷键 ${talkShortcut} 注册${talkRegistered ? '成功 ✅' : '失败 ❌'}`);
  console.log(`⌨️ 全局快捷键 ${voiceShortcut} 注册${voiceRegistered ? '成功 ✅' : '失败 ❌'}`);
  console.log(`⌨️ 全局快捷键 ${forceUpdateShortcut} 注册${forceUpdateRegistered ? '成功 ✅' : '失败 ❌'}`);
}

// ─── 窗口创建 ───
function createMainWindow() {
  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;

  const winW = 320, winH = 460;
  let posX = screenW - winW - 60;
  let posY = screenH - winH - 60;
  if (posX < 0) posX = 20;
  if (posY < 0) posY = 20;

  mainWindow = new BrowserWindow({
    width: winW,
    height: winH,
    x: posX,
    y: posY,
    transparent: true,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    hasShadow: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // ─── 麦克风权限：自动授权 media（语音模式需要） ───
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowedPermissions = ['media', 'audioCapture', 'microphone'];
    if (allowedPermissions.includes(permission)) {
      console.log(`🎤 授权权限: ${permission}`);
      callback(true);
    } else {
      callback(false);
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // ─── 渲染进程崩溃自动恢复 ───
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('⚠️ 渲染进程崩溃:', details.reason, details.exitCode);
    // 延迟 500ms 后自动重载页面
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        console.log('🔄 自动重载页面...');
        mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
      }
    }, 500);
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
    // 启动剪贴板监控
    startClipboardMonitor();
    // 启动系统感知
    startSystemSensors();
  });

  // 启用点击穿透（forward 模式），渲染进程通过鼠标位置决定是否拦截
  mainWindow.setIgnoreMouseEvents(true, { forward: true });

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
    stopClipboardMonitor();
    stopFocusMonitor();
    stopSystemSensors();
  });

  applyMainWindowSettings();
}

// ─── 系统托盘 ───
function createTray() {
  const iconSize = 16;
  const canvas = Buffer.alloc(iconSize * iconSize * 4);
  for (let i = 0; i < iconSize * iconSize; i++) {
    canvas[i * 4] = 0;
    canvas[i * 4 + 1] = 120;
    canvas[i * 4 + 2] = 215;
    canvas[i * 4 + 3] = 255;
  }
  const icon = nativeImage.createFromBuffer(canvas, { width: iconSize, height: iconSize });

  tray = new Tray(icon);
  tray.setToolTip('QQ宠物');

  const contextMenu = Menu.buildFromTemplate([
    { label: '🐧 显示企鹅', click: () => { mainWindow?.show(); } },
    { label: '📊 状态面板', click: () => { mainWindow?.webContents.send('toggle-panel', 'status'); } },
    { label: '🎒 打开背包', click: () => { mainWindow?.webContents.send('toggle-panel', 'backpack'); } },
    { type: 'separator' },
    { label: '💬 AI 对话', click: () => { toggleQuickChatWindow(); } },
    { label: '🍅 番茄钟', click: () => { mainWindow?.webContents.send('start-focus-mode'); } },
    { type: 'separator' },
    { label: '❌ 退出', click: () => { app.quit(); } },
  ]);
  tray.setContextMenu(contextMenu);
  tray.on('click', () => { mainWindow?.show(); });
}

// ─── IPC 通信 ───

// 拖拽
ipcMain.on('drag-start', (event, { mouseX, mouseY }) => {
  if (!mainWindow) return;
  const [winX, winY] = mainWindow.getPosition();
  isDragging = true;
  dragOffset.x = mouseX - winX;
  dragOffset.y = mouseY - winY;
});

ipcMain.on('drag-move', (event, { mouseX, mouseY }) => {
  if (!mainWindow || !isDragging) return;
  const newX = mouseX - dragOffset.x;
  const newY = mouseY - dragOffset.y;
  mainWindow.setPosition(newX, newY);
});

ipcMain.on('drag-end', () => {
  isDragging = false;
});

// 屏幕/窗口
ipcMain.handle('get-screen-size', () => {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  return { width, height };
});

ipcMain.handle('get-window-position', () => {
  if (!mainWindow) return { x: 0, y: 0 };
  const [x, y] = mainWindow.getPosition();
  return { x, y };
});

ipcMain.on('set-window-position', (event, { x, y }) => {
  if (mainWindow) mainWindow.setPosition(Math.round(x), Math.round(y));
});

// 窗口缩放（compact / full 模式切换）
ipcMain.on('resize-window', (event, { width, height }) => {
  if (!mainWindow) return;
  mainWindow.setSize(Math.round(width), Math.round(height));
});

// 置顶状态
ipcMain.handle('get-always-on-top', () => {
  return !!systemSettings.alwaysOnTop;
});

ipcMain.on('set-always-on-top', (event, enabled) => {
  systemSettings.alwaysOnTop = !!enabled;
  saveSystemSettingsToDisk(systemSettings);
  applyMainWindowSettings();
});

// 系统信息（CPU / 内存）
ipcMain.handle('get-system-info', () => {
  const cpus = os.cpus();
  let totalIdle = 0, totalTick = 0;
  cpus.forEach(cpu => {
    for (const type in cpu.times) {
      totalTick += cpu.times[type];
    }
    totalIdle += cpu.times.idle;
  });
  const cpuUsage = Math.round((1 - totalIdle / totalTick) * 100);
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const memUsage = Math.round(((totalMem - freeMem) / totalMem) * 100);
  return { cpuUsage, memUsage };
});

ipcMain.handle('get-app-version', () => {
  return getCurrentVersion();
});

ipcMain.handle('get-system-settings', () => {
  return normalizeSystemSettings(systemSettings);
});

ipcMain.handle('save-system-settings', (event, nextSettings) => {
  systemSettings = normalizeSystemSettings(nextSettings || {});
  const ok = saveSystemSettingsToDisk(systemSettings);
  applyMainWindowSettings();
  applyAutoLaunchSetting();
  registerGlobalShortcutsFromSettings();
  return ok ? { ok: true } : { ok: false, error: 'write-failed' };
});

// 退出
ipcMain.on('quit-app', () => {
  app.quit();
});

ipcMain.handle('open-external-url', async (event, url) => {
  try {
    const target = String(url || '').trim();
    if (!/^https?:\/\//i.test(target)) {
      return { ok: false, error: 'invalid-url' };
    }
    await shell.openExternal(target);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('open-local-path', async (event, filePath) => {
  try {
    const target = String(filePath || '').trim().replace(/^~/, os.homedir());
    const err = await shell.openPath(target);
    if (err) return { ok: false, error: err };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ═══════════════════════════════════════════
// AI 配置读取（从 ~/.qq-pet/config/ai-config.json）
// ═══════════════════════════════════════════

ipcMain.handle('get-ai-config', () => {
  const configPath = path.join(os.homedir(), '.qq-pet', 'config', 'ai-config.json');
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(raw);
      return config;
    }
  } catch (e) {
    console.warn('读取 AI 配置失败:', e.message);
  }
  // 默认降级模式
  return { provider: 'local', api_url: '', api_key: '', model: '' };
});

// ═══════════════════════════════════════════
// 应用更新（自托管 manifest + zip 包）
// ═══════════════════════════════════════════
function getUpdateConfig() {
  const userConfigPath = path.join(os.homedir(), '.qq-pet', 'config', 'update-config.json');
  const bundledConfigPath = path.join(__dirname, '..', 'release', 'update-config.json');
  try {
    const configPath = fs.existsSync(userConfigPath) ? userConfigPath : bundledConfigPath;
    if (!fs.existsSync(configPath)) return null;
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (!cfg) return null;
    const manifestUrl = cfg.manifest_url || '';
    const gitRepoUrl = cfg.git_repo_url || cfg.git_version_url || ''; // git_repo_url 为 SSH 地址
    const isSsh = /^git@/.test(gitRepoUrl);
    if (!manifestUrl && !gitRepoUrl) return null;
    const requestHeaders = (cfg.request_headers && typeof cfg.request_headers === 'object')
      ? { ...cfg.request_headers }
      : {};
    // 仅 HTTPS 模式需要 token；SSH 模式不需要
    if (!isSsh) {
      const gitAuth = getGitAuthConfig();
      const tokenFromConfig = cfg.git_private_token ? String(cfg.git_private_token).trim() : '';
      const token = tokenFromConfig || gitAuth.token || '';
      if (!requestHeaders['PRIVATE-TOKEN'] && token) {
        requestHeaders['PRIVATE-TOKEN'] = token;
      }
    }
    return {
      manifestUrl,
      gitVersionUrl: isSsh ? '' : gitRepoUrl,
      gitRepoUrl: isSsh ? gitRepoUrl : '',
      checkIntervalMinutes: Number(cfg.check_interval_minutes || 1440),
      enabled: cfg.enabled !== false,
      packageUrl: cfg.package_url || '',
      requestHeaders,
      updateCacheDir: path.join(os.homedir(), '.qq-pet', 'cache', 'update-check'),
    };
  } catch (e) {
    console.warn('读取更新配置失败:', e.message);
    return null;
  }
}

function getGitAuthPath() {
  return path.join(os.homedir(), '.qq-pet', 'config', 'git-auth.json');
}

function getGitAuthConfig() {
  const authPath = getGitAuthPath();
  try {
    if (!fs.existsSync(authPath)) return { token: '', path: authPath };
    const cfg = JSON.parse(fs.readFileSync(authPath, 'utf-8') || '{}');
    return { token: String(cfg.git_private_token || '').trim(), path: authPath };
  } catch (e) {
    console.warn('读取 git 鉴权配置失败:', e.message);
    return { token: '', path: authPath };
  }
}

function saveGitAuthToken(token) {
  const authPath = getGitAuthPath();
  try {
    fs.mkdirSync(path.dirname(authPath), { recursive: true });
    const cleanToken = String(token || '').trim();
    fs.writeFileSync(authPath, `${JSON.stringify({ git_private_token: cleanToken, updated_at: new Date().toISOString() }, null, 2)}\n`, 'utf-8');
    try { fs.chmodSync(authPath, 0o600); } catch {}
    syncTokenToUpdateConfig(cleanToken);
    return { ok: true, path: authPath };
  } catch (e) {
    return { ok: false, error: e.message, path: authPath };
  }
}

function syncTokenToUpdateConfig(token) {
  const userConfigPath = path.join(os.homedir(), '.qq-pet', 'config', 'update-config.json');
  try {
    fs.mkdirSync(path.dirname(userConfigPath), { recursive: true });
    let cfg = {};
    if (fs.existsSync(userConfigPath)) {
      cfg = JSON.parse(fs.readFileSync(userConfigPath, 'utf-8') || '{}');
    }
    cfg.git_private_token = String(token || '').trim();
    if (!cfg.git_version_url) {
      cfg.git_version_url = '';
    }
    if (typeof cfg.enabled === 'undefined') cfg.enabled = true;
    if (!cfg.check_interval_minutes) cfg.check_interval_minutes = 60;
    fs.writeFileSync(userConfigPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf-8');
    try { fs.chmodSync(userConfigPath, 0o600); } catch {}
  } catch (e) {
    console.warn('同步 token 到更新配置失败:', e.message);
  }
}

async function fetchJsonWithHeaders(url, headers = {}, tag = 'json') {
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok) throw new Error(`${tag} 获取失败 ${res.status}`);
  const text = await res.text();
  const finalUrl = String(res.url || '');
  const lowText = text.slice(0, 500).toLowerCase();
  if (finalUrl.includes('passport.woa.com') || lowText.includes('<!doctype html') || lowText.includes('<html')) {
    throw new Error(`${tag} 需要鉴权，请在更新配置中填写 git_private_token`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${tag} 返回非JSON内容`);
  }
}

function getCurrentVersion() {
  try {
    return app.getVersion();
  } catch {
    return '0.0.0';
  }
}

function normalizeUpdateNotes(manifest = {}) {
  const raw = manifest.notes || manifest.changelog || manifest.release_notes || '';
  if (Array.isArray(raw)) return raw.join('\n');
  if (typeof raw === 'object' && raw) {
    return Object.entries(raw).map(([k, v]) => `- ${k}: ${String(v)}`).join('\n');
  }
  const text = String(raw || '').trim();
  return text || '（本次更新暂无详细说明）';
}

function isVersionNewer(remote, local) {
  const a = String(remote || '').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const b = String(local || '').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] || 0;
    const bv = b[i] || 0;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return false;
}

function getCurrentAppBundlePath() {
  const exe = process.execPath; // .../QQ宠物Skills版.app/Contents/MacOS/QQ宠物Skills版
  const idx = exe.indexOf('.app/Contents/');
  if (idx === -1) return null;
  return exe.slice(0, idx + 4);
}

function findFirstAppBundle(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && e.name.endsWith('.app')) return p;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const hit = findFirstAppBundle(p);
      if (hit) return hit;
    }
  }
  return null;
}

async function downloadToFile(url, outPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败 ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outPath, buf);
}

// ─── 更新进度通知辅助 ───
let updateProgressNotification = null;

function showUpdateProgress(title, message) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-progress', { title, message });
  }
}

/**
 * 获取完整的 shell 环境 PATH（Electron 打包后 PATH 不完整）
 */
function getFullShellEnv() {
  const env = { ...process.env };
  // Electron 打包后 PATH 精简，补充常用路径
  const extraPaths = [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    path.join(os.homedir(), '.nvm/versions/node'),  // nvm
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
  const currentPath = env.PATH || '';
  const missingPaths = extraPaths.filter(p => !currentPath.includes(p));
  if (missingPaths.length > 0) {
    env.PATH = missingPaths.join(':') + ':' + currentPath;
  }
  return env;
}

/**
 * 从 SSH 源码仓库自动更新：
 * 1. git clone 源码到临时目录
 * 2. npm install + electron-builder 构建 .app
 * 3. 替换当前 .app 并重启
 */
async function installUpdateFromGitSource(repoUrl, version, notes) {
  if (isUpdatingNow) {
    console.log('🔄 更新已在进行中，忽略重复请求');
    return;
  }
  isUpdatingNow = true;

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-pet-src-update-'));
  const srcDir = path.join(tmpRoot, 'src');
  const shellEnv = getFullShellEnv();

  try {
    // Step 1: Clone 源码
    showUpdateProgress('正在更新...', `正在拉取源码...`);
    console.log(`🔄 [1/4] git clone ${repoUrl} → ${srcDir}`);
    console.log(`🔄 PATH = ${shellEnv.PATH}`);

    if (fs.existsSync(srcDir)) {
      fs.rmSync(srcDir, { recursive: true, force: true });
    }
    await execAsync(
      `git clone --depth 1 "${repoUrl}" "${srcDir}" 2>&1`,
      { timeout: 120000, env: shellEnv }
    );
    console.log('✅ [1/4] 源码拉取完成');

    // Step 2: npm install
    showUpdateProgress('正在更新...', `正在安装依赖...`);
    console.log(`🔄 [2/4] npm install in ${srcDir}`);
    await execAsync(
      `cd "${srcDir}" && npm install 2>&1`,
      { timeout: 180000, env: shellEnv }
    );
    console.log('✅ [2/4] 依赖安装完成');

    // Step 3: 构建 .app
    showUpdateProgress('正在更新...', `正在构建新版本...`);
    console.log(`🔄 [3/4] electron-builder --mac in ${srcDir}`);
    await execAsync(
      `cd "${srcDir}" && npx electron-builder --mac 2>&1`,
      { timeout: 300000, env: shellEnv }
    );
    console.log('✅ [3/4] 构建完成');

    // Step 4: 找到构建产物，替换并重启
    showUpdateProgress('正在更新...', `正在替换应用...`);
    console.log('🔄 [4/4] 查找构建产物...');
    const buildOutputDir = path.join(srcDir, 'dist');
    const newAppPath = findFirstAppBundle(buildOutputDir);
    const currentAppPath = getCurrentAppBundlePath();

    if (!newAppPath) throw new Error('构建产物中未找到 .app 文件');
    if (!currentAppPath) throw new Error('无法识别当前 .app 路径');

    console.log(`📦 新 .app: ${newAppPath}`);
    console.log(`📦 当前 .app: ${currentAppPath}`);

    // 写替换脚本：等当前进程退出 → 备份旧版到 /tmp → 覆盖原位置 → 启动
    const scriptPath = path.join(tmpRoot, 'apply-update.sh');
    const escapedCurrent = currentAppPath.replace(/"/g, '\\"');
    const escapedNew = newAppPath.replace(/"/g, '\\"');
    const escapedTmpRoot = tmpRoot.replace(/"/g, '\\"');
    const script = `#!/bin/bash
set -e

TARGET="${escapedCurrent}"
NEWAPP="${escapedNew}"
PID=${process.pid}

# 等待当前进程完全退出
while kill -0 "$PID" 2>/dev/null; do sleep 0.5; done
sleep 1

# 备份旧版本到 /tmp（不留在桌面）
TS=$(date +%Y%m%d%H%M%S)
if [ -d "$TARGET" ]; then
  BACKUP_DIR="/tmp/qq-pet-backup-$TS"
  echo "📦 备份旧版本 → $BACKUP_DIR"
  mv "$TARGET" "$BACKUP_DIR"
fi

# 覆盖：复制新版本到原位置（保持同名）
echo "📦 复制新版本..."
cp -R "$NEWAPP" "$TARGET"

# 清理构建临时目录
rm -rf "${escapedTmpRoot}"

# 启动新版本
echo "🚀 启动新版本..."
open "$TARGET"
`;
    fs.writeFileSync(scriptPath, script, { mode: 0o755 });

    // 显示成功提示
    showUpdateProgress('更新完成', `正在重启应用，新版本 v${version} 即将生效...`);
    console.log('✅ [4/4] 替换脚本已生成，即将退出并应用更新');

    // 先给渲染进程 2 秒展示完成消息
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 后台执行替换脚本，然后退出当前进程
    spawn('/bin/bash', [scriptPath], {
      detached: true,
      stdio: 'ignore',
    }).unref();

    app.quit();

  } catch (e) {
    console.error('❌ 从源码更新失败:', e.message);
    showUpdateProgress('更新失败', '');
    dialog.showMessageBox({
      type: 'error',
      title: '更新失败',
      message: `更新失败：${e.message}`,
      detail: '你可以稍后重试，或手动执行 install.sh 重新安装。',
      buttons: ['知道了'],
    }).catch(() => {});
  } finally {
    isUpdatingNow = false;
  }
}

/**
 * 从 manifest URL 下载 zip 包更新（保留原有逻辑）
 */
async function installUpdateFromManifest(manifest) {
  if (isUpdatingNow) return;
  isUpdatingNow = true;
  try {
    const packageUrl = manifest.package_url;
    if (!packageUrl) throw new Error('manifest 缺少 package_url');

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-pet-update-'));
    const zipPath = path.join(tmpRoot, 'update.zip');
    const unpackDir = path.join(tmpRoot, 'unpack');
    fs.mkdirSync(unpackDir, { recursive: true });

    await downloadToFile(packageUrl, zipPath);
    await new Promise((resolve, reject) => {
      exec(`ditto -xk "${zipPath}" "${unpackDir}"`, (err) => err ? reject(err) : resolve());
    });

    const newAppPath = findFirstAppBundle(unpackDir);
    const currentAppPath = getCurrentAppBundlePath();
    if (!newAppPath) throw new Error('更新包里未找到 .app');
    if (!currentAppPath) throw new Error('无法识别当前 .app 路径');

    const scriptPath = path.join(tmpRoot, 'apply-update.sh');
    const escapedCurrent = currentAppPath.replace(/"/g, '\\"');
    const escapedNew = newAppPath.replace(/"/g, '\\"');
    const script = `#!/bin/bash
set -e
TARGET="${escapedCurrent}"
NEWAPP="${escapedNew}"
PID=${process.pid}
while kill -0 "$PID" 2>/dev/null; do sleep 0.5; done
TS=$(date +%Y%m%d%H%M%S)
if [ -d "$TARGET" ]; then
  mv "$TARGET" "/tmp/qq-pet-backup-$TS"
fi
cp -R "$NEWAPP" "$TARGET"
open "$TARGET"
`;
    fs.writeFileSync(scriptPath, script, { mode: 0o755 });

    spawn('/bin/bash', [scriptPath], {
      detached: true,
      stdio: 'ignore',
    }).unref();

    app.quit();
  } catch (e) {
    console.error('自动更新失败:', e.message);
    dialog.showMessageBox({
      type: 'error',
      title: '更新失败',
      message: `更新失败：${e.message}`,
      buttons: ['知道了'],
    }).catch(() => {});
    isUpdatingNow = false;
  }
}

async function checkForUpdates(triggeredBy = 'auto') {
  const cfg = getUpdateConfig();
  if (!cfg || !cfg.enabled) {
    return { ok: false, status: 'disabled' };
  }

  // ─── SSH 模式：通过 git ls-remote + git clone 检查更新 ───
  if (cfg.gitRepoUrl) {
    return await checkForUpdatesViaGit(cfg, triggeredBy);
  }

  // ─── HTTPS/API 模式（原有逻辑） ───
  try {
    let manifest = null;
    if (cfg.manifestUrl) {
      manifest = await fetchJsonWithHeaders(cfg.manifestUrl, cfg.requestHeaders, 'manifest');
    } else if (cfg.gitVersionUrl) {
      const gitMeta = await fetchJsonWithHeaders(cfg.gitVersionUrl, cfg.requestHeaders, 'git版本文件');
      manifest = {
        version: gitMeta.version,
        notes: gitMeta.release_notes || gitMeta.update_notes || gitMeta.notes || '',
        package_url: gitMeta.package_url || cfg.packageUrl || '',
      };
    }
    if (!manifest) return { ok: false, status: 'invalid-manifest' };
    const remoteVersion = String(manifest.version || '').trim();
    const localVersion = getCurrentVersion();
    if (!remoteVersion || !isVersionNewer(remoteVersion, localVersion)) {
      return { ok: true, status: 'up-to-date', localVersion, remoteVersion: remoteVersion || localVersion };
    }

    const notesText = normalizeUpdateNotes(manifest);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-available', {
        version: remoteVersion,
        notes: notesText,
      });
    }

    if (lastNotifiedVersion === remoteVersion && triggeredBy !== 'manual') return;
    lastNotifiedVersion = remoteVersion;

    const detail = `更新后版本号：v${remoteVersion}\n\n更新内容：\n${notesText}`;
    const hasPackage = !!manifest.package_url;
    const result = await dialog.showMessageBox({
      type: 'info',
      title: '发现新版本',
      message: hasPackage
        ? `发现新版本 v${remoteVersion}，是否立即更新并重启？`
        : `发现新版本 v${remoteVersion}，当前仅检测到版本更新。`,
      detail,
      buttons: hasPackage ? ['立即更新', '稍后'] : ['知道了'],
      defaultId: 0,
      cancelId: hasPackage ? 1 : 0,
    });
    if (hasPackage && result.response === 0) {
      await installUpdateFromManifest(manifest);
    }
    return { ok: true, status: 'update-available', localVersion, remoteVersion, hasPackage };
  } catch (e) {
    console.warn('检查更新失败:', e.message);
    return { ok: false, status: 'error', error: e.message };
  }
}

// ─── SSH 模式更新检查 ───
async function checkForUpdatesViaGit(cfg, triggeredBy) {
  const repoUrl = cfg.gitRepoUrl;
  const cacheDir = cfg.updateCacheDir;
  const localVersion = getCurrentVersion();
  const lastHashPath = path.join(cacheDir, 'last-known-hash');
  const shellEnv = getFullShellEnv();

  try {
    // 1. git ls-remote 获取远程最新 commit hash
    const { stdout: lsOutput } = await execAsync(
      `git ls-remote --heads "${repoUrl}" 2>/dev/null`,
      { timeout: 15000, env: shellEnv }
    );
    const lines = (lsOutput || '').trim().split('\n').filter(Boolean);
    if (lines.length === 0) {
      throw new Error('git ls-remote 未返回任何分支');
    }
    // 取第一个分支的 hash（通常是 master/main）
    const remoteHash = lines[0].split('\t')[0].trim();
    if (!remoteHash) {
      throw new Error('无法解析远程 commit hash');
    }

    // 2. 读取上次已知的 hash，如果相同则跳过
    let lastHash = '';
    try {
      if (fs.existsSync(lastHashPath)) {
        lastHash = fs.readFileSync(lastHashPath, 'utf-8').trim();
      }
    } catch {}
    if (lastHash === remoteHash && triggeredBy !== 'manual') {
      // hash 没变 → 用上次缓存的 version.json 检查版本号，不重新 clone
      const cachedVersionFile = path.join(cacheDir, 'repo-checkout', 'release', 'version.json');
      if (fs.existsSync(cachedVersionFile)) {
        try {
          const vd = JSON.parse(fs.readFileSync(cachedVersionFile, 'utf-8'));
          const rv = String(vd.version || '').trim();
          if (rv && isVersionNewer(rv, localVersion)) {
            const notes = normalizeUpdateNotes(vd);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('update-available', { version: rv, notes });
            }
            if (lastNotifiedVersion !== rv) {
              lastNotifiedVersion = rv;
              const result = await dialog.showMessageBox({
                type: 'info', title: '发现新版本',
                message: `发现新版本 v${rv}，是否立即更新并重启？`,
                detail: `更新内容：\n${notes}`,
                buttons: ['立即更新', '稍后'],
                defaultId: 0, cancelId: 1,
              });
              if (result.response === 0) {
                await installUpdateFromGitSource(cfg.gitRepoUrl, rv, notes);
              }
            }
            return { ok: true, status: 'update-available', localVersion, remoteVersion: rv };
          }
        } catch {}
      }
      console.log('🔄 远程仓库无变化，已是最新版本');
      return { ok: true, status: 'up-to-date', localVersion, remoteHash };
    }

    // 3. 有变化（或手动触发），clone 最新代码到临时目录
    const tmpCloneDir = path.join(cacheDir, 'repo-checkout');
    if (fs.existsSync(tmpCloneDir)) {
      fs.rmSync(tmpCloneDir, { recursive: true, force: true });
    }
    fs.mkdirSync(tmpCloneDir, { recursive: true });

    try {
      await execAsync(
        `git clone --depth 1 "${repoUrl}" "${tmpCloneDir}" 2>&1`,
        { timeout: 60000, env: shellEnv }
      );
    } catch (e) {
      // clone 失败时尝试 pull
      try {
        await execAsync(
          `cd "${tmpCloneDir}" && git fetch --depth 1 origin master && git reset --hard origin/master 2>&1`,
          { timeout: 60000, env: shellEnv }
        );
      } catch (e2) {
        throw new Error(`git clone/pull 失败: ${e.message}`);
      }
    }

    // 4. 读取 version.json
    const versionFile = path.join(tmpCloneDir, 'release', 'version.json');
    if (!fs.existsSync(versionFile)) {
      // 保存 hash 避免重复 clone，但无版本文件
      fs.mkdirSync(path.dirname(lastHashPath), { recursive: true });
      fs.writeFileSync(lastHashPath, remoteHash, 'utf-8');
      throw new Error('仓库中未找到 release/version.json');
    }
    const versionData = JSON.parse(fs.readFileSync(versionFile, 'utf-8'));
    const remoteVersion = String(versionData.version || '').trim();
    const notes = normalizeUpdateNotes(versionData);
    const packageUrl = versionData.package_url || '';

    // 5. 保存最新 hash
    fs.mkdirSync(path.dirname(lastHashPath), { recursive: true });
    fs.writeFileSync(lastHashPath, remoteHash, 'utf-8');

    // 6. 比较版本号
    if (!remoteVersion || !isVersionNewer(remoteVersion, localVersion)) {
      console.log(`🔄 本地 v${localVersion} 已是最新（远程 v${remoteVersion || localVersion}）`);
      return { ok: true, status: 'up-to-date', localVersion, remoteVersion: remoteVersion || localVersion };
    }

    // 7. 有新版本 → 通知 + 弹窗
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-available', {
        version: remoteVersion,
        notes,
      });
    }

    if (lastNotifiedVersion === remoteVersion && triggeredBy !== 'manual') {
      return { ok: true, status: 'update-available', localVersion, remoteVersion };
    }
    lastNotifiedVersion = remoteVersion;

    const detail = `更新后版本号：v${remoteVersion}\n\n更新内容：\n${notes}`;
    // SSH 模式下始终显示「立即更新」按钮（会从源码自动构建）
    const hasPackage = !!packageUrl;
    const canGitUpdate = !!cfg.gitRepoUrl; // SSH 模式支持从源码更新
    const result = await dialog.showMessageBox({
      type: 'info',
      title: '发现新版本',
      message: `发现新版本 v${remoteVersion}，是否立即更新并重启？`,
      detail,
      buttons: ['立即更新', '稍后'],
      defaultId: 0,
      cancelId: 1,
    });
    if (result.response === 0) {
      if (canGitUpdate) {
        // SSH 模式：从源码 clone → 构建 → 替换
        await installUpdateFromGitSource(cfg.gitRepoUrl, remoteVersion, notes);
      } else if (hasPackage) {
        // HTTPS 模式：下载 zip 包更新
        await installUpdateFromManifest({ version: remoteVersion, notes, package_url: packageUrl });
      } else {
        // 无更新方式
        dialog.showMessageBox({
          type: 'warning',
          title: '暂无可用的更新方式',
          message: '当前配置未指定更新包地址，请使用 install.sh 重新安装。',
          buttons: ['知道了'],
        }).catch(() => {});
      }
    }
    return { ok: true, status: 'update-available', localVersion, remoteVersion, hasPackage };
  } catch (e) {
    console.warn('SSH 更新检查失败:', e.message);
    // 手动触发时，给用户提示
    if (triggeredBy === 'manual' && mainWindow && !mainWindow.isDestroyed()) {
      dialog.showMessageBox({
        type: 'warning',
        title: '检查更新失败',
        message: `无法检查更新：${e.message}`,
        detail: '请确认 SSH Key 已正确配置，且网络可以访问 git@github.com',
        buttons: ['知道了'],
      }).catch(() => {});
    }
    return { ok: false, status: 'error', error: e.message };
  }
}

ipcMain.handle('check-updates-now', async () => {
  return await checkForUpdates('manual');
});

// 将复杂问题委托给 WorkBuddy/OpenClaw 本体（复用其完整执行链路）
ipcMain.handle('workbuddy-delegate', async (event, payload = {}) => {
  try {
    // 按优先级尝试多个配置文件路径
    const configCandidates = [
      path.join(os.homedir(), '.qqclaw', 'openclaw.json'),
      path.join(os.homedir(), '.openclaw', 'openclaw.json'),
    ];
    let configPath = null;
    for (const cp of configCandidates) {
      try {
        if (fs.existsSync(cp)) {
          const raw = fs.readFileSync(cp, 'utf-8');
          const parsed = JSON.parse(raw);
          if (parsed && parsed.gateway && parsed.gateway.auth && parsed.gateway.auth.token) {
            configPath = cp;
            break;
          }
        }
      } catch {}
    }
    if (!configPath) {
      // 回退：尝试任意一个存在的配置文件
      for (const cp of configCandidates) {
        if (fs.existsSync(cp)) { configPath = cp; break; }
      }
    }
    if (!configPath) {
      return { ok: false, error: '未找到 OpenClaw 配置文件（~/.qqclaw/openclaw.json 或 ~/.openclaw/openclaw.json）' };
    }

    const raw = fs.readFileSync(configPath, 'utf-8');
    const openclaw = JSON.parse(raw);

    const token = openclaw?.gateway?.auth?.token;
    // 从配置文件读取 gateway 端口（不硬编码）
    const cfgPort = openclaw?.gateway?.port || openclaw?.gateway?.apiPort || '';
    let aiCfg = {};
    try {
      const aiConfigPath = path.join(os.homedir(), '.qq-pet', 'config', 'ai-config.json');
      if (fs.existsSync(aiConfigPath)) {
        aiCfg = JSON.parse(fs.readFileSync(aiConfigPath, 'utf-8') || '{}');
      }
    } catch {}
    // 优先级：环境变量 > ai-config.json（安装时探测到的） > 配置文件端口 > 空（让调用方知道没有可用接口）
    const baseUrl = process.env.WORKBUDDY_API_URL
      || aiCfg.api_url
      || (cfgPort ? `http://127.0.0.1:${cfgPort}/v1/chat/completions` : '');
    const model = process.env.WORKBUDDY_MODEL || aiCfg.model || 'openclaw:main';

    if (!token) {
      return { ok: false, error: '未找到 OpenClaw 网关 token' };
    }

    const userText = payload.userText || '';
    const attachmentSummary = payload.attachmentSummary || '';
    const history = Array.isArray(payload.history) ? payload.history : [];

    const systemPrompt = [
      '你是 WorkBuddy 主执行代理。请完整使用你的工具链与多步思考流程解决用户复杂任务。',
      '返回时请提供：结论、关键步骤、产出路径/命令（如有）、下一步建议。',
      '语气务实、简洁、专业。'
    ].join('\n');

    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.slice(-20).map(m => ({ role: m.role, content: m.text || m.content || '' })),
      {
        role: 'user',
        content: `${userText}${attachmentSummary ? `\n\n${attachmentSummary}` : ''}`,
      },
    ];

    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.2,
      }),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      return { ok: false, error: `委托失败 ${res.status}: ${err.substring(0, 200)}` };
    }

    const data = await res.json();
    const reply = data?.choices?.[0]?.message?.content || '';
    if (!reply) return { ok: false, error: '本体返回为空' };

    return { ok: true, reply };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ═══════════════════════════════════════════
// 指令一：番茄钟 Focus Mode
// ═══════════════════════════════════════════

// 右键菜单（新版：设置 / 宠物永远置顶 / 退出）

ipcMain.on('show-context-menu', () => {
  if (!mainWindow) return;
  const template = [
    {
      label: '⚙️ 设置',
      click: () => {
        mainWindow.webContents.send('toggle-panel', 'settings');
        // 同时打开开始菜单
        mainWindow.webContents.send('open-start-menu');
      }
    },
    {
      label: '宠物永远置顶',
      type: 'checkbox',
      checked: !!systemSettings.alwaysOnTop,
      click: (menuItem) => {
        systemSettings.alwaysOnTop = menuItem.checked;
        saveSystemSettingsToDisk(systemSettings);
        applyMainWindowSettings();
      }
    },
    { type: 'separator' },
    {
      label: '退出 QQ 宠物',
      click: () => app.quit()
    },
  ];
  const menu = Menu.buildFromTemplate(template);
  menu.popup({ window: mainWindow });
});

// 开始专注模式监控
ipcMain.on('focus-mode-start', () => {
  focusModeActive = true;
  startFocusMonitor();
});

ipcMain.on('focus-mode-stop', () => {
  focusModeActive = false;
  stopFocusMonitor();
});

function startFocusMonitor() {
  stopFocusMonitor();
  focusMonitorInterval = setInterval(async () => {
    if (!focusModeActive || !mainWindow) return;
    try {
      // 使用 AppleScript 获取活动窗口标题 (macOS)
      const title = await getActiveWindowTitle();
      if (title && isDistraction(title)) {
        mainWindow.webContents.send('focus-distraction', { title });
        // 将窗口移到屏幕中心
        const { width: sW, height: sH } = screen.getPrimaryDisplay().workAreaSize;
        const [winW, winH] = mainWindow.getSize();
        mainWindow.setPosition(
          Math.round((sW - winW) / 2),
          Math.round((sH - winH) / 2)
        );
        mainWindow.show();
        mainWindow.focus();
      }
    } catch (e) {
      // 静默失败
    }
  }, 3000);
}

function stopFocusMonitor() {
  if (focusMonitorInterval) {
    clearInterval(focusMonitorInterval);
    focusMonitorInterval = null;
  }
}

function getActiveWindowTitle() {
  return new Promise((resolve) => {
    if (process.platform === 'darwin') {
      exec(`osascript -e 'tell application "System Events" to get name of first process whose frontmost is true'`, (err, stdout) => {
        if (err) return resolve('');
        resolve(stdout.trim());
      });
    } else {
      resolve('');
    }
  });
}

function isDistraction(title) {
  const lower = title.toLowerCase();
  return DISTRACTION_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()));
}

// 移动窗口到屏幕中心
ipcMain.on('move-to-center', () => {
  if (!mainWindow) return;
  const { width: sW, height: sH } = screen.getPrimaryDisplay().workAreaSize;
  const [winW, winH] = mainWindow.getSize();
  mainWindow.setPosition(
    Math.round((sW - winW) / 2),
    Math.round((sH - winH) / 2)
  );
});

// ═══════════════════════════════════════════
// 指令二：剪贴板背包
// ═══════════════════════════════════════════

function startClipboardMonitor() {
  const { clipboard } = require('electron');
  lastClipboardText = clipboard.readText() || '';
  clipboardInterval = setInterval(() => {
    if (!mainWindow) return;
    const text = clipboard.readText() || '';
    if (text && text !== lastClipboardText) {
      lastClipboardText = text;
      // 限制最多10条，每条最多500字符
      const snippet = text.substring(0, 500);
      clipboardHistory.unshift({
        text: snippet,
        time: Date.now(),
        preview: snippet.substring(0, 60).replace(/\n/g, ' ')
      });
      if (clipboardHistory.length > 10) clipboardHistory.pop();
      mainWindow.webContents.send('clipboard-new', { text: snippet, preview: snippet.substring(0, 60).replace(/\n/g, ' ') });
    }
  }, 1500);
}

function stopClipboardMonitor() {
  if (clipboardInterval) {
    clearInterval(clipboardInterval);
    clipboardInterval = null;
  }
}

ipcMain.handle('get-clipboard-history', () => {
  return clipboardHistory;
});

ipcMain.on('clipboard-copy', (event, { text }) => {
  const { clipboard } = require('electron');
  clipboard.writeText(text);
  lastClipboardText = text;
});

// ═══════════════════════════════════════════
// 指令二：文件拖拽 (Claw AI 代理)
// ═══════════════════════════════════════════

ipcMain.handle('read-dropped-file', async (event, filePath) => {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 100 * 1024) {
      return { error: '文件太大(>100KB)', content: null };
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    const ext = path.extname(filePath);
    const name = path.basename(filePath);
    return { content, ext, name, size: stat.size };
  } catch (e) {
    return { error: e.message, content: null };
  }
});

// ═══════════════════════════════════════════
// 指令三：进程管理
// ═══════════════════════════════════════════

ipcMain.handle('get-process-list', async () => {
  try {
    // 使用 ps 命令获取进程列表(macOS/Linux)
    return new Promise((resolve) => {
      exec('ps -axo pid,rss,%mem,%cpu,comm | sort -k3 -rn | head -20', (err, stdout) => {
        if (err) return resolve([]);
        const lines = stdout.trim().split('\n').slice(1); // skip header
        const processes = lines.map(line => {
          const parts = line.trim().split(/\s+/);
          const pid = parseInt(parts[0]);
          const rss = parseInt(parts[1]); // KB
          const memPercent = parseFloat(parts[2]);
          const cpuPercent = parseFloat(parts[3]);
          const command = parts.slice(4).join(' ');
          const name = path.basename(command);
          return { pid, rss, memMB: Math.round(rss / 1024), memPercent, cpuPercent, name, command };
        }).filter(p => p.pid && p.name && p.name !== 'ps');
        resolve(processes.slice(0, 10));
      });
    });
  } catch (e) {
    return [];
  }
});

ipcMain.handle('kill-process', async (event, pid) => {
  try {
    process.kill(pid, 'SIGTERM');
    return { success: true, pid };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ═══════════════════════════════════════════
// 系统感知（电量、网络、USB）
// ═══════════════════════════════════════════

function startSystemSensors() {
  // 电量监控（每30秒）
  batteryInterval = setInterval(async () => {
    if (!mainWindow) return;
    try {
      const battery = await getBatteryInfo();
      if (battery) {
        mainWindow.webContents.send('battery-update', battery);
      }
    } catch (e) {}
  }, 30000);

  // 初次获取电量
  getBatteryInfo().then(battery => {
    if (battery && mainWindow) {
      mainWindow.webContents.send('battery-update', battery);
    }
  }).catch(() => {});

  // 磁盘挂载监控（每5秒检查）
  checkDisks().then(disks => { lastDiskList = disks; }).catch(() => {});
  diskWatchInterval = setInterval(async () => {
    if (!mainWindow) return;
    try {
      const disks = await checkDisks();
      // 检查是否有新挂载
      const newDisks = disks.filter(d => !lastDiskList.find(ld => ld === d));
      if (newDisks.length > 0) {
        mainWindow.webContents.send('disk-mounted', { disks: newDisks });
      }
      lastDiskList = disks;
    } catch (e) {}
  }, 5000);
}

function stopSystemSensors() {
  if (batteryInterval) { clearInterval(batteryInterval); batteryInterval = null; }
  if (diskWatchInterval) { clearInterval(diskWatchInterval); diskWatchInterval = null; }
}

function getBatteryInfo() {
  return new Promise((resolve) => {
    if (process.platform === 'darwin') {
      exec('pmset -g batt', (err, stdout) => {
        if (err) return resolve(null);
        const match = stdout.match(/(\d+)%/);
        const charging = stdout.includes('AC Power') || stdout.includes('charging');
        if (match) {
          resolve({ percent: parseInt(match[1]), charging });
        } else {
          resolve(null); // 台式机无电池
        }
      });
    } else {
      resolve(null);
    }
  });
}

function checkDisks() {
  return new Promise((resolve) => {
    if (process.platform === 'darwin') {
      exec('ls /Volumes', (err, stdout) => {
        if (err) return resolve([]);
        resolve(stdout.trim().split('\n').filter(Boolean));
      });
    } else {
      resolve([]);
    }
  });
}

// 网络状态由渲染进程自带 navigator.onLine 检测，无需主进程

// ═══════════════════════════════════════════
// Claw AI 联动 - 监控终端输出检测Claw工作状态
// ═══════════════════════════════════════════

let clawMonitorInterval = null;
let lastClawCheck = '';

function startClawMonitor() {
  clawMonitorInterval = setInterval(() => {
    if (!mainWindow) return;
    exec('ps -axo pid,%cpu,comm | grep -iE "claw|claude|codebuddy" | grep -v grep | head -5', (err, stdout) => {
      if (err || !stdout.trim()) {
        if (lastClawCheck !== 'idle') {
          lastClawCheck = 'idle';
          mainWindow.webContents.send('claw-status', { status: 'idle' });
        }
        return;
      }
      const lines = stdout.trim().split('\n');
      const highCpu = lines.some(line => {
        const parts = line.trim().split(/\s+/);
        return parts.length >= 2 && parseFloat(parts[1]) > 10;
      });
      if (highCpu && lastClawCheck !== 'working') {
        lastClawCheck = 'working';
        mainWindow.webContents.send('claw-status', { status: 'working', action: 'coding' });
      } else if (!highCpu && lastClawCheck === 'working') {
        lastClawCheck = 'idle';
        mainWindow.webContents.send('claw-status', { status: 'idle' });
      }
    });
  }, 3000);
}

function stopClawMonitor() {
  if (clawMonitorInterval) {
    clearInterval(clawMonitorInterval);
    clawMonitorInterval = null;
  }
}

ipcMain.on('claw-action', (event, data) => {
  if (mainWindow) {
    mainWindow.webContents.send('claw-status', data);
  }
});

// ═══════════════════════════════════════════
// 快捷对话窗口（屏幕居中，Spotlight 风格）
// ═══════════════════════════════════════════

function createQuickChatWindow() {
  if (quickChatWindow && !quickChatWindow.isDestroyed()) {
    quickChatWindow.show();
    quickChatWindow.focus();
    return;
  }

  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
  const qcW = 680, qcH = 520;

  quickChatWindow = new BrowserWindow({
    width: qcW,
    height: qcH,
    minWidth: 420,
    minHeight: 360,
    x: Math.round((screenW - qcW) / 2),
    y: Math.round((screenH - qcH) / 2),  // 屏幕正中央
    transparent: true,
    frame: false,          // 无系统标题栏，自绘标题栏
    resizable: true,       // 可拖动调整大小
    movable: true,         // 可移动
    alwaysOnTop: true,
    hasShadow: true,
    skipTaskbar: false,     // 在任务栏显示
    show: false,
    titleBarStyle: 'hidden',  // macOS 隐藏标题栏但保留红绿灯
    trafficLightPosition: { x: 12, y: 14 },
    vibrancy: 'under-window',     // macOS 毛玻璃
    visualEffectState: 'active',  // 保持毛玻璃效果始终激活
    webPreferences: {
      preload: path.join(__dirname, 'preload-quickchat.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  quickChatWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  quickChatWindow.loadFile(path.join(__dirname, '..', 'renderer', 'quick-chat.html'));

  quickChatWindow.once('ready-to-show', () => {
    quickChatWindow.show();
    quickChatWindow.focus();
  });

  // 不再失焦自动隐藏——正常窗口行为

  quickChatWindow.on('closed', () => {
    quickChatWindow = null;
    if (mainWindow) mainWindow.webContents.send('quick-chat-closed');
  });
}

function toggleQuickChatWindow() {
  console.log('💬 toggleQuickChatWindow 被调用');
  if (quickChatWindow && !quickChatWindow.isDestroyed() && quickChatWindow.isVisible()) {
    quickChatWindow.hide();
    if (mainWindow) mainWindow.webContents.send('quick-chat-closed');
  } else {
    createQuickChatWindow();
    // 通知主窗口企鹅进入等待状态
    if (mainWindow) mainWindow.webContents.send('quick-chat-opened');
  }
}

// 渲染进程请求打开屏幕居中快捷对话窗口
ipcMain.on('open-quick-chat-window', () => {
  console.log('💬 收到 open-quick-chat-window IPC');
  toggleQuickChatWindow();
});

// 快捷对话窗口发送消息 → 转发给主窗口处理
ipcMain.on('quick-chat-send', (event, { text, attachments = [] }) => {
  if (mainWindow) {
    mainWindow.webContents.send('quick-chat-message', { text, attachments });
  }
  // 不再隐藏窗口，保持对话终端打开
});

ipcMain.handle('quick-chat-pick-files', async () => {
  const parent = quickChatWindow && !quickChatWindow.isDestroyed() ? quickChatWindow : mainWindow;
  const result = await dialog.showOpenDialog(parent, {
    properties: ['openFile', 'multiSelections'],
    title: '选择要作为上下文的文件',
  });
  if (result.canceled || !result.filePaths?.length) return { ok: true, files: [] };

  const files = result.filePaths.map((filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    const isImage = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(ext);
    const base = {
      type: isImage ? 'image' : 'file',
      name: path.basename(filePath),
      path: filePath,
      mime: '',
      dataUrl: '',
    };
    if (!isImage) return base;

    try {
      const raw = fs.readFileSync(filePath);
      const mimeMap = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
        '.gif': 'image/gif',
        '.bmp': 'image/bmp',
      };
      const mime = mimeMap[ext] || 'application/octet-stream';
      return {
        ...base,
        mime,
        dataUrl: `data:${mime};base64,${raw.toString('base64')}`,
      };
    } catch (e) {
      return base;
    }
  });
  return { ok: true, files };
});

ipcMain.handle('quick-chat-read-clipboard-image', async () => {
  try {
    const { clipboard } = require('electron');
    const img = clipboard.readImage();
    if (img.isEmpty()) return { ok: true, image: null };
    const png = img.toPNG();
    return {
      ok: true,
      image: {
        type: 'image',
        name: `clipboard-${Date.now()}.png`,
        path: '[clipboard-image]',
        mime: 'image/png',
        dataUrl: `data:image/png;base64,${png.toString('base64')}`,
      },
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 主窗口 AI 回复 → 转发给对话终端窗口
ipcMain.on('quick-chat-reply', (event, { text }) => {
  if (quickChatWindow && !quickChatWindow.isDestroyed()) {
    quickChatWindow.webContents.send('ai-reply', { text });
  }
});

// 主窗口转发用户消息（如语音文本）→ 对话终端窗口显示
ipcMain.on('quick-chat-user-msg', (event, { text }) => {
  if (quickChatWindow && !quickChatWindow.isDestroyed()) {
    quickChatWindow.webContents.send('user-msg', { text });
  }
});

// 快捷对话窗口请求关闭
ipcMain.on('quick-chat-hide', () => {
  if (quickChatWindow && !quickChatWindow.isDestroyed()) {
    quickChatWindow.hide();
  }
  if (mainWindow) mainWindow.webContents.send('quick-chat-closed');
});

// 快捷对话窗口请求彻底关闭
ipcMain.on('quick-chat-close', () => {
  if (quickChatWindow && !quickChatWindow.isDestroyed()) {
    quickChatWindow.close();
  }
});

// ═══════════════════════════════════════════
// Skills 接入窗口（屏幕居中）
// ═══════════════════════════════════════════

// ─── 语音模式 IPC ───
ipcMain.on('voice-mode-start', () => {
  console.log('🎤 语音模式开始');
});

ipcMain.on('voice-mode-stop', () => {
  console.log('🎤 语音模式结束');
});

// ─── 语音识别字幕窗口（屏幕中下方） ───

function createSubtitleWindow() {
  if (subtitleWindow && !subtitleWindow.isDestroyed()) {
    subtitleWindow.show();
    return;
  }

  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
  const subW = 600, subH = 80;

  subtitleWindow = new BrowserWindow({
    width: subW,
    height: subH,
    x: Math.round((screenW - subW) / 2),
    y: Math.round(screenH - subH - 80),  // 屏幕底部上方 80px
    transparent: true,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    hasShadow: false,
    skipTaskbar: true,
    show: false,
    focusable: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  subtitleWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  subtitleWindow.setIgnoreMouseEvents(true);  // 完全穿透点击

  // 加载内联 HTML 字幕页面（毛玻璃风格）
  const subtitleHtml = `
    <!DOCTYPE html>
    <html><head><meta charset="UTF-8">
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body {
        background: transparent;
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
        overflow: hidden;
        font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif;
      }
      .subtitle-bar {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        padding: 12px 24px;
        background: rgba(15, 23, 42, 0.45);
        backdrop-filter: blur(24px);
        -webkit-backdrop-filter: blur(24px);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 24px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.2);
        max-width: 90vw;
        min-width: 100px;
        animation: fadeIn 0.3s ease;
      }
      .dot {
        width: 10px; height: 10px;
        border-radius: 50%;
        background: linear-gradient(135deg, #4ade80, #22c55e);
        flex-shrink: 0;
        animation: pulse 1.2s ease-in-out infinite;
        box-shadow: 0 0 8px rgba(74, 222, 128, 0.4);
      }
      .text {
        color: rgba(255, 255, 255, 0.92);
        font-size: 16px;
        line-height: 1.5;
        word-break: break-word;
        text-shadow: 0 1px 3px rgba(0,0,0,0.2);
      }
      @keyframes pulse {
        0%,100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.35; transform: scale(0.65); }
      }
      @keyframes fadeIn {
        from { opacity: 0; transform: translateY(8px); }
        to { opacity: 1; transform: translateY(0); }
      }
    </style>
    </head><body>
    <div class="subtitle-bar">
      <span class="dot"></span>
      <span class="text" id="txt"></span>
    </div>
    <script>
      // 接收来自主进程的字幕更新
      // 由于不使用 preload，通过 postMessage / executeJavaScript 更新
    </script>
    </body></html>
  `;

  subtitleWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(subtitleHtml));

  subtitleWindow.on('closed', () => {
    subtitleWindow = null;
  });
}

function showSubtitle(text) {
  if (!subtitleWindow || subtitleWindow.isDestroyed()) {
    createSubtitleWindow();
  }

  // 等窗口准备好后更新文字并显示
  const doUpdate = () => {
    if (!subtitleWindow || subtitleWindow.isDestroyed()) return;
    const escaped = text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, ' ');
    subtitleWindow.webContents.executeJavaScript(`document.getElementById('txt').textContent='${escaped}'`).catch(() => {});
    if (!subtitleWindow.isVisible()) subtitleWindow.showInactive();
  };

  if (subtitleWindow.webContents.isLoading()) {
    subtitleWindow.webContents.once('did-finish-load', doUpdate);
  } else {
    doUpdate();
  }
}

function hideSubtitle() {
  if (subtitleWindow && !subtitleWindow.isDestroyed()) {
    subtitleWindow.hide();
  }
}

// 渲染进程请求显示/隐藏字幕
ipcMain.on('subtitle-show', (event, { text }) => {
  showSubtitle(text);
});

ipcMain.on('subtitle-hide', () => {
  hideSubtitle();
});

// ─── 腾讯云 ASR 流式语音识别（WebSocket） ───
// 模仿 ~/Desktop/asrsocket 的实现，使用腾讯云实时语音识别 API
const crypto = require('crypto');
const https = require('https');
const WebSocket = require('ws');

let asrAvailable = true;  // 腾讯云 ASR 无需本地模型，始终可用
let asrWs = null;          // WebSocket 连接
let asrSessionText = '';   // 当前会话累计文本
let asrCurrentText = '';   // 当前句子的流式中间结果
let asrFinalText = '';     // 所有已确认的最终文本
let micProcess = null;     // ffmpeg 麦克风采集子进程

function calcFrameDb(frameBuffer) {
  if (!frameBuffer || frameBuffer.length < 2) return -100;
  let sumSquares = 0;
  let samples = 0;
  for (let i = 0; i + 1 < frameBuffer.length; i += 2) {
    const sample = frameBuffer.readInt16LE(i);
    sumSquares += sample * sample;
    samples++;
  }
  if (samples === 0) return -100;
  const rms = Math.sqrt(sumSquares / samples);
  if (rms <= 0) return -100;
  const db = 20 * Math.log10(rms / 32768);
  return Number.isFinite(db) ? db : -100;
}

const ASR_CONFIG_DEFAULTS = {
  appId: '',
  secretId: '',
  secretKey: '',
  engineModelType: '16k_zh_large',
};

function getAsrConfigPath() {
  return path.join(os.homedir(), '.qq-pet', 'config', 'asr-config.json');
}

function loadAsrConfig() {
  const configPath = getAsrConfigPath();
  let fileCfg = {};
  try {
    if (fs.existsSync(configPath)) {
      fileCfg = JSON.parse(fs.readFileSync(configPath, 'utf-8') || '{}');
    }
  } catch (e) {
    console.warn('读取 ASR 配置失败:', e.message);
  }

  const cfg = {
    appId: String(
      process.env.QQ_PET_ASR_APP_ID ||
      process.env.TENCENT_ASR_APP_ID ||
      fileCfg.appId ||
      fileCfg.app_id ||
      ''
    ).trim(),
    secretId: String(
      process.env.QQ_PET_ASR_SECRET_ID ||
      process.env.TENCENTCLOUD_SECRET_ID ||
      fileCfg.secretId ||
      fileCfg.secret_id ||
      ''
    ).trim(),
    secretKey: String(
      process.env.QQ_PET_ASR_SECRET_KEY ||
      process.env.TENCENTCLOUD_SECRET_KEY ||
      fileCfg.secretKey ||
      fileCfg.secret_key ||
      ''
    ).trim(),
    engineModelType: String(
      process.env.QQ_PET_ASR_ENGINE_MODEL ||
      fileCfg.engineModelType ||
      fileCfg.engine_model_type ||
      ASR_CONFIG_DEFAULTS.engineModelType
    ).trim() || ASR_CONFIG_DEFAULTS.engineModelType,
  };

  return { cfg, configPath };
}

function validateAsrConfig(cfg) {
  const missing = [];
  if (!cfg.appId) missing.push('appId');
  if (!cfg.secretId) missing.push('secretId');
  if (!cfg.secretKey) missing.push('secretKey');
  return missing;
}

/**
 * 生成腾讯云实时语音识别 WebSocket URL（带签名）
 */
function buildAsrWsUrl(asrCfg) {
  const timestamp = Math.floor(Date.now() / 1000);
  const expired = timestamp + 86400;
  const nonce = Math.floor(Math.random() * 100000);

  // 签名参数
  const params = {
    secretid: asrCfg.secretId,
    timestamp: String(timestamp),
    expired: String(expired),
    nonce: String(nonce),
    engine_model_type: asrCfg.engineModelType,
    voice_id: crypto.randomUUID(),
    voice_format: '1',         // 1 = PCM
    needvad: '1',
    word_info: '2',            // 返回词级别时间戳
    filter_dirty: '0',
    filter_modal: '0',
    filter_punc: '0',
    convert_num_mode: '1',
    hotword_id: '',
  };

  // 按字母排序拼接
  const sortedKeys = Object.keys(params).sort();
  const queryStr = sortedKeys.map(k => `${k}=${params[k]}`).join('&');

  // HMAC-SHA1 签名
  const signStr = `asr.cloud.tencent.com/asr/v2/${asrCfg.appId}?${queryStr}`;
  const signature = crypto.createHmac('sha1', asrCfg.secretKey)
    .update(signStr)
    .digest('base64');

  const encodedSig = encodeURIComponent(signature);
  const wsUrl = `wss://asr.cloud.tencent.com/asr/v2/${asrCfg.appId}?${queryStr}&signature=${encodedSig}`;
  return wsUrl;
}

// 读取 ASR 配置（返回脱敏后的数据，密钥只返回是否已填写）
ipcMain.handle('get-asr-config', () => {
  const { cfg, configPath } = loadAsrConfig();
  return {
    appId: cfg.appId,
    secretId: cfg.secretId,
    // secretKey 不回传明文，只告诉前端是否已配置
    secretKeySet: !!cfg.secretKey,
    engineModelType: cfg.engineModelType,
    configPath,
  };
});

// 保存 ASR 配置到 ~/.qq-pet/config/asr-config.json
ipcMain.handle('save-asr-config', (event, data) => {
  try {
    const configPath = getAsrConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });

    // 读取现有配置（避免覆盖已有 secretKey）
    let existing = {};
    try {
      if (fs.existsSync(configPath)) {
        existing = JSON.parse(fs.readFileSync(configPath, 'utf-8') || '{}');
      }
    } catch {}

    const next = {
      appId:           String(data.appId    || existing.appId    || '').trim(),
      secretId:        String(data.secretId || existing.secretId || '').trim(),
      // 若前端传了 secretKey（非空）则更新；否则保留原来的
      secretKey:       data.secretKey ? String(data.secretKey).trim() : String(existing.secretKey || '').trim(),
      engineModelType: String(data.engineModelType || existing.engineModelType || ASR_CONFIG_DEFAULTS.engineModelType).trim(),
    };

    fs.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
    // 设为只有当前用户可读写
    try { fs.chmodSync(configPath, 0o600); } catch {}

    console.log('🎤 ASR 配置已保存:', configPath);
    return { ok: true, configPath };
  } catch (e) {
    console.error('🎤 保存 ASR 配置失败:', e.message);
    return { ok: false, error: e.message };
  }
});

// 检测 ASR 可用性
ipcMain.handle('asr-check', async () => {
  const { cfg, configPath } = loadAsrConfig();
  const missing = validateAsrConfig(cfg);
  if (missing.length > 0) {
    return {
      available: false,
      engine: 'tencent-cloud-asr',
      error: `缺少 ASR 配置: ${missing.join(', ')}`,
      configPath,
    };
  }
  return { available: true, engine: 'tencent-cloud-asr', configPath };
});

// 开始流式识别会话：建立到腾讯云的 WebSocket 连接 + 启动 ffmpeg 麦克风采集
ipcMain.handle('asr-start', async () => {
  try {
    // 清理旧连接和旧进程
    if (micProcess) {
      try { micProcess.kill('SIGTERM'); } catch {}
      micProcess = null;
    }
    if (asrWs) {
      try { asrWs.close(); } catch {}
      asrWs = null;
    }

    asrSessionText = '';
    asrCurrentText = '';
    asrFinalText = '';

    const { cfg, configPath } = loadAsrConfig();
    const missing = validateAsrConfig(cfg);
    if (missing.length > 0) {
      return {
        error: `ASR 配置缺失: ${missing.join(', ')}。请配置 ${configPath} 或环境变量 QQ_PET_ASR_*`,
      };
    }

    const wsUrl = buildAsrWsUrl(cfg);
    console.log('🎤 腾讯云 ASR 连接中...');

    // 第一步：建立 ASR WebSocket 连接
    const wsReady = await new Promise((resolve) => {
      let settled = false;

      try {
        asrWs = new WebSocket(wsUrl);
      } catch (e) {
        console.error('🎤 WebSocket 创建失败:', e.message);
        resolve({ error: e.message });
        return;
      }

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          console.error('🎤 ASR WebSocket 连接超时');
          try { if (asrWs) asrWs.close(); } catch {}
          asrWs = null;
          resolve({ error: 'ASR WebSocket 连接超时' });
        }
      }, 10000);

      asrWs.on('open', () => {
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          console.log('🎤 腾讯云 ASR WebSocket 已连接 ✅');
          resolve({ ok: true });
        }
      });

      asrWs.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          // 打印所有收到的 ASR 消息（调试用）
          console.log('🎤 ASR msg:', JSON.stringify({ code: msg.code, message: msg.message, final: msg.final, result: msg.result ? { slice_type: msg.result.slice_type, text: msg.result.voice_text_str } : null }));
          
          if (msg.code !== 0) {
            console.warn('🎤 ASR 错误:', msg.code, msg.message);
            return;
          }

          // result.voice_text_str 是当前句子的流式中间/最终结果
          if (msg.result) {
            const sliceType = msg.result.slice_type;
            const text = msg.result.voice_text_str || '';

            if (sliceType === 0) {
              asrCurrentText = text;
            } else if (sliceType === 1) {
              asrCurrentText = text;
            } else if (sliceType === 2) {
              asrFinalText += text;
              asrCurrentText = '';
            }

            // 通知渲染进程流式结果
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('asr-streaming-result', {
                text: asrFinalText + asrCurrentText,
                currentSentence: asrCurrentText,
                isFinal: sliceType === 2,
              });
            }
          }
        } catch (e) {
          console.warn('🎤 ASR 消息解析失败:', e.message);
        }
      });

      asrWs.on('error', (err) => {
        clearTimeout(timeout);
        console.error('🎤 ASR WebSocket 错误:', err.message);
        if (!settled) {
          settled = true;
          asrWs = null;
          resolve({ error: err.message });
        }
      });

      asrWs.on('close', (code, reason) => {
        console.log(`🎤 ASR WebSocket 关闭: ${code} ${reason}`);
        asrWs = null;
        if (!settled) {
          settled = true;
          resolve({ error: `WebSocket 连接关闭: ${code}` });
        }
      });
    });

    if (wsReady.error) {
      return wsReady;
    }

    // 第二步：启动 ffmpeg 采集麦克风，输出 16kHz 16bit mono PCM 到 stdout
    try {
      const ffmpegPath = '/opt/homebrew/bin/ffmpeg';
      micProcess = spawn(ffmpegPath, [
        '-f', 'avfoundation',
        '-i', ':default',           // 使用默认音频输入设备
        '-ar', '16000',             // 采样率 16kHz
        '-ac', '1',                 // 单声道
        '-f', 's16le',              // 16bit little-endian PCM
        '-acodec', 'pcm_s16le',
        '-loglevel', 'error',       // 减少 ffmpeg 日志
        'pipe:1',                   // 输出到 stdout
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      console.log('🎤 ffmpeg 麦克风采集已启动 (PID:', micProcess.pid, ')');

      // ffmpeg stdout 的 PCM 数据按帧发给 ASR WebSocket
      // 腾讯云 ASR 建议每 40ms 发送一帧 = 16000Hz × 2bytes × 0.04s = 1280 bytes
      const FRAME_SIZE = 1280;
      let micBytesSent = 0;
      let micChunks = 0;
      let pcmBuffer = Buffer.alloc(0);  // PCM 数据缓冲区
      let lastVolumeEmitAt = 0;

      micProcess.stdout.on('data', (chunk) => {
        // 将新数据追加到缓冲区
        pcmBuffer = Buffer.concat([pcmBuffer, chunk]);

        // 按帧大小切割发送
        while (pcmBuffer.length >= FRAME_SIZE) {
          const frame = pcmBuffer.slice(0, FRAME_SIZE);
          pcmBuffer = pcmBuffer.slice(FRAME_SIZE);
          micChunks++;
          micBytesSent += frame.length;

          const now = Date.now();
          if (mainWindow && !mainWindow.isDestroyed() && now - lastVolumeEmitAt >= 80) {
            lastVolumeEmitAt = now;
            const db = calcFrameDb(frame);
            mainWindow.webContents.send('asr-volume', { db });
          }

          if (asrWs && asrWs.readyState === WebSocket.OPEN) {
            asrWs.send(frame);
          }
        }

        // 每 50 帧打一次日志（约 2 秒）
        if (micChunks > 0 && micChunks % 50 === 0) {
          console.log(`🎤 ffmpeg→ASR: ${micChunks} frames, ${micBytesSent}b sent, ws=${asrWs ? asrWs.readyState : 'null'}`);
        }
      });

      micProcess.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) console.log('🎤 ffmpeg info:', msg);
      });

      micProcess.on('error', (err) => {
        console.error('🎤 ffmpeg 启动失败:', err.message);
        micProcess = null;
      });

      micProcess.on('exit', (code) => {
        // 发送剩余数据
        if (pcmBuffer.length > 0 && asrWs && asrWs.readyState === WebSocket.OPEN) {
          asrWs.send(pcmBuffer);
          micBytesSent += pcmBuffer.length;
          micChunks++;
        }
        console.log(`🎤 ffmpeg 退出, code: ${code}, 总共发送: ${micBytesSent} bytes, ${micChunks} frames`);
        micProcess = null;
      });

    } catch (e) {
      console.error('🎤 ffmpeg spawn 失败:', e.message);
      // ffmpeg 失败不影响 ASR 连接，但实际没有音频数据
      return { error: '麦克风采集启动失败: ' + e.message };
    }

    return { ok: true };
  } catch (e) {
    console.error('🎤 asr-start 异常:', e.message);
    return { error: e.message };
  }
});

// asr-feed 现在是空操作（音频数据直接在主进程从 ffmpeg→ASR WebSocket 流转）
// 保留此 handler 以兼容渲染进程可能的旧调用
ipcMain.handle('asr-feed', async () => {
  return {
    text: asrFinalText + asrCurrentText,
    isEndpoint: false,
  };
});

// 结束流式识别
// quick=true：realtime 分段模式，跳过等待最终结果（用已有流式文本），让 asr-start 尽快启动
ipcMain.handle('asr-stop', async (event, { quick = false } = {}) => {
  try {
    // 先停止 ffmpeg 麦克风采集
    if (micProcess) {
      try {
        micProcess.kill('SIGTERM');
        console.log('🎤 ffmpeg 麦克风采集已停止');
      } catch {}
      micProcess = null;
    }

    const currentFullText = (asrFinalText + asrCurrentText).trim();

    if (asrWs && asrWs.readyState === WebSocket.OPEN) {
      try {
        if (quick) {
          // realtime 分段：不等最终结果，直接关闭，让 asr-start 立即可用
          console.log('🎤 快速停止 ASR（realtime 分段模式）');
          try { asrWs.close(); } catch {}
        } else {
          // 发送一个空的音频帧，通知 ASR 音频结束
          // 腾讯云 ASR 会在收到空帧或连接关闭后返回最终结果
          asrWs.send(Buffer.alloc(0));

          // 等待最后的识别结果（最多 3 秒）
          await new Promise((resolve) => {
            const waitTimeout = setTimeout(() => {
              console.log('🎤 等待最终结果超时，使用已有结果');
              resolve();
            }, 3000);

            const onMessage = (data) => {
              try {
                const msg = JSON.parse(data.toString());
                if (msg.final === 1 || (msg.result && msg.result.slice_type === 2)) {
                  if (msg.result && msg.result.voice_text_str) {
                    asrFinalText += msg.result.voice_text_str;
                    asrCurrentText = '';
                  }
                  clearTimeout(waitTimeout);
                  resolve();
                }
              } catch {}
            };

            if (asrWs) {
              asrWs.on('message', onMessage);
              // 清理
              setTimeout(() => {
                try { if (asrWs) asrWs.removeListener('message', onMessage); } catch {}
              }, 3100);
            } else {
              clearTimeout(waitTimeout);
              resolve();
            }
          });

          try { if (asrWs) asrWs.close(); } catch {}
        }
      } catch (e) {
        console.warn('🎤 ASR 关闭异常:', e.message);
      }
      asrWs = null;
    }

    const finalText = (asrFinalText + asrCurrentText).trim();
    console.log(`🎤 腾讯云 ASR 最终结果: "${finalText}"`);

    // 重置
    asrSessionText = '';
    asrCurrentText = '';
    asrFinalText = '';

    return { text: finalText || currentFullText };
  } catch (e) {
    console.error('🎤 asr-stop 异常:', e.message);
    // 强制清理
    if (micProcess) { try { micProcess.kill('SIGTERM'); } catch {} micProcess = null; }
    try { if (asrWs) asrWs.close(); } catch {}
    asrWs = null;
    const text = (asrFinalText + asrCurrentText).trim();
    asrSessionText = '';
    asrCurrentText = '';
    asrFinalText = '';
    return { text: text || '' };
  }
});

// ─── 点击穿透 IPC ───
ipcMain.on('set-ignore-mouse', (event, { ignore, forward }) => {
  if (mainWindow) {
    if (ignore) {
      mainWindow.setIgnoreMouseEvents(true, { forward: true });
    } else {
      mainWindow.setIgnoreMouseEvents(false);
    }
  }
});

function createSkillsWindow() {
  if (skillsWindow && !skillsWindow.isDestroyed()) {
    skillsWindow.show();
    skillsWindow.focus();
    return;
  }

  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
  const skW = 440, skH = 520;

  skillsWindow = new BrowserWindow({
    width: skW,
    height: skH,
    x: Math.round((screenW - skW) / 2),
    y: Math.round((screenH - skH) / 2),
    transparent: true,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    hasShadow: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-skills.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  skillsWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  skillsWindow.loadFile(path.join(__dirname, '..', 'renderer', 'skills.html'));

  skillsWindow.once('ready-to-show', () => {
    skillsWindow.show();
    skillsWindow.focus();
  });

  skillsWindow.on('blur', () => {
    // 失焦时隐藏
    if (skillsWindow && !skillsWindow.isDestroyed()) {
      skillsWindow.hide();
    }
  });

  skillsWindow.on('closed', () => {
    skillsWindow = null;
  });
}

function toggleSkillsWindow() {
  if (skillsWindow && !skillsWindow.isDestroyed() && skillsWindow.isVisible()) {
    skillsWindow.hide();
  } else {
    createSkillsWindow();
  }
}

// 渲染进程请求打开 Skills 窗口
ipcMain.on('open-skills-window', () => {
  toggleSkillsWindow();
});

// Skills 窗口请求关闭
ipcMain.on('skills-hide', () => {
  if (skillsWindow && !skillsWindow.isDestroyed()) {
    skillsWindow.hide();
  }
});

// ─── Skills 真实数据 ───

function sanitizeSkillText(text, fallback = '') {
  const raw = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!raw) return fallback;
  // 如果文本里可读字符占比过低，通常是编码异常或二进制噪声
  const printable = (raw.match(/[\u4e00-\u9fa5A-Za-z0-9\s.,!?;:()\-_[\]{}'"`~@#$%^&*+/\\|<>]/g) || []).length;
  const ratio = printable / Math.max(1, raw.length);
  if (ratio < 0.45 || raw.includes('\u0000')) return fallback;
  return raw.replace(/\s+/g, ' ').slice(0, 120);
}

/**
 * 解析所有可能的已安装 skills 目录
 * 优先级：~/.qqclaw/workspace/skills/ > ~/.openclaw/workspace/skills/（旧版兼容）
 */
function resolveAllSkillsDirs() {
  const candidates = [
    path.join(os.homedir(), '.qqclaw', 'workspace', 'skills'),   // QQClaw 主路径
    path.join(os.homedir(), '.openclaw', 'workspace', 'skills'),  // 旧版 openclaw 兼容
  ];
  return candidates.filter(d => fs.existsSync(d));
}

/**
 * 从 QQClaw skills 目录读取已安装 skills 列表
 * 返回 [{ id, name, displayName, desc, source, version, installed: true, emoji, skillsDir }]
 */
function getInstalledSkills() {
  const allDirs = resolveAllSkillsDirs();
  if (allDirs.length === 0) return [];

  const seen = new Set(); // 去重（同名 skill 只取第一个）
  const results = [];

  for (const skillsDir of allDirs) {
    const dirs = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const d of dirs) {
      if (seen.has(d.name)) continue; // 已被优先目录收录，跳过
      seen.add(d.name);

      const skillPath = path.join(skillsDir, d.name);
      const result = {
        id: d.name,
        name: d.name,
        displayName: d.name,
        desc: '',
        source: 'unknown',
        version: '',
        installed: true,
        emoji: '🧩',
        skillsDir, // 记录来源目录，供安装/卸载使用
      };

      // 读 _skillhub_meta.json
      const metaPath = path.join(skillPath, '_skillhub_meta.json');
      if (fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
          result.source = sanitizeSkillText(meta.source, 'unknown');
          result.version = meta.version || '';
          if (meta.name) result.displayName = sanitizeSkillText(meta.name, result.displayName);
          if (meta.slug) result.id = sanitizeSkillText(meta.slug, result.id);
        } catch (e) { /* ignore */ }
      }

      // 读 SKILL.md frontmatter
      const skillMdPath = path.join(skillPath, 'SKILL.md');
      if (fs.existsSync(skillMdPath)) {
        try {
          const content = fs.readFileSync(skillMdPath, 'utf-8');
          const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
          if (fmMatch) {
            const fm = fmMatch[1];
            const zhMatch = fm.match(/description_zh:\s*["']?(.+?)["']?\s*$/m);
            const descMatch = fm.match(/^description:\s*["']?(.+?)["']?\s*$/m);
            const nameMatch = fm.match(/^name:\s*["']?(.+?)["']?\s*$/m);

            if (zhMatch) result.desc = sanitizeSkillText(zhMatch[1], '');
            else if (descMatch) result.desc = sanitizeSkillText(descMatch[1], '');
            if (nameMatch && !result.displayName) result.displayName = sanitizeSkillText(nameMatch[1], result.displayName);

            const metadataMatch = fm.match(/metadata:\s*(\{.*\})/);
            if (metadataMatch) {
              try {
                const md = JSON.parse(metadataMatch[1]);
                if (md.clawdbot && md.clawdbot.emoji) result.emoji = md.clawdbot.emoji;
              } catch (e) { /* ignore */ }
            }
          }
        } catch (e) { /* ignore */ }
      }

      result.id = sanitizeSkillText(result.id, d.name);
      result.name = sanitizeSkillText(result.name, d.name);
      result.displayName = sanitizeSkillText(result.displayName, result.name);
      result.desc = sanitizeSkillText(result.desc, '描述暂不可读');
      results.push(result);
    }
  }

  return results;
}

function resolveInstalledSkillDir(skillId) {
  const allDirs = resolveAllSkillsDirs();
  for (const skillsDir of allDirs) {
    const dirs = fs.readdirSync(skillsDir, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const d of dirs) {
      const dirName = d.name;
      const skillPath = path.join(skillsDir, dirName);
      if (dirName === skillId) return skillPath;

      const metaPath = path.join(skillPath, '_skillhub_meta.json');
      if (fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
          if (meta.slug === skillId || meta.name === skillId || meta.sourceSkillId === skillId) {
            return skillPath;
          }
        } catch (e) {}
      }
    }
  }
  return null;
}

/**
 * 从 QQClaw skillhub marketplace 读取可用 skills
 * marketplace.json 位于 ~/.qqclaw/workspace/skills-marketplace/.codebuddy-skill/marketplace.json
 * 兼容旧版 ~/.openclaw/workspace/skills-marketplace/
 */
function getMarketplaceSkills(installedIds) {
  const marketplacePaths = [
    path.join(os.homedir(), '.qqclaw', 'workspace', 'skills-marketplace', '.codebuddy-skill', 'marketplace.json'),
    path.join(os.homedir(), '.openclaw', 'workspace', 'skills-marketplace', '.codebuddy-skill', 'marketplace.json'),
  ];

  for (const catalogPath of marketplacePaths) {
    if (!fs.existsSync(catalogPath)) continue;
    try {
      const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf-8'));
      const skills = catalog.skills || [];
      return skills
        .filter(s => !installedIds.has(s.source) && !installedIds.has(s.name))
        .map(s => ({
          id: sanitizeSkillText(s.source || s.name, 'unknown-skill'),
          name: sanitizeSkillText(s.source || s.name, 'unknown-skill'),
          displayName: sanitizeSkillText(s.name, '未命名技能'),
          desc: sanitizeSkillText(s.description_zh || s.description || '', '描述暂不可读'),
          source: 'marketplace-available',
          installed: false,
          emoji: '📦',
        }));
    } catch (e) {
      console.error('读取 marketplace.json 失败:', e.message);
    }
  }
  return [];
}

// ── 内置 skillhub CLI 路径（QQClaw 打包资源，或宠物运行时同级目录） ──
function resolveSkillhubCli() {
  const candidates = [
    // QQClaw 打包后的内置 CLI
    path.join(os.homedir(), '.qq-pet', 'source', 'pc-pet-demo', '..', '..', '..', '..', 'holdclaw', 'holdclaw',
      'resources', 'targets', 'darwin-arm64', 'skillhub-cli', 'skills_store_cli.py'),
    // 直接找 holdclaw 的资源目录
    '/Users/Apple/Desktop/holdclaw/holdclaw/resources/targets/darwin-arm64/skillhub-cli/skills_store_cli.py',
    path.join(os.homedir(), 'Desktop', 'holdclaw', 'holdclaw', 'resources', 'targets', 'darwin-arm64', 'skillhub-cli', 'skills_store_cli.py'),
    // QQClaw.app 打包内的 CLI
    path.join('/Applications', 'QQClaw.app', 'Contents', 'Resources', 'app', 'resources', 'targets', 'darwin-arm64', 'skillhub-cli', 'skills_store_cli.py'),
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}

function resolvePythonBin() {
  const candidates = ['python3', 'python', '/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'];
  for (const p of candidates) {
    try { require('child_process').execSync(`${p} --version`, { stdio: 'pipe' }); return p; } catch {}
  }
  return null;
}

async function installViaSkillhubCli(skillId, skillsDir) {
  const cli = resolveSkillhubCli();
  const python = resolvePythonBin();

  if (!cli || !python) {
    // 降级：直接从 lightmake.site API 下载 zip 安装
    return installViaDirectDownload(skillId, skillsDir);
  }

  return new Promise((resolve) => {
    const args = [cli, '--dir', skillsDir, 'install', skillId];
    exec(`${python} ${args.map(a => `"${a}"`).join(' ')}`, { timeout: 60000 }, (err, stdout, stderr) => {
      if (err) {
        console.error(`❌ skillhub CLI 安装失败:`, err.message, stderr);
        resolve({ ok: false, error: err.message || stderr });
      } else {
        console.log(`✅ skillhub CLI 安装成功: ${skillId}\n${stdout}`);
        resolve({ ok: true });
      }
    });
  });
}

// 降级方案：直接从 lightmake.site 下载 zip 解压
async function installViaDirectDownload(skillId, skillsDir) {
  try {
    const downloadUrl = `https://lightmake.site/api/v1/download?slug=${encodeURIComponent(skillId)}`;
    const AdmZip = require('adm-zip');
    const tmpZip = path.join(os.tmpdir(), `skill-${skillId}-${Date.now()}.zip`);

    // 下载 zip
    await new Promise((resolve, reject) => {
      const https = require('https');
      const file = require('fs').createWriteStream(tmpZip);
      https.get(downloadUrl, res => {
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      }).on('error', reject);
    });

    // 解压
    const zip = new AdmZip(tmpZip);
    zip.extractAllTo(skillsDir, true);
    fs.unlinkSync(tmpZip);
    console.log(`✅ 直接下载安装成功: ${skillId}`);
    return { ok: true };
  } catch (e) {
    console.error('❌ 直接下载安装失败:', e.message);
    return { ok: false, error: e.message };
  }
}
const SKILLHUB_API_BASE = 'https://lightmake.site';
const SKILLHUB_LIST_URL = `${SKILLHUB_API_BASE}/api/skills`;
const SKILLHUB_TOP_URL  = `${SKILLHUB_API_BASE}/api/skills/top`;
const SKILLHUB_FETCH_TIMEOUT = 10000;

async function fetchSkillhubStore({ keyword = '', page = 1, pageSize = 50, sortBy = 'score' } = {}) {
  const params = new URLSearchParams({ page, pageSize, sortBy });
  if (keyword) params.set('keyword', keyword);
  const url = `${SKILLHUB_LIST_URL}?${params}`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), SKILLHUB_FETCH_TIMEOUT);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    // API 响应结构: { code, data: { skills: [...], total } }
    const skills = (json?.data?.skills || json?.skills || []).map(s => ({
      id:          String(s.slug || s.id || s.name || ''),
      name:        String(s.slug || s.name || ''),
      displayName: String(s.name || s.slug || '未命名技能'),
      desc:        String(s.description_zh || s.description || ''),
      emoji:       String(s.emoji || s.icon || '📦'),
      source:      'skillhub-store',
      version:     String(s.version || ''),
      installed:   false,
    }));
    return { skills, total: json?.data?.total || skills.length };
  } catch (e) {
    console.warn('🧩 获取 skillhub 商店失败:', e.message);
    return { skills: [], total: 0 };
  }
}

// Skills 列表请求（已安装 + 商店推荐/搜索）
ipcMain.handle('skills-get-list', async (event, { keyword = '', page = 1 } = {}) => {
  const PAGE_SIZE = 50;

  // 1. 读本地已安装（仅第一页返回，避免重复）
  const installed = page === 1 ? getInstalledSkills() : [];
  const installedSlugs = new Set([
    ...getInstalledSkills().map(s => s.id),
    ...getInstalledSkills().map(s => s.name),
    ...getInstalledSkills().map(s => s.displayName),
  ]);

  // 2. 从 lightmake.site 分页拉商店数据
  const { skills: storeSkills, total } = await fetchSkillhubStore({
    keyword,
    sortBy: 'score',
    page,
    pageSize: PAGE_SIZE,
  });
  const marketplace = storeSkills.filter(
    s => !installedSlugs.has(s.id) && !installedSlugs.has(s.name) && !installedSlugs.has(s.displayName)
  );

  // hasMore：本页拉到了满 PAGE_SIZE 条（可能还有下一页）
  const hasMore = storeSkills.length >= PAGE_SIZE;

  return { installed, marketplace, hasMore, page };
});

ipcMain.handle('skills-get-auth-status', async () => {
  const auth = getGitAuthConfig();
  return {
    ok: true,
    hasToken: !!auth.token,
    tokenPath: auth.path,
    guideUrl: GIT_AUTH_GUIDE_URL,
  };
});

ipcMain.handle('skills-save-auth-token', async (event, { token }) => {
  const result = saveGitAuthToken(token);
  if (!result.ok) return { ok: false, error: result.error, tokenPath: result.path, guideUrl: GIT_AUTH_GUIDE_URL };
  return { ok: true, tokenPath: result.path, guideUrl: GIT_AUTH_GUIDE_URL };
});

// Skills 真实安装事件
ipcMain.handle('skills-install', async (event, { skillId, source }) => {
  console.log(`🧩 安装 Skill: ${skillId} (来源: ${source})`);

  try {
    const qqclawSkillsDir = path.join(os.homedir(), '.qqclaw', 'workspace', 'skills');
    fs.mkdirSync(qqclawSkillsDir, { recursive: true });

    if (source === 'skillhub-store') {
      // 公开商店 skill：调用内置 skillhub Python CLI 安装
      return await installViaSkillhubCli(skillId, qqclawSkillsDir);
    } else if (source === 'marketplace-available') {
      // 旧版本地 marketplace（离线包）
      const marketplaceBases = [
        path.join(os.homedir(), '.qqclaw', 'workspace', 'skills-marketplace', 'skills'),
        path.join(os.homedir(), '.openclaw', 'workspace', 'skills-marketplace', 'skills'),
      ];
      const srcBase = marketplaceBases.find(b => fs.existsSync(path.join(b, skillId)));
      if (!srcBase) {
        return { ok: false, error: `找不到 skill 源目录: ${skillId}` };
      }
      const dstDir = path.join(qqclawSkillsDir, skillId);
      copyDirSync(path.join(srcBase, skillId), dstDir);
      const meta = { name: skillId, installedAt: Date.now(), source: 'marketplace' };
      fs.writeFileSync(path.join(dstDir, '_skillhub_meta.json'), JSON.stringify(meta, null, 2));
      console.log(`✅ Marketplace skill 安装成功: ${skillId}`);
    } else {
      const auth = getGitAuthConfig();
      if (!auth.token) {
        return {
          ok: false,
          authRequired: true,
          error: '需要先配置 git.woa.com 的登录 token',
          tokenPath: auth.path,
          guideUrl: GIT_AUTH_GUIDE_URL,
        };
      }
      // 私有 skillhub skill: 用 npx skills add，安装到 ~/.qqclaw/workspace/skills/
      return await new Promise((resolve) => {
        const cmd = `npx skills add ${skillId} --dir "${qqclawSkillsDir}" -y`;
        const env = {
          ...process.env,
          GIT_PRIVATE_TOKEN: auth.token,
          GIT_WOA_TOKEN: auth.token,
          PRIVATE_TOKEN: auth.token,
        };
        exec(cmd, { timeout: 60000, env }, (err, stdout, stderr) => {
          if (err) {
            console.error(`❌ skills add 失败:`, err.message);
            const msg = String(err.message || '');
            const authFailed = /401|403|auth|token|permission|unauthorized|forbidden/i.test(msg);
            resolve({
              ok: false,
              error: err.message,
              authRequired: authFailed,
              tokenPath: auth.path,
              guideUrl: GIT_AUTH_GUIDE_URL,
            });
          } else {
            console.log(`✅ SkillHub skill 安装成功: ${skillId}`);
            resolve({ ok: true });
          }
        });
      });
    }

    // 通知主窗口
    if (mainWindow) {
      mainWindow.webContents.send('skill-installed', { skillId });
    }
    return { ok: true };
  } catch (e) {
    console.error(`❌ 安装失败:`, e.message);
    return { ok: false, error: e.message };
  }
});

// Skills 卸载事件
ipcMain.handle('skills-uninstall', async (event, { skillId }) => {
  console.log(`🗑️ 卸载 Skill: ${skillId}`);
  try {
    const targetDir = resolveInstalledSkillDir(skillId);
    if (!targetDir) {
      return { ok: false, error: `未找到已安装 Skill: ${skillId}` };
    }

    fs.rmSync(targetDir, { recursive: true, force: true });
    console.log(`✅ Skill 卸载成功: ${skillId}`);
    return { ok: true };
  } catch (e) {
    console.error(`❌ 卸载失败:`, e.message);
    return { ok: false, error: e.message };
  }
});

// Skills 配置 → 通知主窗口发起对话引导
ipcMain.on('skills-configure', (event, { skillId, skillName }) => {
  console.log(`⚙️ 配置 Skill: ${skillId}`);
  // 关闭 skills 窗口
  if (skillsWindow && !skillsWindow.isDestroyed()) {
    skillsWindow.hide();
  }
  const installed = getInstalledSkills();
  const skillInfo = installed.find(s => s.id === skillId || s.name === skillId || s.displayName === skillName);
  // 通知主窗口的宠物发起配置对话
  if (mainWindow) {
    mainWindow.webContents.send('skill-configure-chat', {
      skillId,
      skillName,
      skillDesc: skillInfo?.desc || '',
      skillSource: skillInfo?.source || '',
    });
  }
});

// 辅助函数：递归复制目录
function copyDirSync(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

// ─── 应用生命周期 ───
app.whenReady().then(() => {
  systemSettings = loadSystemSettings();
  createMainWindow();
  createTray();
  startClawMonitor();
  applyAutoLaunchSetting();

  // 腾讯云 ASR 无需预初始化，连接在开始录音时建立
  console.log('🎤 腾讯云 ASR 流式识别就绪（按需连接）');

  registerGlobalShortcutsFromSettings();

  // 启动自动更新检查（使用 ~/.qq-pet/config/update-config.json 配置）
  const updateCfg = getUpdateConfig();
  if (updateCfg && updateCfg.enabled) {
    // 启动后 5 秒做一次检查
    setTimeout(() => { checkForUpdates('auto'); }, 5000);
    const intervalMinutes = Math.max(1, updateCfg.checkIntervalMinutes);
    const intervalMs = intervalMinutes * 60 * 1000;
    updateCheckTimer = setInterval(() => { checkForUpdates('auto'); }, intervalMs);
    console.log(`🔄 自动更新已启用，每 ${intervalMinutes} 分钟检查一次`);
  } else {
    console.log('🔄 自动更新未启用（缺少 ~/.qq-pet/config/update-config.json）');
  }
});

app.on('will-quit', () => {
  // 注销所有全局快捷键
  globalShortcut.unregisterAll();
  if (updateCheckTimer) {
    clearInterval(updateCheckTimer);
    updateCheckTimer = null;
  }
});

app.on('window-all-closed', () => {
  stopClawMonitor();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!mainWindow) createMainWindow();
});
