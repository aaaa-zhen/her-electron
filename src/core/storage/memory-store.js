const path = require("path");
const fs = require("fs");
const { JsonFileStore } = require("./json-file");

const EMBEDDING_API_URL = "https://aihubmix.com/v1/embeddings";
const EMBEDDING_API_KEY = "sk-F3SkvZrFjOrsJSgwD6305eA06f38423fB19b7c8bAfF31710";
const EMBEDDING_MODEL = "text-embedding-3-small";

let _embeddingCache = null;
let _embeddingCachePath = null;

function loadEmbeddingCache(dataDir) {
  if (_embeddingCache && _embeddingCachePath) return _embeddingCache;
  _embeddingCachePath = path.join(dataDir, "embeddings.json");
  try {
    if (fs.existsSync(_embeddingCachePath)) {
      _embeddingCache = JSON.parse(fs.readFileSync(_embeddingCachePath, "utf-8"));
    } else {
      _embeddingCache = {};
    }
  } catch {
    _embeddingCache = {};
  }
  return _embeddingCache;
}

function saveEmbeddingCache() {
  if (!_embeddingCachePath || !_embeddingCache) return;
  try {
    fs.writeFileSync(_embeddingCachePath, JSON.stringify(_embeddingCache));
  } catch (err) {
    console.error("[Embedding] Failed to save cache:", err.message);
  }
}

