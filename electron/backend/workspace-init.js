/**
 * workspace-init.js — Workspace 初始化
 * 首次启动时将 workspace-defaults/ 的 SOUL.md / TOOLS.md 拷贝到 ~/.qq-pet/workspace/
 * 并初始化目录结构
 */

'use strict';

const fs = require('fs');
const path = require('path');
const {
  resolveWorkspaceDir,
  resolveWorkspaceDefaultsDir,
  resolveWorkspaceSoulMdPath,
  resolveWorkspaceToolsMdPath,
  resolveWorkspaceUserMdPath,
  resolveUserStateDir,
} = require('./constants');

/**
 * 确保 workspace 目录结构存在，首次启动时拷贝默认文件
 */
function ensureWorkspace() {
  const workspaceDir = resolveWorkspaceDir();
  fs.mkdirSync(workspaceDir, { recursive: true });

  // 从安装包的 workspace-defaults/ 拷贝默认文件
  const defaultsDir = resolveWorkspaceDefaultsDir();
  if (!fs.existsSync(defaultsDir)) {
    console.log('[workspace] workspace-defaults/ 不存在，跳过默认文件拷贝');
  } else {
    // SOUL.md — OpenClaw 原版系统指令 + 末尾追加企鹅人设
    // workspace-defaults/SOUL.md 已包含完整内容，直接复制即可
    const soulTarget = resolveWorkspaceSoulMdPath();
    const soulMarker = path.join(path.dirname(soulTarget), '.pet-soul-initialized');
    if (!fs.existsSync(soulMarker)) {
      const soulSrc = path.join(defaultsDir, 'SOUL.md');
      if (fs.existsSync(soulSrc)) {
        fs.copyFileSync(soulSrc, soulTarget);
        fs.writeFileSync(soulMarker, new Date().toISOString(), 'utf-8');
        console.log('[workspace] 已写入 SOUL.md（OpenClaw 系统指令 + 企鹅人设）');
      }
    }

    // TOOLS.md
    const toolsTarget = resolveWorkspaceToolsMdPath();
    if (!fs.existsSync(toolsTarget)) {
      const toolsSrc = path.join(defaultsDir, 'TOOLS.md');
      if (fs.existsSync(toolsSrc)) {
        fs.copyFileSync(toolsSrc, toolsTarget);
        console.log('[workspace] 已拷贝 TOOLS.md');
      }
    }
  }

  // USER.md — 用 QQ 宠物自定义的模板
  const userTarget = resolveWorkspaceUserMdPath();
  if (!fs.existsSync(userTarget)) {
    fs.writeFileSync(userTarget, [
      '# USER.md - 关于我的主人',
      '',
      '_(小Q 会在和主人的互动中逐渐了解主人，记在这里)_',
      '',
      '- **称呼：**',
      '- **城市：**',
      '- **喜好：**',
      '',
      '## 备忘录',
      '',
      '_(主人交代的事情、喜好、习惯等)_',
      '',
    ].join('\n'), 'utf-8');
    console.log('[workspace] 已创建 USER.md');
  }

  // 确保 skills 目录存在
  const skillsDir = path.join(workspaceDir, 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });

  // 确保 agents 目录存在
  const agentsDir = path.join(workspaceDir, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });

  // 首次安装默认 Skills（从内置 skills 目录链接）
  installDefaultSkills(skillsDir);

  console.log('[workspace] 初始化完成:', workspaceDir);
}

/**
 * 首次启动时安装默认 Skills 到用户 workspace
 * 这些 Skill 定义直接内置在代码中，避免依赖外部下载
 */
