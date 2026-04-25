'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const sessionStore = require('./lib/session-store');

const DEBUG_LOG_DIR = path.join(__dirname, 'logs');
const REGISTRY_DIR = path.join(os.homedir(), '.openclaw', 'fbc-registry');
const REGISTRY_PATH = path.join(REGISTRY_DIR, 'registry.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function getDebugLogPath() {
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return path.join(DEBUG_LOG_DIR, `a2a-debug-${date}.log`);
}

function debugLog(msg) {
  try {
    fs.mkdirSync(DEBUG_LOG_DIR, { recursive: true });
    fs.appendFileSync(getDebugLogPath(), `[${new Date().toISOString()}] ${msg}\n`);
  } catch (_) { /* ignore */ }
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractChatId(sessionKey, conversationId) {
  if (conversationId && conversationId.startsWith('oc_')) return conversationId;
  if (!sessionKey) return null;
  const match = sessionKey.match(/:feishu:group:(oc_[^:]+)/);
  return match ? match[1] : null;
}

function extractBrief(content) {
  const clean = content
    .replace(/<at[^>]*>[^<]*<\/at>\s*(\([^)]*\))?/g, '')
    .replace(/完成后请\s*@\s*回我汇报结果。?/g, '')
    .trim();
  const lines = clean.split('\n').filter(l => l.trim());
  for (const line of lines) {
    const taskMatch = line.match(/\*{0,2}任务\*{0,2}[：:]\s*(.+)/);
    if (taskMatch) return taskMatch[1].trim().substring(0, 200);
  }
  const first = lines[0] || '';
  return first.replace(/^\*+\s*/, '').trim().substring(0, 200);
}

// ---------------------------------------------------------------------------
// Auto-discovery: derive botRegistry from OpenClaw config + Feishu API
// ---------------------------------------------------------------------------

function readCache() {
  try {
    const raw = fs.readFileSync(REGISTRY_PATH, 'utf8');
    const cached = JSON.parse(raw);
    if (cached.discoveredAt && Date.now() - new Date(cached.discoveredAt).getTime() < CACHE_TTL_MS) {
      debugLog(`[discover] Using cached registry (discoveredAt=${cached.discoveredAt})`);
      return cached;
    }
    debugLog(`[discover] Cache expired (discoveredAt=${cached.discoveredAt})`);
    return null;
  } catch (_) {
    return null;
  }
}

function writeCache(bots) {
  try {
    fs.mkdirSync(REGISTRY_DIR, { recursive: true });
    const data = { discoveredAt: new Date().toISOString(), bots };
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify(data, null, 2));
    debugLog(`[discover] Wrote registry cache with ${Object.keys(bots).length} bots`);
  } catch (e) {
    debugLog(`[discover] Failed to write cache: ${e.message}`);
  }
}

async function getTenantToken(appId, appSecret, domain) {
  const base = domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
  const url = `${base}/open-apis/auth/v3/tenant_access_token/internal`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const json = await res.json();
  if (json.code !== 0) throw new Error(`tenant_token failed: ${json.msg}`);
  return json.tenant_access_token;
}

async function getBotInfo(token, domain) {
  const base = domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
  const url = `${base}/open-apis/bot/v3/info`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  if (json.code !== 0) throw new Error(`bot/v3/info failed: ${json.msg}`);
  const bot = json.bot || {};
  return { botOpenId: bot.open_id, botName: bot.app_name || bot.bot_name };
}

