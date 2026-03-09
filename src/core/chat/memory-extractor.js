function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function stripWrappingQuotes(value) {
  return normalizeText(value).replace(/^["“”'‘’`]+|["“”'‘’`]+$/g, "").trim();
}

function isValidNameCandidate(candidate) {
  const cleaned = stripWrappingQuotes(candidate);
  if (!cleaned) return false;
  if (cleaned.length > 24) return false;
  if (/\s{2,}/.test(cleaned)) return false;
  if (/[，。！？!?,:：]/.test(cleaned)) return false;
  if (/(什么|啥|谁|哪里|哪位|怎么|为什么|记得|还记得|吗|呢|呀|啊|吧|嘛|同学|用户|名字|称呼|真名)/.test(cleaned)) {
    return false;
  }
  return /^[A-Za-z][A-Za-z0-9_-]{0,23}$/.test(cleaned)
    || /^[\u4e00-\u9fff]{1,8}$/.test(cleaned);
}

function extractExplicitNameCandidate(text) {
  const normalized = normalizeText(text);
  if (!normalized) return "";

  const patterns = [
    /(?:我的名字是|我名字是|我叫|my name is|call me)\s*["“”'‘’`]?([A-Za-z][A-Za-z0-9_-]{0,23}|[\u4e00-\u9fff]{1,8})["“”'‘’`]?/i,
    /(?:你可以叫我|可以叫我|喜欢被叫|称呼我|叫我)\s*["“”'‘’`]?([A-Za-z][A-Za-z0-9_-]{0,23}|[\u4e00-\u9fff]{1,8})["“”'‘’`]?/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    const candidate = match ? stripWrappingQuotes(match[1]) : "";
    if (isValidNameCandidate(candidate)) return candidate;
  }

  return "";
}

function isAssistantAskingForName(text) {
  return /(你叫什么|叫什么名字|我该怎么叫你|我该如何称呼你|怎么称呼你|叫你什么|你叫啥|告诉我一次|what should i call you|what'?s your name)/i.test(normalizeText(text));
}

function isValidRoleCandidate(candidate) {
  const cleaned = normalizeText(candidate);
  if (!cleaned) return false;
  if (cleaned.length < 2 || cleaned.length > 30) return false;
  if (/(什么|啥|谁|哪里|怎么|为什么|记得|吗|呢|呀|啊|吧)/.test(cleaned)) return false;
  return true;
}

function clipText(text, limit = 300) {
  const compact = normalizeText(text);
  if (!compact) return "";
  return compact.length > limit ? `${compact.slice(0, limit)}...` : compact;
}

function slugify(text, limit = 36) {
  const slug = normalizeText(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\u4e00-\u9fff]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, limit);
  return slug || "item";
}

function splitSentences(text) {
  return normalizeText(text)
    .split(/(?<=[。！？!?；;.\n])\s*/)
    .map((sentence) => normalizeText(sentence))
    .filter((sentence) => sentence && sentence.length >= 4);
}

function buildEntry({ key, value, type, tags, withinDays = 90 }) {
  return {
    key,
    value: clipText(value, 500),
    type,
    tags,
    withinDays,
  };
}

function extractIdentityMemories(text, assistantText = "") {
  const entries = [];
  const normalized = normalizeText(text);
  if (!normalized) return entries;

  const explicitName = extractExplicitNameCandidate(normalized);
  if (explicitName) {
    entries.push(buildEntry({
      key: "identity:name",
      value: `用户的名字/称呼是 ${explicitName}`,
      type: "identity",
      tags: ["user_info", "identity"],
      withinDays: 3650,
    }));
  }

  const callNameMatch = normalized.match(/(?:喜欢被叫|你可以叫我|可以叫我|叫我)\s*["“”'‘’`]?([A-Za-z][A-Za-z0-9_-]{0,23}|[\u4e00-\u9fff]{1,8})["“”'‘’`]?/i);
  const preferredCallName = callNameMatch ? stripWrappingQuotes(callNameMatch[1]) : "";
  if (isValidNameCandidate(preferredCallName) && preferredCallName !== explicitName) {
    entries.push(buildEntry({
      key: "identity:call_name",
      value: `用户更喜欢被称呼为 ${preferredCallName}`,
      type: "identity",
      tags: ["user_info", "identity"],
      withinDays: 3650,
    }));
  }

  if (!explicitName && !preferredCallName && isAssistantAskingForName(assistantText)) {
    const shortReply = stripWrappingQuotes(normalized.replace(/[。！？!?，,]/g, ""));
    if (shortReply.length >= 1 && shortReply.length <= 12 && isValidNameCandidate(shortReply)) {
      entries.push(buildEntry({
        key: "identity:name",
        value: `用户的名字/称呼是 ${shortReply}`,
        type: "identity",
        tags: ["user_info", "identity"],
        withinDays: 3650,
      }));
    }
  }

  const roleMatch = normalized.match(/(?:我是|我在做|我是做)\s*([^，。！？!?,]{2,30})/);
  if (roleMatch && !/不是|如果|要是|感觉/.test(roleMatch[1]) && isValidRoleCandidate(roleMatch[1])) {
    entries.push(buildEntry({
      key: `identity:about:${slugify(roleMatch[1], 20)}`,
      value: `用户提到自己的身份/角色：${roleMatch[1]}`,
      type: "identity",
      tags: ["user_info", "identity"],
      withinDays: 365,
    }));
  }

  return entries;
}

function extractPreferenceMemories(text) {
  const entries = [];
  for (const sentence of splitSentences(text)) {
    if (/(用中文|中文回复|中文说)/.test(sentence)) {
      entries.push(buildEntry({
        key: "preference:language",
        value: "默认用中文回复用户",
        type: "preference",
        tags: ["preference"],
        withinDays: 3650,
      }));
    }

    if (/(简洁|简短|直接一点|别太长|少废话|不要太正式|口语一点)/.test(sentence)) {
      entries.push(buildEntry({
        key: "preference:style",
        value: `用户偏好的回复风格：${clipText(sentence, 80)}`,
        type: "preference",
        tags: ["preference"],
        withinDays: 3650,
      }));
    }

    const likeMatch = sentence.match(/(?:我喜欢|我更喜欢|prefer)\s*([^，。！？!?,]{2,40})/i);
    if (likeMatch) {
      entries.push(buildEntry({
        key: `preference:like:${slugify(likeMatch[1], 18)}`,
        value: `用户喜欢：${likeMatch[1]}`,
        type: "preference",
        tags: ["preference"],
      }));
    }

    const dislikeMatch = sentence.match(/(?:我不喜欢|我讨厌|别用|不要)\s*([^，。！？!?,]{2,40})/i);
    if (dislikeMatch) {
      entries.push(buildEntry({
        key: `preference:avoid:${slugify(dislikeMatch[1], 18)}`,
        value: `用户不喜欢/希望避免：${dislikeMatch[1]}`,
        type: "preference",
        tags: ["preference"],
      }));
    }
  }
  return entries;
}

function extractProjectMemories(text) {
  const entries = [];
  for (const sentence of splitSentences(text)) {
    if (!/(项目|repo|仓库|代码库|应用|app|网站|产品|electron|前端|后端|脚本)/i.test(sentence)) continue;
    const labelMatch = sentence.match(/([^，。！？!?,]{2,36}(?:项目|repo|仓库|代码库|应用|app|网站|产品))/i);
    const label = labelMatch ? labelMatch[1] : sentence;
    entries.push(buildEntry({
      key: `project:${slugify(label, 22)}`,
      value: sentence,
      type: "project",
      tags: ["project"],
    }));
  }
  return entries.slice(0, 3);
}

function extractRelationshipMemories(text) {
  const entries = [];
  for (const sentence of splitSentences(text)) {
    if (!/(难受|难过|烦|焦虑|压力|开心|累|崩溃|纠结|在意|担心|怕|不爽|失望|孤独|状态)/.test(sentence)) continue;
    entries.push(buildEntry({
      key: `relationship:${slugify(sentence, 20)}`,
      value: sentence,
      type: "relationship",
      tags: ["relationship"],
      withinDays: 45,
    }));
  }
  return entries.slice(0, 2);
}

function extractOpenLoopMemories(text) {
  const entries = [];
  for (const sentence of splitSentences(text)) {
    if (!/(帮我|我要|需要|记得|提醒|定时|下次|之后|待办|todo|继续|推进|修|改|做|完成)/.test(sentence)) continue;
    if (sentence.length > 120) continue;
    entries.push(buildEntry({
      key: `open-loop:${slugify(sentence, 24)}`,
      value: sentence,
      type: "open_loop",
      tags: ["open_loop"],
      withinDays: 120,
    }));
  }
  return entries.slice(0, 3);
}

function extractToolActionMemories(toolActions) {
  if (!Array.isArray(toolActions) || toolActions.length === 0) return [];
  const entries = [];

  for (const action of toolActions) {
    const normalized = normalizeText(action);
    if (!normalized) continue;

    // File creation/editing — important to remember
    if (/(写入文件|修改文件|write_file|edit_file)/i.test(normalized)) {
      const pathMatch = normalized.match(/[:：]\s*(.+)/);
      const filePath = pathMatch ? pathMatch[1].trim() : "";
      if (filePath) {
        entries.push(buildEntry({
          key: `task:file:${slugify(filePath, 28)}`,
          value: `Her 操作了文件：${filePath}`,
          type: "task_history",
          tags: ["task_history", "file_operation"],
          withinDays: 120,
        }));
      }
    }

    // Downloads
    if (/(下载媒体|download_media)/i.test(normalized)) {
      entries.push(buildEntry({
        key: `task:download:${slugify(normalized, 28)}`,
        value: `Her 下载了：${normalized.replace(/^[^:：]+[:：]\s*/, "")}`,
        type: "task_history",
        tags: ["task_history", "download"],
        withinDays: 120,
      }));
    }

    // Web search / read
    if (/(搜索网页|搜索新闻|读取网页|search_web|search_news|read_url)/i.test(normalized)) {
      entries.push(buildEntry({
        key: `task:search:${slugify(normalized, 28)}`,
        value: `Her 搜索/读取了：${normalized.replace(/^[^:：]+[:：]\s*/, "")}`,
        type: "task_history",
        tags: ["task_history", "search"],
        withinDays: 60,
      }));
    }
  }

  return entries.slice(0, 6);
}

function buildEpisodeMemory({ userText, assistantText, toolActions, imagesCount = 0, timestamp }) {
  const parts = [];
  if (imagesCount > 0) parts.push(`用户发了 ${imagesCount} 张图片`);
  if (userText) parts.push(`用户：${clipText(userText, 400)}`);
  if (toolActions && toolActions.length > 0) {
    parts.push(`操作：${toolActions.slice(0, 8).join("、")}`);
  }
  if (assistantText) parts.push(`Her：${clipText(assistantText, 500)}`);
  if (parts.length === 0) return null;

  return buildEntry({
    key: `episode:${timestamp}`,
    value: parts.join("； "),
    type: "episode",
    tags: ["episode"],
    withinDays: 3650,
  });
}

function dedupeEntries(entries) {
  const unique = [];
  const seen = new Set();
  for (const entry of entries) {
    if (!entry || !entry.key || !entry.value) continue;
    const fingerprint = `${entry.key}::${entry.value}`;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    unique.push(entry);
  }
  return unique;
}

async function extractAIMemories({ userText, assistantText, createAnthropicClient }) {
  if (!createAnthropicClient || (!userText && !assistantText)) return [];
  const combined = `用户说：${clipText(userText, 800)}\nHer回复：${clipText(assistantText, 800)}`;
  if (combined.length < 20) return [];

  try {
    const anthropic = createAnthropicClient();
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [{ role: "user", content: `分析这段对话，提取需要长期记住的信息。只提取有价值的事实，忽略闲聊。

${combined}

以 JSON 数组返回，每条记忆格式：{"key": "简短标识", "value": "要记住的内容", "type": "identity|preference|project|relationship|other"}

规则：
- 用户提到的人名、地点、习惯、工作内容、正在做的事、情感状态、偏好、计划都值得记
- 用户的隐含信息也要提取（比如深夜发消息说明可能是夜猫子）
- 不要记录"用户说了hi"这种无意义内容
- 每条 value 要完整有上下文，未来单独看也能理解
- 最多 5 条，没有值得记的就返回空数组 []
- 只返回 JSON，不要其他文字` }],
    });

    const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const items = JSON.parse(match[0]);
    return items.filter((item) => item.key && item.value).map((item) => buildEntry({
      key: `ai:${slugify(item.key, 30)}`,
      value: item.value,
      type: item.type || "other",
      tags: ["ai_extracted"],
      withinDays: 365,
    }));
  } catch (err) {
    console.error("[MemoryAI] extraction error:", err.message);
    return [];
  }
}

function extractTurnMemories({ userText, assistantText, toolActions, imagesCount = 0, timestamp = new Date().toISOString() }) {
  const normalizedUserText = normalizeText(userText);
  const normalizedAssistantText = normalizeText(assistantText);

  const entries = [
    ...extractIdentityMemories(normalizedUserText, normalizedAssistantText),
    ...extractPreferenceMemories(normalizedUserText),
    ...extractProjectMemories(normalizedUserText),
    ...extractRelationshipMemories(normalizedUserText),
    ...extractOpenLoopMemories(normalizedUserText),
    ...extractToolActionMemories(toolActions),
  ];

  const episode = buildEpisodeMemory({
    userText: normalizedUserText,
    assistantText: normalizedAssistantText,
    toolActions,
    imagesCount,
    timestamp,
  });
  if (episode) entries.push(episode);

  return dedupeEntries(entries);
}

module.exports = {
  extractTurnMemories,
  extractAIMemories,
};
