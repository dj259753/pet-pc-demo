'use strict';
/**
 * InstallerCore — 把 install.sh 的逻辑移植为 Node.js
 * 回调格式: onProgress(stepIndex, message, progressPct)
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execSync, exec, spawn } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const HOME = os.homedir();

// 路径常量
const PET_AGENT_DIR   = path.join(HOME, '.openclaw', 'agents', 'qq-pet');
const PET_CONFIG_DIR  = path.join(HOME, '.qq-pet', 'config');
const SOURCE_BASE_DIR = path.join(HOME, '.qq-pet', 'source');
const SOURCE_DIR      = path.join(SOURCE_BASE_DIR, 'pc-pet-demo');

// 安装包内置源码路径（electron-builder extraResources 放在 Resources/pc-pet-demo）
function getBundledSourceDir() {
  // 打包后
  if (process.resourcesPath) {
    const packed = path.join(process.resourcesPath, 'pc-pet-demo');
    if (fs.existsSync(packed)) return packed;
  }
  // 开发模式：installer/ 同级的 bundle/pc-pet-demo
  return path.join(__dirname, '..', 'bundle', 'pc-pet-demo');
}

function getFullShellEnv() {
  const env = { ...process.env };
  const extraPaths = [
    '/usr/local/bin', '/opt/homebrew/bin', '/opt/homebrew/sbin',
    '/usr/bin', '/bin', '/usr/sbin', '/sbin',
    path.join(HOME, '.nvm', 'versions', 'node'),
  ];
  const cur = env.PATH || '';
  const missing = extraPaths.filter(p => !cur.includes(p));
  if (missing.length) env.PATH = missing.join(':') + ':' + cur;
  return env;
}

class InstallerCore {
  constructor(onProgress) {
    this.onProgress = onProgress || (() => {});
    this.env = getFullShellEnv();
  }

  progress(step, message, pct) {
    this.onProgress(step, message, pct);
    console.log(`[Step ${step}] ${message}`);
  }

  async run() {
    await this.step0_checkEnv();
    await this.step1_deploySource();
    await this.step2_npmInstall();
    await this.step3_detectQQClaw();
    await this.step4_installSkill();
    await this.step5_generateStartScript();
  }

  // ── Step 0: 检查 Node / npm ──
  async step0_checkEnv() {
    this.progress(0, '检查 Node.js 和 npm...', 2);
    try {
      const nv = execSync('node --version', { env: this.env }).toString().trim();
      const npm = execSync('npm --version', { env: this.env }).toString().trim();
      this.progress(0, `Node.js ${nv}，npm ${npm} ✅`, 10);
    } catch (e) {
      throw new Error('未找到 Node.js，请先安装 Node.js 18+ 后重试。\nhttps://nodejs.org');
    }
  }

  // ── Step 1: 复制源码 ──
  async step1_deploySource() {
    this.progress(1, '部署宠物源码...', 14);
    const bundled = getBundledSourceDir();
    if (!fs.existsSync(path.join(bundled, 'package.json'))) {
      throw new Error(`内置源码不完整：${bundled}`);
    }
    fs.mkdirSync(PET_CONFIG_DIR, { recursive: true });
    fs.mkdirSync(SOURCE_BASE_DIR, { recursive: true });

    // 清理旧版本
    if (fs.existsSync(SOURCE_DIR)) {
      fs.rmSync(SOURCE_DIR, { recursive: true, force: true });
    }

    this.copyDirSync(bundled, SOURCE_DIR);
    this.progress(1, `源码已部署到 ~/.qq-pet/source/pc-pet-demo ✅`, 22);
  }

  // ── Step 2: npm install ──
  async step2_npmInstall() {
    this.progress(2, '安装 npm 依赖（含 Electron，可能需要几分钟）...', 26);
    try {
      await execAsync('npm install', {
        cwd: SOURCE_DIR,
        timeout: 300000,
        env: this.env,
      });
      this.progress(2, '依赖安装完成 ✅', 45);
    } catch (e) {
      // npm install 失败不阻断，可能只是部分包失败
      console.warn('npm install 警告:', e.message.substring(0, 200));
      this.progress(2, '依赖安装完成（部分警告）', 45);
    }
  }

  // ── Step 3: 检测 QQClaw + 写 ai-config.json ──
  async step3_detectQQClaw() {
    this.progress(3, '检测 QQClaw 配置...', 50);

    let token = '', apiUrl = '', model = '';

    // 读取 openclaw 配置文件
    const cfgPaths = [
      path.join(HOME, '.qqclaw', 'openclaw.json'),
      path.join(HOME, '.openclaw', 'openclaw.json'),
    ];
    let cfgPort = '';

    for (const cp of cfgPaths) {
      if (!fs.existsSync(cp)) continue;
      try {
        const cfg = JSON.parse(fs.readFileSync(cp, 'utf-8'));
        if (!token) {
          token = String(cfg?.token || cfg?.gateway?.auth?.token || '').trim();
        }
        if (!cfgPort) {
          cfgPort = String(cfg?.gateway?.port || cfg?.gateway?.apiPort || '').trim();
        }
        if (!model) {
          model = String(cfg?.agents?.defaults?.model?.primary || '').trim();
        }
        if (token) break;
      } catch {}
    }

    // 探测端口
    if (!apiUrl) {
      this.progress(3, '探测 QQClaw 端口...', 55);
      apiUrl = await this.detectApiUrl(token, cfgPort);
    }
    if (!model) model = 'openclaw:main';

    // 写 ai-config.json
    const aiCfg = {
      provider: 'openclaw',
      api_url: apiUrl,
      api_key: token,
      model,
    };
    fs.writeFileSync(
      path.join(PET_CONFIG_DIR, 'ai-config.json'),
      JSON.stringify(aiCfg, null, 2)
    );

    const status = token && apiUrl ? '已连接 QQClaw ✅' : token ? '有 token 但未探测到端口 ⚠️' : '降级模式（无 token）';
    this.progress(3, `AI 配置完成：${status}`, 65);
  }

  async detectApiUrl(token, cfgPort) {
    const ports = new Set();
    if (cfgPort) ports.add(cfgPort);

    // lsof 扫描
    try {
      const { stdout } = await execAsync(
        `lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -E 'node|claw|openclaw|codebuddy|workbuddy|qqclaw' | awk '{for(i=1;i<=NF;i++) if($i~/\\(LISTEN\\)/){split($(i-1),a,":");print a[length(a)];break}}'`,
        { env: this.env, timeout: 5000 }
      );
      stdout.trim().split('\n').filter(Boolean).forEach(p => ports.add(p.trim()));
    } catch {}

    // fallback 端口
    [18789, 19789, 19791, 18888, 8080, 3000].forEach(p => ports.add(String(p)));

    for (const p of ports) {
      const url = `http://127.0.0.1:${p}/v1/chat/completions`;
      if (await this.probeEndpoint(url, token)) return url;
    }
    return '';
  }

  async probeEndpoint(url, token) {
    try {
      const modelsUrl = url.replace('/v1/chat/completions', '/v1/models');
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch(modelsUrl, { method: 'GET', headers, signal: AbortSignal.timeout(2000) });
      if (res.status === 200) return true;
    } catch {}
    return false;
  }

  // ── Step 4: 安装 Skill ──
  async step4_installSkill() {
    this.progress(4, '安装 qq-pet Skill...', 70);

    // Agent workspace
    const agentDirs = [
      PET_AGENT_DIR,
      path.join(PET_AGENT_DIR, 'memory'),
      path.join(PET_AGENT_DIR, '.workbuddy', 'memory'),
    ];
    agentDirs.forEach(d => fs.mkdirSync(d, { recursive: true }));

    // 复制 agent 文件
    const bundled = getBundledSourceDir();
    const skillDir = path.join(bundled, '..', '..'); // openclaw-pet-skill-local
    const agentSrcDir = path.join(skillDir, 'agents', 'qq-pet');

    const agentFiles = ['SOUL.md', 'IDENTITY.md', 'AGENTS.yml'];
    for (const f of agentFiles) {
      const src = path.join(agentSrcDir, f);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(PET_AGENT_DIR, f));
      }
    }

    // 初始记忆
    const memFile = path.join(PET_AGENT_DIR, 'memory', 'MEMORY.md');
    if (!fs.existsSync(memFile)) {
      fs.writeFileSync(memFile, `# 🐧 小Q的记忆\n\n## 关于主人\n- 还不太了解主人，需要多互动才能记住更多！\n\n## 重要的事\n- 今天是我来到主人桌面的第一天！\n`);
    }

    // 安装 Skill 到 ~/.workbuddy/skills/qq-pet
    const skillsDir = path.join(HOME, '.workbuddy', 'skills', 'qq-pet');
    fs.mkdirSync(skillsDir, { recursive: true });
    const skillMdSrc = path.join(skillDir, 'SKILL.md');
    if (fs.existsSync(skillMdSrc)) {
      fs.copyFileSync(skillMdSrc, path.join(skillsDir, 'SKILL.md'));
    }
    fs.writeFileSync(
      path.join(skillsDir, '_skillhub_meta.json'),
      JSON.stringify({ name: 'qq-pet', installedAt: Date.now(), source: 'bundled', version: '0.3.1' }, null, 2)
    );

    // 随机性格
    const MBTI = ['ENFP','INFP','ENFJ','INFJ','ENTP','INTP','ENTJ','INTJ','ESFP','ISFP','ESFJ','ISFJ','ESTP','ISTP','ESTJ','ISTJ'];
    const personality = MBTI[Math.floor(Math.random() * MBTI.length)];
    fs.writeFileSync(
      path.join(PET_AGENT_DIR, 'personality.json'),
      JSON.stringify({ assignedMBTI: personality, assignedDate: new Date().toISOString() }, null, 2)
    );

    this.progress(4, `Skill 安装完成，性格：${personality} ✅`, 85);
  }

  // ── Step 5: 生成启动脚本 ──
  async step5_generateStartScript() {
    this.progress(5, '生成启动脚本...', 90);

    const startSh = path.join(SOURCE_DIR, 'start.sh');
    const electronBin = path.join(SOURCE_DIR, 'node_modules', '.bin', 'electron');
    const launchCmd = fs.existsSync(electronBin)
      ? `"${electronBin}" .`
      : `npx electron .`;

    const script = `#!/bin/bash
# 🐧 QQ宠物 — 启动脚本（由安装程序自动生成）
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR"

for nvm_path in "$HOME/.nvm/nvm.sh" "$HOME/.config/nvm/nvm.sh" "/opt/homebrew/opt/nvm/nvm.sh"; do
  [ -f "$nvm_path" ] && source "$nvm_path" && break
done

LOCAL_ELECTRON="$APP_DIR/node_modules/.bin/electron"
if [ -f "$LOCAL_ELECTRON" ]; then
  exec "$LOCAL_ELECTRON" .
else
  exec ${launchCmd}
fi
`;
    fs.writeFileSync(startSh, script, { mode: 0o755 });

    // 桌面快捷方式
    const desktop = path.join(HOME, 'Desktop', '启动QQ宠物.command');
    fs.writeFileSync(desktop, `#!/bin/bash\nbash "${startSh}" &\n`, { mode: 0o755 });

    this.progress(5, '安装完成 🎉', 100);
  }

  // ── 工具：递归复制目录 ──
  copyDirSync(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      // 跳过 node_modules 和构建产物
      if (['node_modules', 'dist', '.git'].includes(entry.name)) continue;
      const srcPath = path.join(src, entry.name);
      const dstPath = path.join(dst, entry.name);
      if (entry.isDirectory()) {
        this.copyDirSync(srcPath, dstPath);
      } else {
        fs.copyFileSync(srcPath, dstPath);
      }
    }
  }
}

module.exports = InstallerCore;