async function discoverBots(config, log) {
  const bindings = config.bindings || [];
  const feishuChannel = config.channels?.feishu || {};
  const accounts = feishuChannel.accounts || {};
  const domain = feishuChannel.domain || 'feishu';

  const agentAccountMap = new Map();
  for (const b of bindings) {
    if (b.match?.channel === 'feishu' && b.match?.accountId) {
      agentAccountMap.set(b.agentId, b.match.accountId);
    }
  }

  debugLog(`[discover] Found ${agentAccountMap.size} feishu agent-account bindings`);
  if (agentAccountMap.size === 0) return {};

  const validAccounts = new Map();
  for (const [accountId, acct] of Object.entries(accounts)) {
    if (acct.appId && acct.appSecret) {
      validAccounts.set(accountId, acct);
    }
  }

  const cached = readCache();
  if (cached?.bots) {
    const allCovered = [...agentAccountMap.keys()].every(agentId => cached.bots[agentId]);
    if (allCovered) {
      return cached.bots;
    }
    debugLog(`[discover] Cache incomplete, re-discovering`);
  }

  const bots = {};
  const tokenCache = new Map();

  for (const [agentId, accountId] of agentAccountMap) {
    const acct = validAccounts.get(accountId);
    if (!acct) {
      debugLog(`[discover] No valid account config for accountId=${accountId}, skipping agent=${agentId}`);
      continue;
    }

    try {
      let token = tokenCache.get(accountId);
      if (!token) {
        token = await getTenantToken(acct.appId, acct.appSecret, domain);
        tokenCache.set(accountId, token);
      }

      const info = await getBotInfo(token, domain);
      bots[agentId] = {
        accountId,
        botOpenId: info.botOpenId,
        botName: info.botName,
      };
      debugLog(`[discover] Discovered: agent=${agentId}, accountId=${accountId}, botOpenId=${info.botOpenId}, botName=${info.botName}`);
      log.info(`[openclaw-feishu-a2a] Discovered bot: ${agentId} → ${info.botName} (${info.botOpenId})`);
    } catch (e) {
      debugLog(`[discover] Failed for agent=${agentId}, accountId=${accountId}: ${e.message}`);
      log.warn(`[openclaw-feishu-a2a] Failed to discover bot for ${agentId}: ${e.message}`);
      if (cached?.bots?.[agentId]) {
        bots[agentId] = cached.bots[agentId];
        debugLog(`[discover] Using stale cache for agent=${agentId}`);
      }
    }
  }

  if (Object.keys(bots).length > 0) {
    writeCache(bots);
  }

  return bots;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

let _lastBotSignature = '';
let _registerCount = 0;

const plugin = {
  id: 'openclaw-feishu-a2a',
  name: 'OpenClaw Feishu A2A',
  description: 'Enables bot-to-bot @ communication in Feishu group chats with task tracking and auto @-back enforcement',

  register(api) {
    const cfg = api.pluginConfig ?? {};
    const log = api.logger;

    if (_registerCount === 0) {
      debugLog(`REGISTER called`);
    }

    // Shared state
    let botRegistry = {};
    const botOpenIdSet = new Set();
    const botOpenIdToAgentMap = new Map();
    const accountIdToAgentMap = new Map(); // accountId → { agentId, botOpenId, botName }
    const agentIdSet = new Set();

    const nativeA2AChats = new Set();

    // Group member cache: chatId → { botOpenIds: Set, fetchedAt: number }
    const groupMemberCache = new Map();
    const GROUP_MEMBER_CACHE_TTL = 10 * 60 * 1000;

    // Last user message per chatId — used as userRequest when creating sessions
    const lastUserMessage = new Map();

    // Feishu account config for API calls
    const feishuChannel = api.config?.channels?.feishu || {};
    const feishuAccounts = feishuChannel.accounts || {};
    const feishuDomain = feishuChannel.domain || 'feishu';

    async function getGroupBotOpenIds(chatId) {
      const cached = groupMemberCache.get(chatId);
      if (cached && Date.now() - cached.fetchedAt < GROUP_MEMBER_CACHE_TTL) {
        return cached.botOpenIds;
      }

      let token = null;
      for (const [, acct] of Object.entries(feishuAccounts)) {
        if (acct.appId && acct.appSecret) {
          try {
            token = await getTenantToken(acct.appId, acct.appSecret, feishuDomain);
            break;
          } catch (_) { /* try next */ }
        }
      }
      if (!token) return null;

      const base = feishuDomain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
      const memberOpenIds = new Set();
      let pageToken = '';
      for (let i = 0; i < 10; i++) {
        const params = new URLSearchParams({ member_id_type: 'open_id', page_size: '100' });
        if (pageToken) params.set('page_token', pageToken);
        const url = `${base}/open-apis/im/v1/chats/${chatId}/members?${params}`;
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        const json = await res.json();
        if (json.code !== 0) {
          debugLog(`[getGroupBotOpenIds] API error for chat=${chatId}: ${json.msg}`);
          return null;
        }
        for (const m of (json.data?.items || [])) {
          if (m.member_type === 'bot' && m.member_id) {
            memberOpenIds.add(m.member_id);
          }
        }
        if (!json.data?.has_more) break;
        pageToken = json.data.page_token || '';
      }

      const knownBotCount = botOpenIdSet.size;
      const foundCount = memberOpenIds.size;

      if (knownBotCount > 1 && foundCount <= 1) {
        debugLog(`[getGroupBotOpenIds] chat=${chatId} returned only ${foundCount} bots but registry has ${knownBotCount} — likely permission issue, skipping cache`);
        log.warn(`[openclaw-feishu-a2a] Group member API returned suspiciously few bots (${foundCount}/${knownBotCount}) for chat=${chatId}`);
        return null;
      }

      groupMemberCache.set(chatId, { botOpenIds: memberOpenIds, fetchedAt: Date.now() });
      debugLog(`[getGroupBotOpenIds] chat=${chatId} has ${memberOpenIds.size} bots: ${[...memberOpenIds].join(', ')}`);
      return memberOpenIds;
    }

    function buildLookups(registry) {
      botRegistry = registry;
      botOpenIdSet.clear();
      botOpenIdToAgentMap.clear();
      accountIdToAgentMap.clear();
      agentIdSet.clear();

      for (const [agentId, bot] of Object.entries(registry)) {
        botOpenIdSet.add(bot.botOpenId);
        botOpenIdToAgentMap.set(bot.botOpenId, { agentId, ...bot });
        if (bot.accountId) {
          accountIdToAgentMap.set(bot.accountId, { agentId, botOpenId: bot.botOpenId, botName: bot.botName });
        }
        agentIdSet.add(agentId);
      }

      const signature = [...agentIdSet].sort().join(',');
      const isFirstOrChanged = _registerCount === 0 || signature !== _lastBotSignature;
      _registerCount++;
      _lastBotSignature = signature;

      if (isFirstOrChanged) {
        debugLog(`buildLookups: ${agentIdSet.size} bots ready — ${[...agentIdSet].join(', ')}`);
        log.info(`[openclaw-feishu-a2a] ${agentIdSet.size} bots active: ${[...agentIdSet].join(', ')}`);
      }
    }

    // Determine botRegistry source
    if (cfg.botRegistry && Object.keys(cfg.botRegistry).length > 0) {
      debugLog(`Using manual botRegistry with ${Object.keys(cfg.botRegistry).length} bots`);
      buildLookups(cfg.botRegistry);
    } else {
      debugLog(`No manual botRegistry, starting auto-discovery...`);
      discoverBots(api.config, log).then(registry => {
        if (Object.keys(registry).length > 0) {
          buildLookups(registry);
        } else {
          log.warn('[openclaw-feishu-a2a] Auto-discovery found 0 bots — plugin will be inactive');
        }
      }).catch(e => {
        debugLog(`Auto-discovery failed: ${e.message}`);
        log.error(`[openclaw-feishu-a2a] Auto-discovery failed: ${e.message}`);
      });
    }

    // ========================================================================
    // Hook 1: before_prompt_build — Role-aware context injection
    // ========================================================================
    api.on('before_prompt_build', async (event, ctx) => {
      debugLog(`[before_prompt_build] agent=${ctx.agentId}, channelId=${ctx.channelId}, sessionKey=${ctx.sessionKey}`);

      if (ctx.channelId !== 'feishu') return;

      const currentAgentId = ctx.agentId;
      const sessionKey = ctx.sessionKey || '';
      const chatId = extractChatId(sessionKey, event.conversationId);

      // --- Capture user message for session context ---
      if (chatId && event.content) {
        const senderOpenId = event.senderId || event.metadata?.senderId;
        const isBotSender = senderOpenId && botOpenIdSet.has(senderOpenId);
        if (!isBotSender) {
          const cleanContent = (event.content || '')
            .replace(/<at[^>]*>[^<]*<\/at>/g, '')
            .trim()
            .substring(0, 500);
          if (cleanContent) {
            lastUserMessage.set(chatId, cleanContent);
          }
        }
      }

      // --- Role detection ---
      let role = 'NEUTRAL';
      let activeSession = null;

      if (chatId) {
        activeSession = sessionStore.getSession(chatId);
        if (activeSession) {
          if (activeSession.host === currentAgentId) {
            role = 'HOST';
          } else {
            const myBot = botRegistry[currentAgentId];
            if (myBot) {
              const hasActiveTask = activeSession.tasks.some(
                t => t.workerOpenId === myBot.botOpenId && t.status === 'dispatched'
              );
              if (hasActiveTask) role = 'WORKER';
            }
          }
        }
      }

      debugLog(`[before_prompt_build] chatId=${chatId}, role=${role}`);

      // --- Role-specific context ---
      let roleContext = '';

      if (role === 'HOST') {
        let progress = `[当前协作进度]\n用户原始需求：${activeSession.userRequest || '（未记录）'}\n`;
        for (const task of activeSession.tasks) {
          if (task.status === 'completed') {
            progress += `  ✅ ${task.workerName} — ${task.brief || '已完成'}\n`;
          } else {
            const mins = Math.round((Date.now() - new Date(task.dispatchedAt).getTime()) / 60000);
            progress += `  ⏳ ${task.workerName} — ${task.brief || '进行中'}（已派发 ${mins} 分钟）\n`;
          }
        }
        const dispatched = activeSession.tasks.filter(t => t.status === 'dispatched');
        if (dispatched.length > 0) {
          progress += `→ 等待 ${dispatched.map(t => t.workerName).join('、')} 回传结果后，再继续派发下一步或汇总。\n`;
        } else if (activeSession.tasks.length > 0 && activeSession.tasks.every(t => t.status === 'completed')) {
          progress += `→ 所有子任务已完成，请汇总结果回复用户。\n`;
        }
        const recentMessages = sessionStore.getRecentMessages(chatId, 20);
        if (recentMessages.length > 0) {
          progress += `\n[群内近期对话记录]\n`;
          for (const msg of recentMessages) {
            const time = new Date(msg.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
            progress += `  ${time} ${msg.agentName}：${msg.summary}\n`;
          }
          progress += `→ 以上是你不在时群里发生的对话，请结合这些信息做判断。\n`;
        }
        roleContext = progress + '\n';

      } else if (role === 'WORKER') {
        const myBot = botRegistry[currentAgentId];
        if (myBot && activeSession) {
          const activeTask = activeSession.tasks.find(
            t => t.workerOpenId === myBot.botOpenId && t.status === 'dispatched'
          );
          const hostBot = botRegistry[activeSession.host];
          if (activeTask && hostBot) {
            roleContext =
              `🚨 你正在执行协作任务，完成后必须 @ 回发起者！\n` +
              `发起者：<at user_id="${hostBot.botOpenId}">${hostBot.botName}</at>\n` +
              `任务摘要：${activeTask.brief || '（见上方消息）'}\n` +
              `→ 回复时请在开头 @ ${hostBot.botName}，汇报你的结果。\n\n`;
          }
        }

      } else if (currentAgentId === 'main') {
        roleContext =
          `[协作调度指引]\n` +
          `收到用户任务后：\n` +
          `1. 如果任务描述不够清晰（缺少目标受众、输出格式、重点方向等关键信息），先问用户 2-3 个关键问题。最多追问 2 轮，不能无休止。\n` +
          `2. 任务明确后，判断协作方式：\n` +
          `   - 涉及行业趋势、数据、事实的内容创作 → 先派调研 Agent，再派创作 Agent（串行）\n` +
          `   - 复杂多人任务 → 先告知用户分工计划，确认后再派发\n` +
          `   - 简单单人任务 → 直接 @ 派发\n` +
          `3. 每次回复最多 @ 1 个 Agent，等对方回传后再 @ 下一个\n\n`;
      }

      // --- Smart routing guidance for workers ---
      if (currentAgentId !== 'main' && role !== 'HOST') {
        const routingRules = {
          strategist: `[智能协作路由]\n` +
            `你可以直接回答的：观点判断、方案对比、优劣分析、建议等不依赖外部数据的决策问题。\n` +
            `你应该先 @ 司南调研的：涉及具体价格、市场行情、地理信息、历史数据、政策法规等需要事实依据的问题。\n` +
            `→ 不确定时宁可先让司南查一下，基于数据的建议才有说服力。\n\n`,
          researcher: `[智能协作路由]\n` +
            `调研完成后，如果结果需要决策分析（方案选择、优劣对比），可以 @ 谋远 协助分析。\n` +
            `如果需要文案或视觉输出，可以 @ 灵犀。\n\n`,
        };
        const routing = routingRules[currentAgentId];
        if (routing) roleContext += routing;
      }

      // --- Bot list injection (filtered by group membership) ---
      let groupBotOpenIds = null;
      if (chatId) {
        try {
          groupBotOpenIds = await getGroupBotOpenIds(chatId);
        } catch (e) {
          debugLog(`[before_prompt_build] Failed to get group members: ${e.message}`);
        }
      }

      const allOtherBots = Object.entries(botRegistry)
        .filter(([agentId]) => agentId !== currentAgentId);

      let inGroupBots = allOtherBots;
      let notInGroupBots = [];

      if (groupBotOpenIds) {
        inGroupBots = allOtherBots.filter(([, bot]) => groupBotOpenIds.has(bot.botOpenId));
        notInGroupBots = allOtherBots.filter(([, bot]) => !groupBotOpenIds.has(bot.botOpenId));
      }

      if (inGroupBots.length === 0 && notInGroupBots.length === 0) {
        if (roleContext) return { appendSystemContext: roleContext };
        return;
      }

      const botList = inGroupBots
        .map(([, bot]) => {
          const desc = bot.description ? ` — ${bot.description}` : '';
          const atTag = `<at user_id="${bot.botOpenId}">${bot.botName}</at>`;
          return `- ${atTag}${desc}`;
        })
        .join('\n');

      let missingBotsNote = '';
      if (notInGroupBots.length > 0) {
        const missingNames = notInGroupBots.map(([, bot]) => bot.botName).join('、');
        missingBotsNote = `\n\n以下机器人未在本群中，如需协作请让管理员将它们拉入群聊：${missingNames}`;
      }

      const hasNativeA2A = chatId && nativeA2AChats.has(chatId);
      let permissionNote = '';
      if (!hasNativeA2A) {
        permissionNote = `\n\n注意：当前群聊尚未检测到飞书原生 bot@bot 投递能力。如果你 @ 其他机器人后对方没有响应，请提醒用户在飞书开发者后台为每个机器人应用开通「接收群聊中机器人@机器人的消息」权限（im:message.group_at_msg.include_bot:readonly）。`;
      }

      const instruction = `[A2A — 群内协作规则]

默认行为：
- 正常情况下不要主动 @ 其他机器人
- 每次回复最多 @ 1 个机器人

重要：区分"提到"和"请求"
- 如果你只是在回复中提到某个机器人，直接用它的名字，不要用 <at> 标签
- 只有当你确实需要对方执行任务、回答问题时，才使用 <at> 标签

触发协作：
- 当用户提到"群内协作"、"分配任务"、"协作完成"等关键字时，可以根据任务需要主动 @ 合适的机器人
- 当用户明确要求你联系某个机器人时，也可以 @

@ 的两种类型：

1. 任务型 @（需要对方完成任务并回传结果）：
   - 直接在回复中用 <at> 标签 @ 对方，说明任务内容
   - 对方完成后应该 @ 回你汇报结果
   - 你收到结果后，整理结果回复用户，不要再 @ 回对方

2. 通知型 @（只是告知信息，不需要对方回复）：
   - 在消息中加上 🔕仅通知 标记
   - 示例：「🔕仅通知 <at ...>xxx</at> 排期已确认」
   - 对方收到后不需要 @ 回你

回复规则：
- 当其他机器人 @ 你并请求你执行任务时，处理完后在回复开头 @ 回发起者汇报结果
- 如果对方只是通知你信息（消息中包含🔕仅通知），不需要 @ 回对方
- 如果对方是把结果回传给你，不要 @ 回对方，直接整理结果回复用户

@ 格式要求（非常重要）：
- 必须使用 <at user_id="ou_xxxx">名字</at> 格式
- 禁止使用 @名字 这种明文写法，明文写法不会触发飞书的 @ 投递

${inGroupBots.length > 0 ? `本群中可用的机器人：\n${botList}` : '本群中暂无其他可协作的机器人。'}${missingBotsNote}${permissionNote}

⛔ 严禁使用内部通信：
- 在群聊中，所有跨 agent 通信必须通过群里 @ 发消息。用户和其他 agent 需要在群里看到你的消息。
- 禁止使用 sessions_spawn、sessions_send、sessions_history 等内部通信工具进行跨 agent 对话。
- 如果有人要求你"把结果发给 xxx"，你必须在群里 @ 对方，而不是用内部通道。`;

      debugLog(`[before_prompt_build] Injecting context for agent=${currentAgentId}, role=${role}, inGroup=${inGroupBots.length}`);

      return { appendSystemContext: roleContext + instruction };
    });

    // ========================================================================
    // Hook 2: message_sending — @name replacement + dispatch tracking + auto @back
    // ========================================================================
    api.on('message_sending', (event, ctx) => {
      const senderInfo = accountIdToAgentMap.get(ctx.accountId);
      const currentAgentId = senderInfo?.agentId;
      const chatId = ctx.conversationId;

      debugLog(`[message_sending] agent=${currentAgentId}, accountId=${ctx.accountId}, chatId=${chatId}, len=${event.content?.length}`);

      if (ctx.channelId !== 'feishu') return;

      let content = event.content;

      // === Phase 1: @name → <at> tag replacement ===
      for (const [, bot] of Object.entries(botRegistry)) {
        if (bot.accountId === ctx.accountId) continue;
        const flexPattern = escapeRegExp(bot.botName).replace(/-/g, '-?');
        const pattern = new RegExp('@' + flexPattern, 'g');
        const newContent = content.replace(
          pattern,
          `<at user_id="${bot.botOpenId}">${bot.botName}</at>`
        );
        if (newContent !== content) {
          debugLog(`[message_sending] Replaced @${bot.botName} with <at> tag`);
          content = newContent;
        }
      }

      if (!currentAgentId || !senderInfo) {
        debugLog(`[message_sending] Unknown accountId=${ctx.accountId}, skipping Phase 2-4`);
        if (content !== event.content) return { content };
        return;
      }

      // === Phase 2: Task dispatch detection ===
      const isNotification = /🔕\s*仅通知/.test(content);

      if (chatId && !isNotification) {
        const atMatches = [...content.matchAll(/<at user_id="(ou_[^"]+)">([^<]+)<\/at>/g)];
        for (const m of atMatches) {
          const targetOpenId = m[1];
          const targetName = m[2];
          const targetInfo = botOpenIdToAgentMap.get(targetOpenId);
          if (!targetInfo) continue;
          if (targetInfo.agentId === currentAgentId) continue;

          const brief = extractBrief(content);
          const userReq = lastUserMessage.get(chatId) || '';

          let session = sessionStore.getSession(chatId);
          if (!session) {
            session = sessionStore.createSession(
              chatId, currentAgentId, senderInfo.botOpenId, senderInfo.botName, userReq
            );
            debugLog(`[message_sending] Created session: chatId=${chatId}, host=${currentAgentId}`);
          }

          sessionStore.addTask(chatId, targetInfo.agentId, targetOpenId, targetName, brief);
          debugLog(`[message_sending] Tracked dispatch: worker=${targetInfo.agentId}, brief=${brief}`);

          if (!/@ ?回我|@回|汇报结果|回传/.test(content)) {
            content += '\n\n完成后请 @ 回我汇报结果。';
            debugLog(`[message_sending] Appended @-back reminder`);
          }

          break;
        }
      }

      // === Phase 3: Worker auto @-back to host ===
      const taskInfo = sessionStore.findActiveTaskForWorker(senderInfo.botOpenId);
      if (taskInfo) {
        const hostBot = botRegistry[taskInfo.session.host];
        if (hostBot && !content.includes(`<at user_id="${hostBot.botOpenId}">`)) {
          const hostAtTag = `<at user_id="${hostBot.botOpenId}">${hostBot.botName}</at>`;
          content = hostAtTag + '\n\n' + content;
          debugLog(`[message_sending] Auto-injected @-back to host ${hostBot.botName}`);
        }

        // === Phase 3b: Task completion detection ===
        const hostOpenId = taskInfo.session.hostOpenId;
        if (content.includes(`<at user_id="${hostOpenId}">`)) {
          sessionStore.completeTask(taskInfo.chatId, senderInfo.botOpenId);
          debugLog(`[message_sending] Marked task completed: worker=${currentAgentId}`);
        }
      }

      // === Phase 4: Log message to session for host visibility ===
      if (chatId) {
        const anyChatSession = sessionStore.getSession(chatId);
        if (anyChatSession) {
          sessionStore.logMessage(chatId, currentAgentId, senderInfo.botName, content);
        }
      }

      // === Phase 4: Text fallback after <at> tags for card visibility ===
      content = content.replace(
        /<at user_id="([^"]+)">([^<]+)<\/at>(?!\s*\([^)]+\))/g,
        (_, userId, name) => `<at user_id="${userId}">${name}</at> (${name})`
      );

      if (content !== event.content) {
        debugLog(`[message_sending] Final (first 300): ${content.substring(0, 300)}`);
        return { content };
      }
    });

    if (_registerCount === 0) {
      debugLog('All hooks registered successfully');
      log.info('[openclaw-feishu-a2a] All hooks registered (v0.2.0)');
    }
  }
};

module.exports = plugin;
module.exports.default = plugin;