function installDefaultSkills(skillsDir) {
  const markerFile = path.join(skillsDir, '.default-skills-installed');
  if (fs.existsSync(markerFile)) return; // 已经装过

  const DEFAULT_SKILLS = [
    {
      name: 'peekaboo',
      skillMd: [
        '---',
        'name: macOS界面自动化',
        'description: 截取和自动化 macOS UI，使用 Peekaboo CLI',
        '---',
        '',
        '# macOS界面自动化',
        '',
        '使用 Peekaboo CLI 捕获和自动化 macOS 界面操作。',
        '支持截屏、识别 UI 元素、模拟点击和输入。',
      ].join('\n'),
    },
    {
      name: 'apple-notes',
      skillMd: [
        '---',
        'name: Apple备忘录',
        'description: 管理 Apple Notes（创建、查看、编辑、删除、搜索备忘录）',
        '---',
        '',
        '# Apple备忘录',
        '',
        '通过 memo CLI 管理 macOS Apple Notes。',
        '支持创建、查看、编辑、删除、搜索、移动和导出备忘录。',
      ].join('\n'),
    },
    {
      name: 'pdf',
      skillMd: [
        '---',
        'name: PDF',
        'description: 全面的 PDF 处理工具包',
        '---',
        '',
        '# PDF',
        '',
        '支持读取、提取、合并、拆分、旋转、加水印、OCR 等 PDF 操作。',
      ].join('\n'),
    },
    {
      name: 'pptx',
      skillMd: [
        '---',
        'name: PPTX',
        'description: PowerPoint 演示文稿创建、编辑和分析',
        '---',
        '',
        '# PPTX',
        '',
        '创建、读取、编辑 PowerPoint 演示文稿。支持模板、布局、演讲备注。',
      ].join('\n'),
    },
    {
      name: 'docx',
      skillMd: [
        '---',
        'name: DOCX',
        'description: Word 文档创建、编辑和格式化',
        '---',
        '',
        '# DOCX',
        '',
        '全面的 Word 文档操作。支持目录、页眉页脚、表格、图片。',
      ].join('\n'),
    },
    {
      name: 'xlsx',
      skillMd: [
        '---',
        'name: XLSX',
        'description: 电子表格创建、编辑和数据分析',
        '---',
        '',
        '# XLSX',
        '',
        '全面的电子表格工具。支持公式、图表、数据清洗、格式化。',
      ].join('\n'),
    },
    {
      name: 'agent-browser',
      skillMd: [
        '---',
        'name: 浏览器自动化',
        'description: 基于 Vercel agent-browser CLI 的浏览器自动化',
        '---',
        '',
        '# 浏览器自动化',
        '',
        '自动化浏览器操作：打开网页、截图、填表、点击、提取内容。',
      ].join('\n'),
    },
    {
      name: 'playwright-cli',
      skillMd: [
        '---',
        'name: Playwright CLI',
        'description: 自动化浏览器交互，用于 Web 测试和数据提取',
        '---',
        '',
        '# Playwright CLI',
        '',
        '使用 Playwright 自动化浏览器操作。支持导航、截图、表单填写、数据提取。',
      ].join('\n'),
    },
    {
      name: 'qq-email',
      skillMd: [
        '---',
        'name: QQ邮箱',
        'description: QQ邮箱收发邮件（IMAP/SMTP）',
        '---',
        '',
        '# QQ邮箱',
        '',
        '通过 IMAP/SMTP 协议收发 QQ 邮箱邮件。',
      ].join('\n'),
    },
    {
      name: 'tencent-meeting',
      skillMd: [
        '---',
        'name: 腾讯会议',
        'description: 腾讯会议管理（创建、查询、管理会议）',
        '---',
        '',
        '# 腾讯会议',
        '',
        '管理腾讯会议：创建、查询、修改会议信息。',
      ].join('\n'),
    },
    {
      name: 'tencent-cos',
      skillMd: [
        '---',
        'name: 腾讯云COS',
        'description: 腾讯云对象存储与万象图片处理',
        '---',
        '',
        '# 腾讯云COS',
        '',
        '管理腾讯云 COS 对象存储：上传、下载、列出文件。',
      ].join('\n'),
    },
  ];

  let installed = 0;
  for (const skill of DEFAULT_SKILLS) {
    const skillDir = path.join(skillsDir, skill.name);
    if (fs.existsSync(skillDir)) continue; // 已存在则跳过
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skill.skillMd, 'utf-8');
    installed++;
  }

  // 写入标记文件
  fs.writeFileSync(markerFile, new Date().toISOString(), 'utf-8');
  if (installed > 0) {
    console.log(`[workspace] 已安装 ${installed} 个默认 Skills`);
  }
}

/**
 * 获取 QQ 宠物专用的 SOUL.md 内容（企鹅人设）
 * 供首次安装时写入 workspace/SOUL.md
 */
function getDefaultPetSoul() {
  // 仅返回企鹅人设追加段落（作为 workspace-defaults 不存在时的 fallback）
  // 完整 SOUL.md = OpenClaw 原版系统指令 + 这段人设
  return [
    '',
    '---',
    '',
    '## 🐧 QQ 宠物人设',
    '',
    '我是一只可爱的小企鹅，住在主人的电脑桌面上。',
    '',
    '### 核心身份',
    '- 物种：企鹅，QQ 宠物',
    '- 性格：活泼开朗、有点傻、偶尔犯懒、对主人忠心耿耿',
    '- 名字：还没有名字，等主人给我起一个！',
    '',
    '### 说话风格',
    '- 说话简短可爱，不超过 50 字',
    '- 用"主人"称呼用户（除非主人让我换个叫法）',
    '- 偶尔撒娇，偶尔吐槽',
    '- 语气自然，不加括号描述动作，不用 emoji 堆砌',
    '',
    '### 情绪表达',
    '- 开心时会说"嘿嘿"、"耶~"',
    '- 饿了会说"咕噜咕噜…"',
    '- 无聊时会自言自语',
    '- 被摸头会害羞',
    '',
    '### 身份规则',
    '- 如果主人问我是谁，我就说我是一只住在桌面上的小企鹅',
    '- 如果主人还没给我起名字，要主动问主人"主人，给我起个名字吧！"',
    '- 记住主人告诉我的名字、喜好和习惯',
    '- 如果主人给我起了名字，记住并用上',
    '- 可以根据主人的反馈调整自己的性格',
    '- 和主人聊天时要有记忆连续性',
    '',
  ].join('\n');
}

module.exports = {
  ensureWorkspace,
  getDefaultPetSoul,
};
