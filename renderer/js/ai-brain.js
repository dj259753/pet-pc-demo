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

  // ─── Soul 缓存（避免每次 prompt 都读文件） ───
  let cachedSoul = '';
  let soulLoadedAt = 0;
  const SOUL_CACHE_TTL = 60 * 60 * 1000; // 1小时刷新一次

  // Agent 文件路径（动态从 ai-config 的 agent_dir 读取，默认 .openclaw）
  let AGENT_DIR = `${window.__homeDir || '~'}/.openclaw/agents/qq-pet`;
  let SOUL_PATH     = `${AGENT_DIR}/SOUL.md`;
  let IDENTITY_PATH = `${AGENT_DIR}/IDENTITY.md`;
  let MEMORY_FILE_PATH = `${AGENT_DIR}/memory/MEMORY.md`;

  function updateAgentPaths(agentDir) {
    if (!agentDir) return;
    AGENT_DIR = String(agentDir).replace(/^~/, window.__homeDir || '~');
    SOUL_PATH = `${AGENT_DIR}/SOUL.md`;
    IDENTITY_PATH = `${AGENT_DIR}/IDENTITY.md`;
    MEMORY_FILE_PATH = `${AGENT_DIR}/memory/MEMORY.md`;
    console.log(`🧠 Agent 路径已更新: ${AGENT_DIR}`);
  }

  async function loadSoul() {
    try {
      const now = Date.now();
      if (cachedSoul && now - soulLoadedAt < SOUL_CACHE_TTL) return cachedSoul;
      if (window.electronAPI && window.electronAPI.agentReadFile) {
        const result = await window.electronAPI.agentReadFile(SOUL_PATH);
        if (result.ok && result.content) {
          cachedSoul = result.content;
          soulLoadedAt = now;
          console.log('🧠 SOUL.md 已加载，注入 Prompt');
          return cachedSoul;
        }
      }
    } catch (e) {
      console.warn('🧠 加载 SOUL.md 失败:', e.message);
    }
    return '';
  }

  /**
   * 更新 SOUL.md 或 IDENTITY.md（AI 进化自己的人设）
   * 写完后清除缓存，下次会重新读取
   */
  async function updateSoulFile(filePath, newContent, reason = '') {
    try {
      if (!window.electronAPI || !window.electronAPI.agentWriteFile) {
        console.warn('🧠 agentWriteFile 不可用');
        return false;
      }
      const result = await window.electronAPI.agentWriteFile(filePath, newContent);
      if (result.ok) {
        cachedSoul = '';  // 清除缓存，下次重新读
        soulLoadedAt = 0;
        // 在 memory 里记录这次改动
        const logLine = `\n- ${new Date().toISOString().split('T')[0]} 更新了 ${filePath.split('/').pop()}：${reason}\n`;
        await window.electronAPI.agentAppendFile(MEMORY_FILE_PATH, logLine).catch(() => {});
        console.log(`🧠 ${filePath.split('/').pop()} 已更新，原因: ${reason}`);
        return true;
      }
    } catch (e) {
      console.warn('🧠 updateSoulFile 失败:', e.message);
    }
    return false;
  }

  // 加载 AI 配置
  async function loadAIConfig() {
    try {
      if (window.electronAPI && window.electronAPI.getAIConfig) {
        const config = await window.electronAPI.getAIConfig();
        // 更新 Agent 文件路径（无论 provider 是什么都要更新）
        if (config && config.agent_dir) {
          updateAgentPaths(config.agent_dir);
        }
        // 只要有 api_url 就认为可用（不再严格要求 provider 非 local）
        if (config && config.api_url) {
          AI_PROVIDER = config.provider || 'openclaw';
          API_URL = config.api_url || '';
          API_KEY = config.api_key || '';
          MODEL = config.model || '';
          console.log(`🧠 AI 配置已加载: provider=${AI_PROVIDER}, model=${MODEL}, url=${API_URL}`);
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
  let consecutiveFailures = 0;  // 连续失败计数，用于触发配置恢复

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

    // Layer 1: Soul（如果已加载，优先用；否则用默认基础人设）
    let prompt = cachedSoul
      ? `${cachedSoul}\n\n---\n`
      : `你是桌面宠物"QQ企鹅"，定位是可靠的桌面协作伙伴。表达风格友好、清晰、务实，不要装可爱过头。\n`;

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
      consecutiveFailures++;
      // 连续失败 3 次后，尝试重新加载配置（可能端口变了）
      if (consecutiveFailures >= 3) {
        console.warn('🧠 连续 AI 调用失败，尝试重新加载配置...');
        consecutiveFailures = 0;
        loadAIConfig().then(ok => {
          if (ok) console.log('🧠 AI 配置已自动恢复');
        }).catch(() => {});
      }
      throw new Error(`API ${res.status}: ${errText.substring(0, 100)}`);
    }

    consecutiveFailures = 0;  // 成功则重置
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
      if (msg && msg.content) return cleanModelOutput(msg.content);
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
      if (text) return cleanModelOutput(text);
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

  // ─── Agent 工具进度回调（外部注册，用于气泡展示工具执行状态） ───
  let onToolProgressCallback = null;
  function onToolProgress(cb) { onToolProgressCallback = cb; }

  // ─── Agent thinking 回调（外部注册，用于展示推理过程） ───
  let onThinkingCallback = null;
  function onThinking(cb) { onThinkingCallback = cb; }

  /**
   * 清理模型原始输出中的 tool_call 标签和其他结构化标记
   * 某些模型（doubao、qwen 等）支持 function calling 时会在回复中夹带这些标签
   */
  function cleanModelOutput(text) {
    if (!text) return '';
    let cleaned = text;

    // 移除 <|tool_calls_section_begin|>...<|tool_calls_section_end|> 整块
    cleaned = cleaned.replace(/<\|tool_calls_section_begin\|>[\s\S]*?<\|tool_calls_section_end\|>/g, '');

    // 移除 <|tool_call_begin|>...<|tool_call_end|> 整块（含中间内容）
    cleaned = cleaned.replace(/<\|tool_call_begin\|>[\s\S]*?<\|tool_call_end\|>/g, '');

    // 移除 functions.xxx:N <|tool_call_argument_begin|> ... 到末尾（模型直出 function calling 文本）
    cleaned = cleaned.replace(/functions\.\w+:\d+\s*<\|tool_call_argument_begin\|>[\s\S]*/g, '');

    // 移除 <|tool_call_argument_begin|> ... <|tool_call_argument_end|> 块
    cleaned = cleaned.replace(/<\|tool_call_argument_begin\|>[\s\S]*?<\|tool_call_argument_end\|>/g, '');

    // 移除单独的结构化标签
    cleaned = cleaned.replace(/<\|(?:tool_calls_section_begin|tool_calls_section_end|tool_call_begin|tool_call_end|tool_call_argument_begin|tool_call_argument_end|tool_sep|im_end|im_start|endoftext|pad)\|>/g, '');

    // 移除 <tool_call>...</tool_call> 块
    cleaned = cleaned.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '');

    // 移除孤立的 JSON tool_call 格式
    cleaned = cleaned.replace(/\{"(?:name|function|tool_calls)":\s*"[^"]*",\s*"arguments":\s*(?:\{[^}]*\}|"[^"]*")\s*\}/g, '');

    // 移除 #soul-update: 指令行
    cleaned = cleaned.replace(/#soul-update:.*$/gm, '');

    // 移除 NO_REPLY 标记
    cleaned = cleaned.replace(/\bNO_REPLY\b/gi, '');

    // 移除 <think>...</think> 标签内容（部分模型的思考过程）
    const thinkMatch = cleaned.match(/<think>([\s\S]*?)<\/think>/);
    if (thinkMatch && onThinkingCallback) {
      onThinkingCallback(thinkMatch[1].trim());
    }
    cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/g, '');

    // 清理连续空行
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

    return cleaned.trim();
  }

  /**
   * 从整段文本解析 OpenAI 兼容 SSE（用于 Content-Type 不准或兜底）
   */
  function parseSseDataLines(text) {
    let accumulated = '';
    for (const line of String(text).split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'data: [DONE]') continue;
      if (!trimmed.startsWith('data:')) continue;
      try {
        const json = JSON.parse(trimmed.slice(5).trim());
        const delta = json?.choices?.[0]?.delta?.content || '';
        if (delta) accumulated += delta;
      } catch { /* ignore line */ }
    }
    return cleanModelOutput(accumulated);
  }

  /**
   * 消费 chat 接口响应：支持 text/event-stream 与一次性 application/json
   * （QQClaw / 部分网关在 stream:true 时仍返回 JSON，原先只读 SSE 会得到空回复并误判为断网）
   */
  async function consumeChatResponse(res) {
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('text/event-stream') || ct.includes('event-stream')) {
      const fromStream = (await readStream(res)).trim();
      if (fromStream) return fromStream;
      return '';
    }
    const text = await res.text();
    const head = text.trimStart();
    if (head.startsWith('data:') || head.startsWith('event:')) {
      return parseSseDataLines(text);
    }
    try {
      return (extractReply(JSON.parse(text)) || '').trim();
    } catch {
      return '';
    }
  }

  /**
   * 解析 SSE 流，逐 token 累积并回调
   * 增强：过滤 tool_call 标签，解析 finish_reason，处理 thinking 标记
   */
  async function readStream(res) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let rawAccumulated = '';   // 原始累积（未清理）
    let buffer = '';
    let finishReason = null;
    let lastDeltaTime = Date.now();
    let silenceNotified = false;

    // SSE 静默期检测：如果超过 3 秒没有 delta，说明 agent 在内部执行 tool
    const silenceTimer = setInterval(() => {
      if (!silenceNotified && Date.now() - lastDeltaTime > 3000 && !rawAccumulated) {
        silenceNotified = true;
        if (onToolProgressCallback) {
          onToolProgressCallback({ type: 'agent_start' });
        }
      }
    }, 1000);

    try {
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
            const choice = json?.choices?.[0];

            // 检查 finish_reason
            if (choice?.finish_reason) {
              finishReason = choice.finish_reason;
            }

            // 处理 assistant delta content
            const delta = choice?.delta?.content || '';
            if (delta) {
              lastDeltaTime = Date.now();
              rawAccumulated += delta;
              // 首次收到 delta 且之前显示了 thinking → 清除
              if (silenceNotified) {
                silenceNotified = false;
                if (onToolProgressCallback) {
                  onToolProgressCallback({ type: 'agent_end' });
                }
              }
              // 实时清理后推给气泡（用户不应看到原始标签）
              const cleaned = cleanModelOutput(rawAccumulated);
              if (cleaned && onStreamingReplyCallback) {
                onStreamingReplyCallback(cleaned);
              }
            }

            // 处理 tool_calls delta（某些模型/网关在 SSE 中也会发 tool_calls）
            const toolDelta = choice?.delta?.tool_calls;
            if (toolDelta && Array.isArray(toolDelta)) {
              for (const tc of toolDelta) {
                if (tc.function?.name && onToolProgressCallback) {
                  onToolProgressCallback({
                    phase: 'start',
                    name: tc.function.name,
                    toolCallId: tc.id || '',
                  });
                }
              }
            }
          } catch {}
        }
      }
    } finally {
      clearInterval(silenceTimer);
    }

    // 最终清理
    return cleanModelOutput(rawAccumulated);
  }

  /**
   * 对话模式：优先走 Gateway RPC chat.send（完整 Agent loop），回退 fetch
   * @param {string} userText - 用户输入
   * @param {Array} history - 对话历史
   * @returns {Promise<string>}
   */
  async function chat(userText, history = [], options = {}) {
    // 降级模式
    if (AI_PROVIDER === 'local' || !API_URL) {
      throw new Error('本地降级模式');
    }

    // 日限额检查
    const today = new Date().toDateString();
    if (apiCallsDate !== today) { apiCallsDate = today; apiCallsToday = 0; }
    if (apiCallsToday >= MAX_DAILY_CALLS) throw new Error('日调用限额已满');
    apiCallsToday++;

    // ── 优先走 Gateway RPC（完整 Agent loop，工具会被实际执行）──
    const hasRpc = window.electronAPI && window.electronAPI.gatewayChatSend;
    if (hasRpc) {
      try {
        const result = await window.electronAPI.gatewayChatSend(userText);
        if (result && result.success) {
          // chat.send 已被 Gateway 接受
          // 流式回复和工具进度通过 IPC 事件自动推送（init 中已注册监听）
          // 这里返回一个 Promise，等 chatFinalPromise 被 resolve
          return awaitChatFinal();
        }
        console.warn('🧠 Gateway RPC 返回失败，回退 fetch:', result && result.error);
      } catch (err) {
        console.warn('🧠 Gateway RPC 异常，回退 fetch:', err.message);
      }
    }

    // ── 回退：直连 Provider /chat/completions ──
    return chatViaFetch(userText, history, options);
  }

  // ── Gateway chat.send 后等待 final 事件 ──
  let _chatFinalResolve = null;
  let _chatFinalReject = null;
  let _chatFinalTimeout = null;
  let _chatAccumulatedText = '';

  function awaitChatFinal() {
    // 清理上一轮
    if (_chatFinalTimeout) clearTimeout(_chatFinalTimeout);
    _chatAccumulatedText = '';

    return new Promise((resolve, reject) => {
      _chatFinalResolve = resolve;
      _chatFinalReject = reject;
      // 5分钟超时兜底
      _chatFinalTimeout = setTimeout(() => {
        const text = _chatAccumulatedText;
        _chatFinalResolve = null;
        _chatFinalReject = null;
        if (text) {
          resolve(cleanModelOutput(text));
        } else {
          reject(new Error('Gateway 响应超时'));
        }
      }, 300000);
    });
  }

  /**
   * 处理 Gateway chat 事件（在 init 中注册一次）
   */
  function handleGatewayChatEvent(payload) {
    if (!payload) return;

    if (payload.state === 'delta') {
      const text = extractChatText(payload.message);
      if (text !== null) {
        _chatAccumulatedText = text;
        const cleaned = cleanModelOutput(text);
        if (cleaned && onStreamingReplyCallback) {
          onStreamingReplyCallback(cleaned);
        }
      }
    } else if (payload.state === 'final') {
      const finalText = extractChatText(payload.message);
      // 只在 final 有实质内容且比已累积的更长时才更新
      if (finalText && finalText.trim().length > 0 && finalText.length >= _chatAccumulatedText.length) {
        _chatAccumulatedText = finalText;
      }
      if (_chatFinalTimeout) clearTimeout(_chatFinalTimeout);
      if (_chatFinalResolve) {
        const cleaned = cleanModelOutput(_chatAccumulatedText);
        _chatFinalResolve(cleaned || '✅ 已完成');
        _chatFinalResolve = null;
        _chatFinalReject = null;
      }
    } else if (payload.state === 'aborted') {
      if (_chatFinalTimeout) clearTimeout(_chatFinalTimeout);
      if (_chatFinalResolve) {
        _chatFinalResolve(_chatAccumulatedText ? cleanModelOutput(_chatAccumulatedText) : '（已中断）');
        _chatFinalResolve = null;
        _chatFinalReject = null;
      }
    } else if (payload.state === 'error') {
      if (_chatFinalTimeout) clearTimeout(_chatFinalTimeout);
      if (_chatFinalReject) {
        _chatFinalReject(new Error(payload.errorMessage || 'Agent 执行出错'));
        _chatFinalResolve = null;
        _chatFinalReject = null;
      }
    }
  }

  /**
   * 处理 Gateway agent 事件（在 init 中注册一次）
   */
  function handleGatewayAgentEvent(payload) {
    if (!payload) return;
    const stream = payload.stream;
    const data = payload.data || {};

    if (stream === 'lifecycle') {
      if (data.phase === 'start' && onToolProgressCallback) {
        onToolProgressCallback({ type: 'agent_start' });
      } else if (data.phase === 'end' && onToolProgressCallback) {
        onToolProgressCallback({ type: 'agent_end' });
      }
    } else if (stream === 'tool') {
      const phase = data.phase;
      if (phase === 'start' && onToolProgressCallback) {
        onToolProgressCallback({ type: 'tool_start', phase: 'start', name: data.name || 'tool', toolCallId: data.toolCallId || '', args: data.args });
      } else if (phase === 'result' && onToolProgressCallback) {
        onToolProgressCallback({ type: 'tool_end', phase: 'result', name: data.name || 'tool', toolCallId: data.toolCallId || '' });
      }
    }
  }

  /**
   * 从 Gateway chat event message 中提取文本
   */
  function extractChatText(message) {
    if (!message) return null;
    const content = message.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const parts = content.filter(p => p && p.type === 'text' && typeof p.text === 'string').map(p => p.text);
      return parts.length > 0 ? parts.join('\n') : null;
    }
    if (typeof message.text === 'string') return message.text;
    return null;
  }

  /**
   * 回退方式：直接 fetch Provider /chat/completions
   */
  async function chatViaFetch(userText, history = [], options = {}) {
    const personality = typeof Personality !== 'undefined' ? Personality : null;
    const now = new Date();
    const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

    let prompt = cachedSoul
      ? `${cachedSoul}\n\n---\n`
      : `你是桌面宠物"QQ企鹅"，定位是可靠的桌面协作伙伴。表达风格友好、清晰、务实，不要装可爱过头。\n`;
    if (personality) {
      const p = personality.getCurrent();
      prompt += `性格：${p.mbti}，${p.speakStyle}\n`;
    }
    prompt += `偶尔流露一点小情绪或小关心，但不啰嗦；语气自然，像个熟悉的伙伴，不是客服。\n`;
    prompt += `当前时间：${weekdays[now.getDay()]} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}（${getTimePeriod(now.getHours())}）\n`;
    prompt += `回复要求：自然口语化，30-80字，信息明确，少用 emoji。只输出回复本身，不加前缀。\n`;

    const messages = [{ role: 'system', content: prompt }];
    const recentHistory = history.slice(-8);
    for (const msg of recentHistory) {
      messages.push({ role: msg.role, content: msg.text || msg.content });
    }
    messages.push({ role: 'user', content: userText });

    const headers = { 'Content-Type': 'application/json' };
    if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;

    const bodyBase = { model: MODEL, messages, temperature: 0.85, stream: true };
    let res = await fetch(API_URL, { method: 'POST', headers, body: JSON.stringify(bodyBase) });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`API ${res.status}: ${errText.substring(0, 100)}`);
    }

    let reply = await consumeChatResponse(res);
    if (!reply) {
      const res2 = await fetch(API_URL, { method: 'POST', headers, body: JSON.stringify({ ...bodyBase, stream: false }) });
      if (!res2.ok) { const errText = await res2.text().catch(() => ''); throw new Error(`API ${res2.status}: ${errText.substring(0, 100)}`); }
      reply = await consumeChatResponse(res2);
    }
    if (!reply) throw new Error('AI返回为空');
    return cleanModelOutput(reply);
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
    // 预加载 SOUL.md（异步，不阻塞启动）
    loadSoul().then(soul => {
      if (soul) console.log('🧠 SOUL.md 预加载成功');
    });
    // 每小时刷新话题
    setInterval(() => {
      topicIndex++;
    }, 3600000);
    // 每小时刷新一次 Soul 缓存
    setInterval(() => {
      loadSoul();
    }, SOUL_CACHE_TTL);

    // 监听 AI 配置更新（installer 完成安装 or 设置页重新配置后触发）
    if (window.electronAPI && window.electronAPI.onAiConfigUpdated) {
      window.electronAPI.onAiConfigUpdated(async () => {
        console.log('🧠 收到 ai-config-updated，重新加载 AI 配置...');
        const ok = await loadAIConfig();
        if (ok) {
          // 重新加载 Soul（配置可能改变了 Agent 目录）
          cachedSoul = '';
          soulLoadedAt = 0;
          await loadSoul();
          console.log('🧠 AI 配置已热更新，provider:', AI_PROVIDER);
        }
      });
    }

    // 监听 Gateway 状态变化（内嵌 Gateway 启动完成后重新加载配置）
    if (window.electronAPI && window.electronAPI.onGatewayStateChanged) {
      window.electronAPI.onGatewayStateChanged(async (state) => {
        console.log(`🧠 Gateway 状态变更: ${state}`);
        if (state === 'running') {
          const ok = await loadAIConfig();
          if (ok) {
            cachedSoul = '';
            soulLoadedAt = 0;
            await loadSoul();
            console.log('🧠 Gateway 就绪，AI 配置已更新');
          }
        }
      });
    }

    // 监听 Gateway 的 agent 事件（tool 执行进度、agent 生命周期等）— 旧的 stdout 解析方式
    if (window.electronAPI && window.electronAPI.onAgentEvent) {
      window.electronAPI.onAgentEvent((evt) => {
        if (onToolProgressCallback) {
          onToolProgressCallback(evt);
        }
      });
    }

    // ── Gateway RPC 事件监听（WebSocket 长连接，chat.send 后的流式回复和工具进度）──
    if (window.electronAPI && window.electronAPI.onGatewayChatEvent) {
      window.electronAPI.onGatewayChatEvent((payload) => {
        handleGatewayChatEvent(payload);
      });
    }
    if (window.electronAPI && window.electronAPI.onGatewayAgentEvent) {
      window.electronAPI.onGatewayAgentEvent((payload) => {
        handleGatewayAgentEvent(payload);
      });
    }

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
    loadSoul,
    updateSoulFile,
    onStreamingReply,
    onToolProgress,
    onThinking,
    cleanModelOutput,
    get apiCallsToday() { return apiCallsToday; },
    get dailyMoodKeyword() { return dailyMoodKeyword; },
    get provider() { return AI_PROVIDER; },
    get soulPath() { return SOUL_PATH; },
    get identityPath() { return IDENTITY_PATH; },
  };
})();