function embeddingKey(text) {
  return normalizeText(text).trim().slice(0, 200);
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

async function fetchEmbeddings(texts) {
  try {
    const res = await fetch(EMBEDDING_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${EMBEDDING_API_KEY}`,
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
    });
    if (!res.ok) {
      console.error("[Embedding] API error:", res.status);
      return null;
    }
    const json = await res.json();
    return json.data.map((item) => item.embedding);
  } catch (err) {
    console.error("[Embedding] Fetch error:", err.message);
    return null;
  }
}

async function getEmbedding(text, cache) {
  const key = embeddingKey(text);
  if (!key) return null;
  if (cache[key]) return cache[key];

  const results = await fetchEmbeddings([text]);
  if (!results || !results[0]) return null;
  cache[key] = results[0];
  saveEmbeddingCache();
  return results[0];
}

async function ensureEmbeddings(memories, cache) {
  const missing = memories.filter((m) => {
    const key = embeddingKey(`${m.key} ${m.value}`);
    return key && !cache[key];
  });
  if (missing.length === 0) return;

  const batchSize = 50;
  for (let i = 0; i < missing.length; i += batchSize) {
    const batch = missing.slice(i, i + batchSize);
    const texts = batch.map((m) => `${m.key} ${m.value}`.slice(0, 500));
    const embeddings = await fetchEmbeddings(texts);
    if (!embeddings) continue;
    for (let j = 0; j < batch.length; j++) {
      if (embeddings[j]) {
        cache[embeddingKey(`${batch[j].key} ${batch[j].value}`)] = embeddings[j];
      }
    }
  }
  saveEmbeddingCache();
}

function autoTag(key, value) {
  const tags = [];
  const text = `${key} ${value}`.toLowerCase();
  if (text.match(/name|用户|叫|姓名/)) tags.push("user_info");
  if (text.match(/task|任务|完成|做了|写了|改了|下载|部署/)) tags.push("task_history");
  if (text.match(/prefer|喜欢|习惯|偏好|设置/)) tags.push("preference");
  if (text.match(/project|项目|代码|github|repo/)) tags.push("project");
  if (tags.length === 0) tags.push("other");
  return tags;
}

function normalizeText(value) {
  return String(value || "").toLowerCase();
}

function slugify(value, limit = 48) {
  const slug = normalizeText(value)
    .replace(/[^\p{L}\p{N}\u4e00-\u9fff]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, limit);
  return slug || "item";
}

function tokenize(text) {
  const normalized = normalizeText(text).replace(/[^\p{L}\p{N}\u4e00-\u9fff\s]+/gu, " ").trim();
  if (!normalized) return [];

  const tokens = new Set();
  for (const part of normalized.split(/\s+/)) {
    if (!part) continue;

    // English-like tokens benefit from word matching; CJK text benefits from short phrase chunks.
    if (/^[a-z0-9_-]+$/i.test(part)) {
      if (part.length >= 2) tokens.add(part);
      continue;
    }

    if (part.length >= 2) tokens.add(part);
    if (/[\u4e00-\u9fff]/.test(part)) {
      for (let size = 2; size <= Math.min(4, part.length); size += 1) {
        for (let index = 0; index <= part.length - size; index += 1) {
          tokens.add(part.slice(index, index + size));
        }
      }
    }
  }

  return [...tokens];
}

function getRecencyScore(memory) {
  const timestamp = new Date(memory.updated || memory.saved || 0).getTime();
  if (!timestamp) return 0;

  const ageDays = (Date.now() - timestamp) / (1000 * 60 * 60 * 24);
  if (ageDays <= 1) return 1.5;
  if (ageDays <= 7) return 1.1;
  if (ageDays <= 30) return 0.6;
  return 0.2;
}

function isSameLocalDay(dateLike, now = new Date()) {
  const value = new Date(dateLike);
  if (Number.isNaN(value.getTime())) return false;
  return value.getFullYear() === now.getFullYear()
    && value.getMonth() === now.getMonth()
    && value.getDate() === now.getDate();
}

function getTimelineTimestamp(memory) {
  const candidates = [
    memory && memory.meta && memory.meta.at,
    memory && memory.updated,
    memory && memory.saved,
  ];
  for (const value of candidates) {
    const time = new Date(value || "").getTime();
    if (!Number.isNaN(time)) return time;
  }
  return 0;
}

function cleanNameCandidate(value) {
  return String(value || "")
    .replace(/^["“”'‘’`]+|["“”'‘’`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isValidNameCandidate(value) {
  const cleaned = cleanNameCandidate(value);
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

function parseNameInfo(memory) {
  if (!memory) return null;

  const key = String(memory.key || "");
  const value = String(memory.value || "");

  const namePatterns = [
    /用户的名字\/称呼是\s*([A-Za-z][A-Za-z0-9_-]{0,23}|[\u4e00-\u9fff]{1,8})/i,
    /用户希望被称呼为\s*([A-Za-z][A-Za-z0-9_-]{0,23}|[\u4e00-\u9fff]{1,8})/i,
    /^([A-Za-z][A-Za-z0-9_-]{1,31}|[\u4e00-\u9fff]{2,8})\s*[，,]\s*喜欢被叫\s*([A-Za-z][A-Za-z0-9_-]{0,23}|[\u4e00-\u9fff]{1,8})/i,
  ];

  let fullName = "";
  let callName = "";

  if (key === "identity:name" || key === "user_name") {
    for (const pattern of namePatterns) {
      const match = value.match(pattern);
      if (!match) continue;
      if (match[2]) {
        fullName = cleanNameCandidate(match[1]);
        callName = cleanNameCandidate(match[2]);
      } else {
        fullName = cleanNameCandidate(match[1]);
      }
      break;
    }
  }

  if (key === "identity:call_name") {
    const match = value.match(/用户更喜欢被称呼为\s*([A-Za-z][A-Za-z0-9_-]{0,23}|[\u4e00-\u9fff]{1,8})/i);
    if (match) callName = cleanNameCandidate(match[1]);
  }

  if (!fullName && !callName && key === "user_name") {
    const legacyMatch = value.match(/^(.*?)(?:\s*[，,]\s*喜欢被叫\s*(.+))?$/);
    if (legacyMatch) {
      const maybeFullName = cleanNameCandidate(legacyMatch[1]);
      const maybeCallName = cleanNameCandidate(legacyMatch[2] || "");
      if (isValidNameCandidate(maybeFullName)) fullName = maybeFullName;
      if (isValidNameCandidate(maybeCallName)) callName = maybeCallName;
    }
  }

  if (fullName && !isValidNameCandidate(fullName)) fullName = "";
  if (callName && !isValidNameCandidate(callName)) callName = "";
  if (!fullName && !callName) return null;

  return {
    fullName,
    callName,
    primaryName: callName || fullName,
  };
}

function isNameRecallQuery(query) {
  return /(我叫什么|我叫啥|我叫什麽|我的名字|我名字|你怎么叫我|叫我什么|怎么称呼我|我真名|名字还记得|name)/.test(query);
}

function isGarbageIdentityMemory(memory) {
  if (!memory) return false;
  if (memory.key === "identity:name" && !parseNameInfo(memory)) return true;
  if (String(memory.key || "").startsWith("identity:about:")) {
    return /身份\/角色：(?:什么|啥|谁|哪里|怎么)/.test(String(memory.value || ""));
  }
  return false;
}

function inferMemoryType(memory) {
  if (memory && memory.type) return memory.type;

  const text = normalizeText(`${memory.key || ""} ${memory.value || ""}`);
  const tags = (memory.tags || []).map((tag) => normalizeText(tag));

  if (tags.includes("identity") || memory.key === "user_name" || (memory.key === "identity:name" && parseNameInfo(memory))) {
    return "identity";
  }

  if (/(名字|姓名|称呼|我叫|my name|call me|喜欢被叫)/.test(text) || /\bcalled\b/.test(text)) {
    return "identity";
  }

  if (tags.includes("preference") || /(喜欢|习惯|偏好|风格|不喜欢|讨厌|prefer|preference|habit)/.test(text)) {
    return "preference";
  }

  if (/(最近|这周|状态|情绪|压力|焦虑|开心|在意|困扰|feeling|mood|stress|anxious)/.test(text)) {
    return "relationship";
  }

  if (/(待办|todo|计划|目标|继续|下次|准备|想做|想要|卡住|问题|下一步|next step|pending|blocked|open loop)/.test(text)) {
    return "open_loop";
  }

  if (tags.includes("artifact") || /(文件|图片|视频|音频|下载物|artifact|shared directory)/.test(text)) {
    return "artifact";
  }

  if (tags.includes("timeline_event") || /(timeline|时间线|today timeline|今天发生|今天日程|课程|上课|会议|calendar event|日历事件)/.test(text)) {
    return "timeline_event";
  }

  if (tags.includes("episode") || /(回合记录|对话片段|图片上下文|episode)/.test(text)) {
    return "episode";
  }

  if (tags.includes("task_history")) return "task_history";
  if (tags.includes("project")) return "project";
  return "other";
}

function getTypePriority(memory) {
  const type = inferMemoryType(memory);
  if (type === "identity") return 8;
  if (type === "preference") return 7;
  if (type === "project") return 6;
  if (type === "timeline_event") return 5.5;
  if (type === "open_loop") return 5;
  if (type === "artifact") return 4.5;
  if (type === "relationship") return 4;
  if (type === "task_history") return 3;
  if (type === "episode") return 1;
  return 2;
}

class MemoryStore extends JsonFileStore {
  constructor(dataDir) {
    super(path.join(dataDir, "memory.json"), () => []);
    this._typedCache = null;
    this._typedCacheSource = null;
    this._dataDir = dataDir;
    this._embeddingCache = loadEmbeddingCache(dataDir);
    // Background index existing memories
    setImmediate(() => this._backgroundIndex());
  }

  async _backgroundIndex() {
    try {
      const memories = this.list();
      if (memories.length > 0) {
        await ensureEmbeddings(memories, this._embeddingCache);
        console.log(`[Embedding] Indexed ${memories.length} memories`);
      }
    } catch (err) {
      console.error("[Embedding] Background index error:", err.message);
    }
  }

  list() {
    return this.read();
  }

  _invalidateTypedCache() {
    this._typedCache = null;
    this._typedCacheSource = null;
  }

  getRelevant(limit = 20) {
    return this.listTyped()
      .sort((a, b) => {
        const priorityDiff = getTypePriority(b) - getTypePriority(a);
        if (priorityDiff !== 0) return priorityDiff;
        return new Date(b.updated || b.saved || 0) - new Date(a.updated || a.saved || 0);
      })
      .slice(0, limit);
  }

  listTyped() {
    const raw = this.list();
    if (this._typedCache && this._typedCacheSource === raw) return this._typedCache;
    this._typedCacheSource = raw;
    this._typedCache = raw.map((memory) => ({
      ...memory,
      type: inferMemoryType(memory),
    }));
    return this._typedCache;
  }

  getPreferredNameInfo() {
    const candidates = this.list()
      .map((memory) => ({ memory, info: parseNameInfo(memory) }))
      .filter((entry) => entry.info && entry.info.primaryName);

    if (candidates.length === 0) return null;

    candidates.sort((left, right) => {
      const leftScore = (left.info.callName ? 2 : 0) + (left.info.fullName ? 1 : 0);
      const rightScore = (right.info.callName ? 2 : 0) + (right.info.fullName ? 1 : 0);
      if (rightScore !== leftScore) return rightScore - leftScore;
      return new Date(right.memory.updated || right.memory.saved || 0) - new Date(left.memory.updated || left.memory.saved || 0);
    });

    const merged = { fullName: "", callName: "", primaryName: "" };
    for (const entry of candidates) {
      if (!merged.fullName && entry.info.fullName) merged.fullName = entry.info.fullName;
      if (!merged.callName && entry.info.callName) merged.callName = entry.info.callName;
      if (!merged.primaryName && entry.info.primaryName) merged.primaryName = entry.info.primaryName;
      if (merged.fullName && merged.callName) break;
    }

    if (!merged.primaryName) merged.primaryName = merged.callName || merged.fullName;
    return merged.primaryName ? merged : null;
  }

  getNameMemories(limit = 3) {
    return this.listTyped()
      .map((memory) => ({ memory, info: parseNameInfo(memory) }))
      .filter((entry) => entry.info && entry.info.primaryName)
      .sort((left, right) => {
        const leftScore = (left.info.callName ? 2 : 0) + (left.info.fullName ? 1 : 0);
        const rightScore = (right.info.callName ? 2 : 0) + (right.info.fullName ? 1 : 0);
        if (rightScore !== leftScore) return rightScore - leftScore;
        return new Date(right.memory.updated || right.memory.saved || 0) - new Date(left.memory.updated || left.memory.saved || 0);
      })
      .map((entry) => entry.memory)
      .slice(0, limit);
  }

  getContextual(query, limit = 6) {
    const normalizedQuery = normalizeText(query).trim();
    if (!normalizedQuery) return this.getRelevant(limit);

    if (isNameRecallQuery(normalizedQuery)) {
      const nameMemories = this.getNameMemories(limit);
      if (nameMemories.length > 0) return nameMemories;
    }

    if (/(记得|记不记得|remember|memory|之前|以前|上次|偏好)/.test(normalizedQuery)) {
      return this.getRelevant(limit);
    }

    if (/(今天|刚才|刚刚|今天让我|今天叫你|做了什么|让我做了什么|帮我做了什么|完成了什么|今天干了什么|写了什么|下载了什么)/.test(normalizedQuery)) {
      const expandedLimit = Math.max(limit, 12);
      const todayTimeline = this.getTodayTimeline(expandedLimit);
      const recentTasks = this.getTaskHistory(expandedLimit);
      // Merge and dedupe today's timeline + task history
      const seen = new Set();
      const merged = [];
      for (const m of [...todayTimeline, ...recentTasks]) {
        if (seen.has(m.key)) continue;
        seen.add(m.key);
        merged.push(m);
      }
      if (merged.length > 0) {
        return merged
          .sort((a, b) => new Date(b.updated || b.saved || 0) - new Date(a.updated || a.saved || 0))
          .slice(0, expandedLimit);
      }
    }

    // Kick off async semantic search in background; use keyword results synchronously
    this._lastSemanticResults = null;
    this._runSemanticSearch(query, limit);

    return this._keywordSearch(normalizedQuery, limit);
  }

  _keywordSearch(normalizedQuery, limit) {
    const tokens = tokenize(normalizedQuery);
    const scored = this.list().map((memory) => {
      const key = normalizeText(memory.key);
      const value = normalizeText(memory.value);
      const tags = (memory.tags || []).map((tag) => normalizeText(tag));
      const type = inferMemoryType(memory);

      let score = 0;
      if (key === normalizedQuery) score += 12;
      if (value === normalizedQuery) score += 8;
      if (key.includes(normalizedQuery)) score += 8;
      if (value.includes(normalizedQuery)) score += 5;
      if (tags.some((tag) => tag.includes(normalizedQuery))) score += 4;

      for (const token of tokens) {
        if (key.includes(token)) score += 3.5;
        if (value.includes(token)) score += 2.2;
        if (tags.some((tag) => tag.includes(token))) score += 2.5;
        if (type.includes(token)) score += 1.5;
      }

      score += getRecencyScore(memory);
      return { memory, score };
    }).filter((entry) => entry.score >= 3);

    if (scored.length === 0) return [];

    return scored
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return new Date(right.memory.updated || right.memory.saved || 0) - new Date(left.memory.updated || left.memory.saved || 0);
      })
      .slice(0, limit)
      .map((entry) => entry.memory);
  }

  async _runSemanticSearch(query, limit) {
    try {
      const queryEmb = await getEmbedding(query, this._embeddingCache);
      if (!queryEmb) return;

      const memories = this.list();
      const scored = memories.map((memory) => {
        const key = embeddingKey(`${memory.key} ${memory.value}`);
        const memEmb = this._embeddingCache[key];
        if (!memEmb) return { memory, score: 0 };
        const similarity = cosineSimilarity(queryEmb, memEmb);
        const recency = getRecencyScore(memory);
        return { memory, score: similarity * 10 + recency };
      }).filter((entry) => entry.score >= 3);

      this._lastSemanticResults = scored
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((entry) => entry.memory);
    } catch (err) {
      console.error("[Embedding] Semantic search error:", err.message);
    }
  }

  async getContextualSemantic(query, limit = 6) {
    const normalizedQuery = normalizeText(query).trim();
    if (!normalizedQuery) return this.getRelevant(limit);

    if (isNameRecallQuery(normalizedQuery)) {
      const nameMemories = this.getNameMemories(limit);
      if (nameMemories.length > 0) return nameMemories;
    }

    if (/(记得|记不记得|remember|memory|之前|以前|上次|偏好)/.test(normalizedQuery)) {
      return this.getRelevant(limit);
    }

    if (/(今天|刚才|刚刚|今天让我|今天叫你|做了什么|让我做了什么|帮我做了什么|完成了什么|今天干了什么|写了什么|下载了什么)/.test(normalizedQuery)) {
      const expandedLimit = Math.max(limit, 12);
      const todayTimeline = this.getTodayTimeline(expandedLimit);
      const recentTasks = this.getTaskHistory(expandedLimit);
      const seen = new Set();
      const merged = [];
      for (const m of [...todayTimeline, ...recentTasks]) {
        if (seen.has(m.key)) continue;
        seen.add(m.key);
        merged.push(m);
      }
      if (merged.length > 0) {
        return merged
          .sort((a, b) => new Date(b.updated || b.saved || 0) - new Date(a.updated || a.saved || 0))
          .slice(0, expandedLimit);
      }
    }

    // Hybrid: keyword + semantic
    const keywordResults = this._keywordSearch(normalizedQuery, limit);

    let queryEmb;
    try {
      queryEmb = await getEmbedding(query, this._embeddingCache);
    } catch { queryEmb = null; }

    if (!queryEmb) return keywordResults;

    const memories = this.list();
    const semanticScored = memories.map((memory) => {
      const key = embeddingKey(`${memory.key} ${memory.value}`);
      const memEmb = this._embeddingCache[key];
      if (!memEmb) return { memory, similarity: 0 };
      return { memory, similarity: cosineSimilarity(queryEmb, memEmb) };
    });

    // Merge: keyword score (normalized) + semantic similarity + recency
    const keywordKeys = new Set(keywordResults.map((m) => m.key));
    const allMemoryMap = new Map();

    for (const entry of semanticScored) {
      const m = entry.memory;
      const kwBonus = keywordKeys.has(m.key) ? 5 : 0;
      const semScore = entry.similarity * 10;
      const recency = getRecencyScore(m);
      const total = kwBonus + semScore + recency;
      if (total >= 3) allMemoryMap.set(m.key, { memory: m, score: total });
    }

    // Also include keyword results that may have no embedding
    for (const m of keywordResults) {
      if (!allMemoryMap.has(m.key)) {
        allMemoryMap.set(m.key, { memory: m, score: 5 + getRecencyScore(m) });
      }
    }

    return [...allMemoryMap.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => entry.memory);
  }

  getIdentitySnapshot(limit = 3) {
    const nameMemories = this.getNameMemories(limit);
    const selectedKeys = new Set(nameMemories.map((memory) => memory.key));
    const others = this.listTyped()
      .filter((memory) => {
        if (selectedKeys.has(memory.key)) return false;
        if (isGarbageIdentityMemory(memory)) return false;
        return memory.type === "identity" || memory.type === "preference";
      })
      .sort((a, b) => new Date(b.updated || b.saved || 0) - new Date(a.updated || a.saved || 0));
    return [...nameMemories, ...others].slice(0, limit);
  }

  getRelationshipNotes(limit = 3) {
    return this.listTyped()
      .filter((memory) => memory.type === "relationship" || memory.type === "project")
      .sort((a, b) => new Date(b.updated || b.saved || 0) - new Date(a.updated || a.saved || 0))
      .slice(0, limit);
  }

  getOpenLoops(limit = 3) {
    return this.listTyped()
      .filter((memory) => memory.type === "open_loop" || memory.type === "project")
      .sort((a, b) => new Date(b.updated || b.saved || 0) - new Date(a.updated || a.saved || 0))
      .slice(0, limit);
  }

  getTaskHistory(limit = 6) {
    return this.listTyped()
      .filter((memory) => memory.type === "task_history")
      .sort((a, b) => new Date(b.updated || b.saved || 0) - new Date(a.updated || a.saved || 0))
      .slice(0, limit);
  }

  getTodayTimeline(limit = 6, now = new Date()) {
    return this.listTyped()
      .filter((memory) => {
        if (memory.type !== "timeline_event" && memory.type !== "task_history") return false;
        return isSameLocalDay(memory.meta && memory.meta.at ? memory.meta.at : (memory.updated || memory.saved), now);
      })
      .sort((a, b) => getTimelineTimestamp(a) - getTimelineTimestamp(b))
      .slice(0, limit);
  }

  getArtifacts(limit = 6) {
    return this.listTyped()
      .filter((memory) => memory.type === "artifact")
      .sort((a, b) => new Date(b.updated || b.saved || 0) - new Date(a.updated || a.saved || 0))
      .slice(0, limit);
  }

  search(query) {
    const memories = this.list();
    if (!query) return memories;
    const lower = query.toLowerCase();
    return memories.filter((memory) =>
      memory.key.toLowerCase().includes(lower) ||
      memory.value.toLowerCase().includes(lower) ||
      (memory.tags && memory.tags.some((tag) => tag.toLowerCase().includes(lower)))
    );
  }

  buildMemoryRecord(key, value, options = {}) {
    const tags = Array.isArray(options.tags) && options.tags.length > 0
      ? [...new Set(options.tags)]
      : autoTag(key, value);
    return {
      key,
      value,
      tags,
      type: options.type,
      meta: options.meta,
    };
  }

  saveEntry(key, value, options = {}) {
    const memories = this.list();
    const existingIndex = memories.findIndex((memory) => memory.key === key);
    const nextMemory = this.buildMemoryRecord(key, value, options);
    if (existingIndex >= 0) {
      memories[existingIndex] = {
        ...memories[existingIndex],
        ...nextMemory,
        updated: new Date().toISOString(),
      };
    } else {
      memories.push({ ...nextMemory, saved: new Date().toISOString() });
    }
    this._invalidateTypedCache();
    this.write(memories);
    // Async embed new memory
    const text = `${key} ${value}`;
    getEmbedding(text, this._embeddingCache).catch(() => {});
  }

  saveEntries(entries = []) {
    if (!Array.isArray(entries) || entries.length === 0) return;
    const memories = this.list();
    for (const entry of entries) {
      if (!entry || !entry.key || !entry.value) continue;
      const existingIndex = memories.findIndex((memory) => memory.key === entry.key);
      const nextMemory = this.buildMemoryRecord(entry.key, entry.value, entry);
      if (existingIndex >= 0) {
        memories[existingIndex] = {
          ...memories[existingIndex],
          ...nextMemory,
          updated: new Date().toISOString(),
        };
      } else {
        memories.push({ ...nextMemory, saved: new Date().toISOString() });
      }
    }
    this._invalidateTypedCache();
    this.write(memories);
    // Async embed new entries
    const toEmbed = entries.filter((e) => e && e.key && e.value).map((e) => e);
    if (toEmbed.length > 0) {
      ensureEmbeddings(toEmbed, this._embeddingCache).catch(() => {});
    }
  }

  hasSimilarEntry({ key, value, type, withinDays = 30 }) {
    const normalizedKey = normalizeText(key);
    const normalizedValue = normalizeText(value);
    const cutoff = Date.now() - withinDays * 24 * 60 * 60 * 1000;

    return this.list().some((memory) => {
      const timestamp = new Date(memory.updated || memory.saved || 0).getTime();
      if (timestamp && timestamp < cutoff) return false;
      if (type && inferMemoryType(memory) !== type) return false;
      return normalizeText(memory.key) === normalizedKey && normalizeText(memory.value) === normalizedValue;
    });
  }

  deleteEntry(key) {
    const next = this.list().filter((memory) => memory.key !== key);
    this._invalidateTypedCache();
    this.write(next);
  }

  saveTimelineEvent({ key = "", title = "", at = "", detail = "", source = "system", status = "today", meta = {} } = {}) {
    const label = String(title || "").trim();
    if (!label) return;
    const when = at || new Date().toISOString();
    const stableKey = key || `timeline:${source}:${slugify(label, 28)}:${slugify(when, 18)}`;
    const parts = [label];
    if (when) parts.push(`time: ${when}`);
    if (status) parts.push(`status: ${status}`);
    if (detail) parts.push(detail);
    this.saveEntry(stableKey, parts.join(" | "), {
      type: "timeline_event",
      tags: ["timeline_event", source, status],
      meta: {
        at: when,
        source,
        status,
        title: label,
        ...meta,
      },
    });
  }
}

module.exports = { MemoryStore };
