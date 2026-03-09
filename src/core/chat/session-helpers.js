const { clipText } = require("./text-utils");

function detectMode(text) {
  const lower = String(text || "").toLowerCase();
  if (!lower) return "general";

  if (/(代码|项目|组件|函数|bug|报错|异常|重构|优化|构建|调试|脚本|仓库|repo|commit|diff|debug|stack|trace|typescript|javascript|node|react|electron|css|html)/.test(lower)) {
    return "builder";
  }

  if (/(终端|命令|文件|目录|下载|转换|网页|搜索|打开|安装|运行|执行|提醒|定时|cron|shell|bash|terminal|folder|upload)/.test(lower)) {
    return "operator";
  }

  if (/(难过|开心|焦虑|烦|孤独|喜欢|想聊|陪我|觉得|情绪|关系|失眠|love|feel|sad|happy|anxious|lonely)/.test(lower)) {
    return "companion";
  }

  return "general";
}

function detectTransientState(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return null;

  if (/(我要睡了|我去睡了|睡觉了|先睡了|晚安|先休息了|我先睡|准备睡了)/.test(normalized)) {
    return {
      kind: "sleep",
      summary: `用户刚刚说自己要去睡觉/休息了：${clipText(normalized, 72)}`,
      replyHint: '如果用户又继续发消息，先轻轻接一句"还没睡呀？"、"你不是刚说要睡了吗，怎么又回来啦"之类，再继续回答。',
    };
  }

  if (/(我先走了|先走了|先下了|先下线|先撤了|回头聊|晚点聊|等会再聊|稍后再聊|我先忙了)/.test(normalized)) {
    return {
      kind: "away",
      summary: `用户刚刚说自己要先离开/晚点再聊：${clipText(normalized, 72)}`,
      replyHint: '如果用户很快又回来，先轻轻承接一句"不是说先走吗，怎么又回来了"或"你又冒出来了"，不要太重。',
    };
  }

  return null;
}

function findRecentTransientStateCue(conversationHistory = []) {
  const { toPlainText } = require("./text-utils");
  const recentUsers = conversationHistory
    .filter((message) => message.role === "user")
    .slice(-3)
    .map((message) => {
      const text = typeof message.content === "string" ? message.content : toPlainText(message.content);
      return detectTransientState(text);
    })
    .filter(Boolean);

  if (recentUsers.length === 0) return "";
  const latest = recentUsers[recentUsers.length - 1];
  return `${latest.summary} ${latest.replyHint}`;
}

function normalizeBrowserContext(context) {
  if (!context || typeof context !== "object") return null;
  const normalized = {
    title: clipText(context.title || "", 180),
    url: clipText(context.url || "", 400),
    description: clipText(context.description || "", 220),
    snippet: clipText(context.snippet || "", 320),
    domainLabel: clipText(context.domainLabel || "", 40),
    kind: clipText(context.kind || "", 40),
    appName: clipText(context.appName || "", 40),
  };
  return normalized.url ? normalized : null;
}

function normalizeRelationshipProfile(profile = {}) {
  const cleaned = {
    tone: clipText(profile.tone || "", 40),
    relationshipMode: clipText(profile.relationshipMode || "", 40),
    proactivity: clipText(profile.proactivity || "", 40),
    currentFocus: clipText(profile.currentFocus || "", 140),
  };

  if (!cleaned.currentFocus) cleaned.currentFocus = "最近的重点会慢慢告诉你";
  return cleaned;
}

function buildRelationshipMemoryEntries(profile) {
  return [
    {
      key: "关系设定:表达方式",
      value: `用户希望我用"${profile.tone}"的方式和 ta 说话`,
      type: "preference",
      tags: ["relationship_setup", "preference", "tone"],
    },
    {
      key: "关系设定:互动角色",
      value: `用户更希望我像"${profile.relationshipMode}"那样陪着 ta`,
      type: "preference",
      tags: ["relationship_setup", "preference", "relationship_mode"],
    },
    {
      key: "关系设定:主动程度",
      value: `用户希望我的主动程度是"${profile.proactivity}"`,
      type: "preference",
      tags: ["relationship_setup", "preference", "proactivity"],
    },
    {
      key: "关系设定:当前主线",
      value: `用户最近最希望我陪着处理的是：${profile.currentFocus}`,
      type: "relationship",
      tags: ["relationship_setup", "relationship", "current_focus"],
    },
  ];
}

function summarizeArtifact(memory) {
  const filename = memory.meta && memory.meta.filename ? memory.meta.filename : clipText(memory.key.replace(/^artifact:/, ""), 28);
  const detail = clipText(memory.value || memory.key, 72);
  return {
    title: filename,
    detail,
    kind: memory.meta && memory.meta.kind ? memory.meta.kind : "file",
    prompt: `把文件 ${filename} 发给我，并告诉我它和最近什么任务有关`,
  };
}

function summarizeTask(memory) {
  return {
    title: clipText(memory.key.replace(/^task:/, "").replace(/^[^:]+:/, ""), 28) || "最近完成",
    detail: clipText(memory.value || memory.key, 80),
    prompt: `继续这个已完成事项相关的后续：${memory.value || memory.key}`,
  };
}

module.exports = {
  detectMode,
  detectTransientState,
  findRecentTransientStateCue,
  normalizeBrowserContext,
  normalizeRelationshipProfile,
  buildRelationshipMemoryEntries,
  summarizeArtifact,
  summarizeTask,
};
