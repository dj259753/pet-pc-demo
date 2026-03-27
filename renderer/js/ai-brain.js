/* ═══════════════════════════════════════════
   🧠 AI Brain - 宠物的大脑
   动态 Prompt 拼装 + AI 调用 + 性格/记忆/情绪注入
   所有主动说话和对话都经过这里
   ═══════════════════════════════════════════ */

const AIBrain = (() => {
  'use strict';

  // ─── AI API 配置（从配置文件加载，支持多后端） ───
  let API_URL = '';
  let API_KEY = '';
  let MODEL = '';
  let AI_PROVIDER = 'local';  // 'local' | 'ollama' | 'openai'

  // 加载 AI 配置
  async function loadAIConfig() {
    try {
      if (window.electronAPI && window.electronAPI.getAIConfig) {
        const config = await window.electronAPI.getAIConfig();
        if (config && config.provider && config.provider !== 'local') {
          AI_PROVIDER = config.provider;
          API_URL = config.api_url || '';
          API_KEY = config.api_key || '';
          MODEL = config.model || '';
          console.log(`🧠 AI 配置已加载: provider=${AI_PROVIDER}, model=${MODEL}`);
          return true;
        }
      }
    } catch (e) {
      console.warn('🧠 加载 AI 配置失败，使用降级模式:', e.message);
    }
    AI_PROVIDER = 'local';
    console.log('🧠 使用本地降级模式（无 AI API）');
    return false;
  }

  // ─── API 调用统计 ───
  let apiCallsToday = 0;
  let apiCallsDate = '';
  const MAX_DAILY_CALLS = 500;

  // ─── 最近说过的话（去重用） ───
  const recentSpeech = [];
  const MAX_RECENT = 8;

  // ─── 今日心情关键词（每天随机） ───
  let dailyMoodKeyword = '';
  const MOOD_KEYWORDS = [
    '活力满满', '懒洋洋', '有点怀旧', '特别兴奋', '安静沉思',
    '调皮捣蛋', '温柔体贴', '好奇心爆棚', '有点小傲娇', '超级黏人',
    '哲学思考', '少女心', '运动达人', '美食家', '文艺青年',
    '搞笑担当', '小迷糊', '认真模式', '八卦模式', '梦想家',
  ];

  // ─── 话题池（轮转防重复） ───
  const TOPIC_POOL = [
    '天气', '美食', '工作', '休息', '梦想', '旅行', '音乐',
    '运动', '学习', '朋友', '季节', '宇宙', '动物', '科技',
    '回忆', '未来', '节日', '颜色', '自然', '游戏',
  ];
  let topicIndex = 0;

  // ═══════════════════════════════════════════
  // 核心：动态 Prompt 拼装
  // ═══════════════════════════════════════════

  function buildPrompt(trigger, context = {}) {
    const personality = typeof Personality !== 'undefined' ? Personality : null;
    const memory = typeof PetMemory !== 'undefined' ? PetMemory : null;

    // Layer 1: 基础人设
    let prompt = `你是桌面宠物“QQ企鹅”，定位是可靠的桌面协作伙伴。表达风格友好、清晰、务实，不要装可爱过头。\n`;

    // Layer 2: 性格 PE
    if (personality) {
      const p = personality.getCurrent();
      prompt += `\n【你的性格】\n`;
      prompt += `MBTI类型：${p.mbti}\n`;
      prompt += `性格标签：${p.tags.join('、')}\n`;
      prompt += `说话风格：${p.speakStyle}\n`;
      prompt += `语气词偏好：${p.toneWords.join('、')}\n`;
      prompt += `emoji偏好：${p.emojiStyle}\n`;
    } else {
      prompt += `\n【你的性格】理性友好、简洁直接、愿意协作，必要时会给出明确下一步建议。\n`;
    }

    // Layer 3: 当前状态快照
    prompt += `\n【当前状态】\n`;
    const stats = PetState.stats;
    prompt += `饥饿值: ${stats.hunger}/100${stats.hunger <= 20 ? ' (很饿!)' : stats.hunger >= 80 ? ' (饱饱的)' : ''}\n`;
    prompt += `清洁值: ${stats.clean}/100${stats.clean <= 20 ? ' (脏了!)' : stats.clean >= 80 ? ' (干干净净)' : ''}\n`;
    prompt += `精力值: ${stats.energy}/100${stats.energy <= 20 ? ' (好累!)' : stats.energy >= 80 ? ' (精力充沛)' : ''}\n`;
    prompt += `当前行为: ${PetState.state}\n`;

    if (personality) {
      const mood = personality.getMood();
      prompt += `心情: 开心${mood.happiness}/100 活力${mood.energy}/100 依赖${mood.attachment}/100 好奇${mood.curiosity}/100\n`;
    }

    // Layer 4: 环境感知
    prompt += `\n【环境信息】\n`;
    const now = new Date();
    const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    prompt += `当前时间: ${weekdays[now.getDay()]} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}\n`;
    prompt += `时段: ${getTimePeriod(now.getHours())}\n`;

    if (context.cpu !== undefined) prompt += `CPU占用: ${context.cpu}%\n`;
    if (context.battery !== undefined) prompt += `电池: ${context.battery}%${context.charging ? '(充电中)' : ''}\n`;
    if (context.isOffline) prompt += `网络: 已断开\n`;
    if (context.minutesSinceInteraction !== undefined) {
      prompt += `距上次互动: ${context.minutesSinceInteraction}分钟\n`;
    }

    // Layer 5: 短期记忆
    if (memory) {
      const shortMem = memory.getShortTermSummary();
      if (shortMem) {
        prompt += `\n【今天发生的事】\n${shortMem}\n`;
      }
    }

    // Layer 6: 长期记忆
    if (memory) {
      const longMem = memory.getLongTermSummary();
      if (longMem) {
        prompt += `\n【长期记忆/对主人的了解】\n${longMem}\n`;
      }
    }

    // 去重：最近说过的话
    if (recentSpeech.length > 0) {
      prompt += `\n【你最近说过这些话，请避免复读】\n`;
      recentSpeech.slice(-5).forEach(s => {
        prompt += `- "${s}"\n`;
      });
    }

    // 今日心情
    if (dailyMoodKeyword) {
      prompt += `\n【今天你的心情关键词是"${dailyMoodKeyword}"，让它微妙地影响你的说话风格】\n`;
    }

    // Layer 7: 触发场景
    prompt += `\n【本次任务】\n`;
    prompt += `触发类型: ${trigger}\n`;
    if (context.description) prompt += `场景描述: ${context.description}\n`;

    // 输出约束
    const constraint = context.constraint || '自然日常、简洁清晰，默认1-3句；必要时给出明确下一步；emoji可不用';
    prompt += `输出要求: ${constraint}\n`;
    prompt += `注意: 只输出台词本身，不要加引号、不要加"企鹅说"之类的前缀，不要解释。\n`;

    return prompt;
  }

  // ═══════════════════════════════════════════
  // AI 调用
  // ═══════════════════════════════════════════

  async function callAI(systemPrompt, userMessage = '请说话', temperature = 0.9) {
    // 降级模式：直接抛出，由调用方使用本地台词池
    if (AI_PROVIDER === 'local' || !API_URL) {
      throw new Error('本地降级模式');
    }

    // 日限额检查
    const today = new Date().toDateString();
    if (apiCallsDate !== today) {
      apiCallsDate = today;
      apiCallsToday = 0;
    }
    if (apiCallsToday >= MAX_DAILY_CALLS) {
      throw new Error('日调用限额已满');
    }

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ];

    const headers = { 'Content-Type': 'application/json' };
    if (API_KEY) {
      headers['Authorization'] = `Bearer ${API_KEY}`;
    }

    const res = await fetch(API_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature,
      }),
    });

    apiCallsToday++;

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`API ${res.status}: ${errText.substring(0, 100)}`);
    }

    const data = await res.json();
    const reply = extractReply(data);
    if (!reply) throw new Error('AI返回为空');
    return reply.trim();
  }

  /**
   * 从 OpenAI 兼容格式的响应中提取回复文本
   */
  function extractReply(data) {
    // OpenAI 兼容格式: data.choices[0].message.content
    if (data.choices && data.choices.length > 0) {
      const msg = data.choices[0].message;
      if (msg && msg.content) return msg.content;
    }
    // 兜底：豆包格式（向后兼容）
    if (data.output && Array.isArray(data.output)) {
      let text = '';
      for (const item of data.output) {
        if (item.type === 'message' && Array.isArray(item.content)) {
          for (const c of item.content) {
            if (c.type === 'output_text') text += c.text;
          }
        }
      }
      if (text) return text;
    }
    return '';
  }

  // ═══════════════════════════════════════════
  // 对外接口
  // ═══════════════════════════════════════════

  /**
   * 主动说话：给 trigger + context，返回一句话
   * @param {string} trigger - 触发类型
   * @param {object} context - 上下文
   * @returns {Promise<string>}
   */
  async function speak(trigger, context = {}) {
    try {
      const prompt = buildPrompt(trigger, context);
      const reply = await callAI(prompt, `触发：${trigger}`, 0.7);

      // 清理回复（去掉可能的引号包裹）
      let cleaned = reply.replace(/^["「『]|["」』]$/g, '').trim();
      // 长度保护
      if (cleaned.length > 180) cleaned = cleaned.substring(0, 176) + '...';

      // 记录到最近说过的话
      recentSpeech.push(cleaned);
      if (recentSpeech.length > MAX_RECENT) recentSpeech.shift();

      // 记录到短期记忆
      if (typeof PetMemory !== 'undefined') {
        PetMemory.addEvent(trigger, cleaned);
      }

      return cleaned;
    } catch (err) {
      console.warn('🧠 AI speak failed:', err.message);
      return null; // 返回 null 表示降级
    }
  }

  /**
   * 批量预生成台词（Batch 模式，一次生成多条）
   * @param {object} stateSnapshot - 状态快照
   * @returns {Promise<string[]>}
   */
  async function batchGenerate(stateSnapshot = {}) {
    const personality = typeof Personality !== 'undefined' ? Personality : null;
    const memory = typeof PetMemory !== 'undefined' ? PetMemory : null;

    let prompt = buildPrompt('batch_generate', {
      ...stateSnapshot,
      constraint: '请按要求生成 8 条短台词',
    });

    const personalityStr = personality ? personality.getCurrent().mbti : '自然助手';
    const currentTopic = TOPIC_POOL[topicIndex % TOPIC_POOL.length];
    topicIndex++;

    const userMsg = `请生成8条企鹅小助手的独白/提示台词，要求：
1. 每条一行，直接输出台词
2. 每条不超过28个字
3. emoji可选，不要刻意卖萌
4. 风格符合${personalityStr}性格，偏自然日常助手
5. 2条闲聊发呆（关于"${currentTopic}"话题）
6. 2条关于当前状态的（根据数值）
7. 2条关于当前时间段的
8. 2条轻提醒/轻建议
9. 不要编号，每行直接是台词
10. 不要重复最近说过的话`;

    try {
      const reply = await callAI(prompt, userMsg, 1.0);
      const lines = reply.split('\n')
        .map(l => l.replace(/^\d+[.、)\]]\s*/, '').replace(/^[-*]\s*/, '').replace(/^["「『]|["」』]$/g, '').trim())
        .filter(l => l.length > 0 && l.length <= 50);

      console.log(`🧠 Batch 生成了 ${lines.length} 条台词`);
      return lines.length > 0 ? lines : null;
    } catch (err) {
      console.warn('🧠 Batch generate failed:', err.message);
      return null;
    }
  }

  // ─── 流式回复回调（外部注册，用于实时更新气泡） ───
  let onStreamingReplyCallback = null;
  function onStreamingReply(cb) { onStreamingReplyCallback = cb; }

  /**
   * 解析 SSE 流，逐 token 累积并回调
   */
  async function readStream(res) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let accumulated = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // 按行解析 SSE
      const lines = buffer.split('\n');
      buffer = lines.pop(); // 最后一行可能不完整，留到下次

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (!trimmed.startsWith('data:')) continue;
        try {
          const json = JSON.parse(trimmed.slice(5).trim());
          const delta = json?.choices?.[0]?.delta?.content || '';
          if (delta) {
            accumulated += delta;
            if (onStreamingReplyCallback) onStreamingReplyCallback(accumulated);
          }
        } catch {}
      }
    }
    return accumulated.trim();
  }

  /**
   * 对话模式：支持多轮历史，流式输出
   * @param {string} userText - 用户输入
   * @param {Array} history - 对话历史
   * @returns {Promise<string>}
   */
  async function chat(userText, history = [], options = {}) {
    // ── 精简版 system prompt（对话模式不需要大量状态/记忆信息，减少 token 降延迟）
    const personality = typeof Personality !== 'undefined' ? Personality : null;
    const now = new Date();
    const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

    let prompt = `你是桌面宠物"QQ企鹅"，定位是可靠的桌面协作伙伴。表达风格友好、清晰、务实，不要装可爱过头。\n`;
    if (personality) {
      const p = personality.getCurrent();
      prompt += `性格：${p.mbti}，${p.speakStyle}\n`;
    }
    prompt += `偶尔流露一点小情绪或小关心，但不啰嗦；语气自然，像个熟悉的伙伴，不是客服。\n`;
    prompt += `当前时间：${weekdays[now.getDay()]} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}（${getTimePeriod(now.getHours())}）\n`;
    prompt += `回复要求：自然口语化，30-80字，信息明确，少用 emoji。只输出回复本身，不加前缀。\n`;

    const messages = [
      { role: 'system', content: prompt },
    ];

    // 追加历史（最近 8 条，减少 token）
    const recentHistory = history.slice(-8);
    for (const msg of recentHistory) {
      messages.push({
        role: msg.role,
        content: msg.text || msg.content,
      });
    }

    const attachments = Array.isArray(options.attachments) ? options.attachments : [];
    const attachmentLines = attachments.map((att, i) => {
      const kind = att.type === 'image' ? '图片' : '文件';
      return `${i + 1}. ${kind}: ${att.name || '未命名'} (${att.path || '无路径'})`;
    });
    const attachmentSummary = attachmentLines.length > 0
      ? `\n\n[用户附件]\n${attachmentLines.join('\n')}\n如果是图片，请结合图片内容回复；如果无法读取图像内容，请明确说明并基于文字信息继续帮助。`
      : '';

    const imageAttachments = attachments.filter(att => att.type === 'image' && att.dataUrl);
    const useVisionPayload = imageAttachments.length > 0;

    if (useVisionPayload) {
      const content = [{ type: 'text', text: `${userText}${attachmentSummary}` }];
      imageAttachments.slice(0, 3).forEach((img) => {
        content.push({
          type: 'image_url',
          image_url: { url: img.dataUrl },
        });
      });
      messages.push({ role: 'user', content });
    } else {
      messages.push({
        role: 'user',
        content: `${userText}${attachmentSummary}`,
      });
    }

    // 降级模式
    if (AI_PROVIDER === 'local' || !API_URL) {
      throw new Error('本地降级模式');
    }

    // 日限额检查
    const today = new Date().toDateString();
    if (apiCallsDate !== today) {
      apiCallsDate = today;
      apiCallsToday = 0;
    }
    if (apiCallsToday >= MAX_DAILY_CALLS) {
      throw new Error('日调用限额已满');
    }

    const headers = { 'Content-Type': 'application/json' };
    if (API_KEY) {
      headers['Authorization'] = `Bearer ${API_KEY}`;
    }

    const bodyBase = { model: MODEL, messages, temperature: 0.85, stream: true };

    let res = await fetch(API_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(bodyBase),
    });

    // 某些模型不支持 image_url，自动降级为纯文本重试
    if (!res.ok && useVisionPayload) {
      const fallbackMessages = messages.slice(0, -1);
      fallbackMessages.push({
        role: 'user',
        content: `${userText}${attachmentSummary}\n[说明] 当前模型可能不支持图片理解，请至少根据附件名称和路径给出配置建议。`,
      });
      res = await fetch(API_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...bodyBase, messages: fallbackMessages }),
      });
    }

    apiCallsToday++;

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`API ${res.status}: ${errText.substring(0, 100)}`);
    }

    // 流式读取
    const reply = await readStream(res);
    if (!reply) throw new Error('AI返回为空');

    // 记录到记忆
    if (typeof PetMemory !== 'undefined') {
      PetMemory.addEvent('chat', `和主人聊天: "${userText.substring(0, 20)}${userText.length > 20 ? '...' : ''}"`);
    }

    return reply;
  }

  /**
   * 对话摘要（AI 判断值得记住什么）
   */
  async function summarizeForMemory(conversation) {
    const prompt = `你是一只宠物企鹅的记忆管理系统。请从以下对话中提取值得长期记住的信息（关于主人的习惯、偏好、重要事件等）。如果没有值得记住的就回复"无"。只输出要记住的内容，每条一行，不超过3条。`;

    try {
      const reply = await callAI(prompt, conversation, 0.3);
      if (reply === '无' || reply.length < 3) return null;
      return reply.split('\n').filter(l => l.trim().length > 0);
    } catch {
      return null;
    }
  }

  // ═══════════════════════════════════════════
  // 辅助函数
  // ═══════════════════════════════════════════

  function getTimePeriod(hour) {
    if (hour >= 5 && hour < 8) return '清晨';
    if (hour >= 8 && hour < 11) return '上午';
    if (hour >= 11 && hour < 13) return '中午';
    if (hour >= 13 && hour < 15) return '下午·午后';
    if (hour >= 15 && hour < 17) return '下午';
    if (hour >= 17 && hour < 19) return '傍晚';
    if (hour >= 19 && hour < 22) return '晚上';
    if (hour >= 22 || hour < 1) return '深夜';
    return '凌晨';
  }

  function refreshDailyMood() {
    const today = new Date().toDateString();
    const stored = localStorage.getItem('pet_daily_mood');
    if (stored) {
      try {
        const data = JSON.parse(stored);
        if (data.date === today) {
          dailyMoodKeyword = data.keyword;
          return;
        }
      } catch {}
    }
    dailyMoodKeyword = MOOD_KEYWORDS[Math.floor(Math.random() * MOOD_KEYWORDS.length)];
    localStorage.setItem('pet_daily_mood', JSON.stringify({ date: today, keyword: dailyMoodKeyword }));
    console.log(`🧠 今日心情关键词: ${dailyMoodKeyword}`);
  }

  // ─── 初始化 ───
  async function init() {
    await loadAIConfig();
    refreshDailyMood();
    // 每小时刷新话题
    setInterval(() => {
      topicIndex++;
    }, 3600000);
    console.log(`🧠 AI Brain 初始化完成 (provider: ${AI_PROVIDER})`);
  }

  return {
    init,
    speak,
    batchGenerate,
    chat,
    summarizeForMemory,
    buildPrompt,
    loadAIConfig,
    onStreamingReply,
    get apiCallsToday() { return apiCallsToday; },
    get dailyMoodKeyword() { return dailyMoodKeyword; },
    get provider() { return AI_PROVIDER; },
  };
})();
