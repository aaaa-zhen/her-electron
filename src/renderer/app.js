const msgList = document.getElementById("msgList");
const messagesEl = document.getElementById("messages");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const imgPreviews = document.getElementById("img-previews");
const settingsOverlay = document.getElementById("settingsOverlay");

let pastedImages = [];
let lastClients = [];
let isGenerating = false;
let streamBuf = "";
let streamEl = null;
let streamTimer = null;
let streamGroup = null;
let thinkingEl = null;
let currentCmd = null;
let currentPhaseEl = null;
let currentPresence = null;
let currentRelationshipSetup = null;
let currentPassiveContext = { calendar: [], clipboard: "", frontApp: "", currentPage: null };
let passiveContextRequest = null;
let lastMsgTs = 0;
let userNearBottom = true;
let newMessagesBelow = false;
let inputLayoutFrame = null;
let scrollFrame = null;
const NEAR_BOTTOM_PX = 300;
const RELATIONSHIP_SETUP_OPTIONS = {
  tone: [
    { value: "简洁直接", description: "抓重点，少一点客套" },
    { value: "温柔一点", description: "更柔和，更像被接住" },
    { value: "像朋友聊天", description: "自然、轻松、有人味" },
    { value: "像搭子一起推进", description: "边聊边做，别太端着" },
  ],
  relationshipMode: [
    { value: "长期陪伴者", description: "更像一直在的人" },
    { value: "朋友搭子", description: "熟一点，轻一点" },
    { value: "做事助手", description: "以推进事务为主" },
  ],
  proactivity: [
    { value: "主动提醒我", description: "你可以更主动接续我" },
    { value: "适度主动", description: "有判断地提醒，不要太频繁" },
    { value: "尽量少打扰", description: "主要等我叫你" },
  ],
};

messagesEl.addEventListener("scroll", () => {
  const dist = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
  userNearBottom = dist < NEAR_BOTTOM_PX;
  if (userNearBottom) newMessagesBelow = false;
  updateNewMsgBtn();
});

document.getElementById("newMsgBtn").addEventListener("click", () => {
  messagesEl.scrollTop = messagesEl.scrollHeight;
  newMessagesBelow = false;
  updateNewMsgBtn();
});

function updateNewMsgBtn() {
  document.getElementById("newMsgBtn").style.display = newMessagesBelow ? "" : "none";
}

function finishCmd() {
  if (!currentCmd) return;
  const spinner = currentCmd.querySelector(".cmd-spinner");
  if (spinner) spinner.outerHTML = '<svg class="cmd-icon done"><use href="#i-check"/></svg>';
  currentCmd = null;
}

function esc(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function formatDueDate(raw) {
  if (!raw) return "";
  const d = new Date(raw);
  if (isNaN(d.getTime())) return raw; // fallback: show as-is if not parseable
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((target - today) / 86400000);
  const time = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (diffDays === 0) return `今天 ${time}`;
  if (diffDays === 1) return `明天 ${time}`;
  if (diffDays === -1) return `昨天 ${time}`;
  if (diffDays > 1 && diffDays <= 6) {
    const weekday = ["周日","周一","周二","周三","周四","周五","周六"][d.getDay()];
    return `${weekday} ${time}`;
  }
  return `${d.getMonth()+1}/${d.getDate()} ${time}`;
}

function setGenerating(value) {
  isGenerating = value;
  if (value) {
    sendBtn.disabled = false;
    sendBtn.classList.add("stop");
    sendBtn.classList.remove("active");
    sendBtn.innerHTML = '<svg><use href="#i-stop"/></svg>';
    return;
  }
  sendBtn.classList.remove("stop");
  sendBtn.innerHTML = '<svg><use href="#i-send"/></svg>';
  updateSendBtn();
}

function stopGeneration() {
  if (!isGenerating) return;
  window.herAPI.cancel();
  if (currentCmd) {
    const spinner = currentCmd.querySelector(".cmd-spinner");
    if (spinner) spinner.outerHTML = '<svg class="cmd-icon cancelled" style="color:#f87171"><use href="#i-stop"/></svg>';
    currentCmd = null;
  }
  removePhase();
  endStream();
  finalizeHerGroup();
  setGenerating(false);
}

function flushStream() {
  if (!streamEl || !streamBuf) return;
  streamEl.textContent = streamBuf;
  streamEl.classList.add("streaming-plain");
  streamEl.classList.add("typing-cursor");
  scrollDown();
}

function appendStream(text) {
  streamBuf += text;
  if (!streamTimer) {
    streamTimer = setTimeout(() => {
      streamTimer = null;
      flushStream();
    }, 50);
  }
}

function finalizeStreamMarkup() {
  if (!streamEl || !streamBuf) return;
  streamEl.classList.remove("streaming-plain");
  streamEl.innerHTML = mdCached(streamBuf);
}

function endStream() {
  if (streamTimer) {
    clearTimeout(streamTimer);
    streamTimer = null;
  }
  if (streamEl && streamBuf) finalizeStreamMarkup();
  if (streamEl) streamEl.classList.remove("typing-cursor");
  if (streamGroup) streamGroup.classList.remove("streaming", "fade-in");
  streamEl = null;
  streamBuf = "";
  currentCmd = null;
  setGenerating(false);
  scrollDown();
}

const mdCache = new Map();
const MD_CACHE_MAX = 150;
const MD_CACHE_CHAR_LIMIT = 30000;

function mdCached(raw) {
  if (raw.length > MD_CACHE_CHAR_LIMIT) return md(raw);
  const cached = mdCache.get(raw);
  if (cached) {
    mdCache.delete(raw);
    mdCache.set(raw, cached);
    return cached;
  }
  const html = md(raw);
  mdCache.set(raw, html);
  if (mdCache.size > MD_CACHE_MAX) mdCache.delete(mdCache.keys().next().value);
  return html;
}

function md(raw) {
  if (raw.length > 100000) raw = `${raw.slice(0, 100000)}\n\n... (内容过长，已截断)`;
  if (raw.length > 40000) {
    return `<pre class="md-fallback" style="white-space:pre-wrap;word-break:break-all;font-size:13px;line-height:1.5;color:var(--text2)">${esc(raw)}</pre>`;
  }

  const blocks = [];
  let html = raw.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    const safeCode = esc(code.replace(/^\n|\n$/g, ""));
    const language = lang || "code";
    const block = `<pre><div class="pre-header"><span class="pre-lang">${language}</span><button class="copy-btn" onclick="copyCodeBlock(this)">复制</button></div><code>${safeCode}</code></pre>`;
    blocks.push(block);
    return `\x00BLOCK${blocks.length - 1}\x00`;
  });

  html = esc(html);
  html = html.replace(/\x00BLOCK(\d+)\x00/g, (_match, index) => blocks[Number(index)]);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
  html = html.replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>");
  html = html.replace(/^---$/gm, "<hr>");
  html = html.replace(/((?:^\|.+\|$\n?)+)/gm, (block) => {
    const rows = block.trim().split("\n");
    if (rows.length < 2 || !/^\|[\s\-:|]+\|$/.test(rows[1])) return block;
    const parseRow = (row) => row.replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
    const headers = parseRow(rows[0]).map((header) => `<th>${header}</th>`).join("");
    const body = rows.slice(2).map((row) => `<tr>${parseRow(row).map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("");
    return `<table><thead><tr>${headers}</tr></thead><tbody>${body}</tbody></table>`;
  });
  html = html.replace(/((?:^\d+\. .+$\n?)+)/gm, (block) => `<ol>${block.trim().split("\n").map((line) => `<li>${line.replace(/^\d+\.\s+/, "")}</li>`).join("")}</ol>`);
  html = html.replace(/((?:^[\-\*] .+$\n?)+)/gm, (block) => `<ul>${block.trim().split("\n").map((line) => `<li>${line.replace(/^[\-\*]\s+/, "")}</li>`).join("")}</ul>`);
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, url) => {
    if (/^https?:\/\//i.test(url) || /^file:\/\//i.test(url)) {
      return `<a href="${url}" target="_blank" rel="noopener">${label}</a>`;
    }
    return `${label} (${url})`;
  });
  html = html.replace(/^(?!<[hupbloait]|<\/|<hr)(.*\S.*)$/gm, "<p>$1</p>");
  html = html.replace(/\n{2,}/g, "\n");
  return html;
}

function scrollDown() {
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = null;
    if (userNearBottom) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
      newMessagesBelow = false;
    } else {
      newMessagesBelow = true;
    }
    updateNewMsgBtn();
  });
}

function toast(message) {
  const element = document.getElementById("toast");
  element.innerHTML = `<svg><use href="#i-check"/></svg>${esc(message)}`;
  element.classList.add("show");
  setTimeout(() => element.classList.remove("show"), 2200);
}

function getHerGroup() {
  if (streamGroup) return streamGroup;
  const welcome = document.getElementById("welcome");
  if (welcome) welcome.remove();
  maybeAddTs();

  const message = document.createElement("div");
  message.className = "msg msg-her";
  const bubble = document.createElement("div");
  bubble.className = "bubble fade-in";
  bubble.innerHTML = '<div class="her-label"><svg><use href="#i-bot"/></svg> Her</div>';
  message.appendChild(bubble);
  msgList.appendChild(message);
  streamGroup = bubble;
  return bubble;
}

function finalizeHerGroup() {
  streamGroup = null;
  currentPhaseEl = null;
}

function setPhase(data) {
  const group = getHerGroup();
  if (!currentPhaseEl) {
    currentPhaseEl = document.createElement("div");
    currentPhaseEl.className = "phase-block";
    group.appendChild(currentPhaseEl);
  }

  currentPhaseEl.innerHTML = "";
  const label = document.createElement("div");
  label.className = "phase-label";
  label.textContent = data.label || "处理中";
  currentPhaseEl.appendChild(label);

  if (data.detail) {
    const detail = document.createElement("div");
    detail.className = "phase-detail";
    detail.textContent = data.detail;
    currentPhaseEl.appendChild(detail);
  }
}

function removePhase() {
  if (currentPhaseEl) {
    currentPhaseEl.remove();
    currentPhaseEl = null;
  }
}

function removeThinking() {
  if (thinkingEl) {
    thinkingEl.remove();
    thinkingEl = null;
  }
}

const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function extFromMediaType(mediaType) {
  const map = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
  };
  return map[mediaType] || "png";
}

function arrayBufferFromBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function buildStoredImageName(image, index) {
  const baseName = (image.name || "").trim().replace(/[^\w.\-\u4e00-\u9fff]+/g, "_");
  if (baseName) return baseName;
  return `her-image-${Date.now()}-${index + 1}.${extFromMediaType(image.mediaType)}`;
}

async function persistPastedImages(images) {
  const persisted = [];
  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    const upload = await window.herAPI.uploadFile({
      name: buildStoredImageName(image, index),
      type: image.mediaType,
      data: arrayBufferFromBase64(image.base64),
    });
    persisted.push({
      ...image,
      filename: upload.filename,
      size: upload.size,
    });
  }
  return persisted;
}

function addPastedImage(file) {
  const reader = new FileReader();
  reader.onload = (event) => {
    const dataUrl = event.target.result;
    const mediaType = ALLOWED_IMAGE_TYPES.has(file.type) ? file.type : "image/png";
    const base64 = dataUrl.split(",")[1];
    const id = Date.now() + Math.random();
    const fallbackName = file && file.name ? file.name : `pasted-${Date.now()}.${extFromMediaType(mediaType)}`;
    pastedImages.push({ id, base64, mediaType, dataUrl, name: fallbackName });

    const item = document.createElement("div");
    item.className = "img-preview-item";
    item.innerHTML = `<img src="${dataUrl}"><button class="img-preview-remove">✕</button>`;
    item.querySelector(".img-preview-remove").onclick = () => {
      pastedImages = pastedImages.filter((image) => image.id !== id);
      item.remove();
      updateSendBtn();
    };
    imgPreviews.appendChild(item);
    updateSendBtn();
  };
  reader.readAsDataURL(file);
}

document.getElementById("input-box").addEventListener("paste", (event) => {
  const items = (event.clipboardData || event.originalEvent.clipboardData).items;
  let hasImage = false;
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      hasImage = true;
      const file = item.getAsFile();
      if (file) addPastedImage(file);
    }
  }
  if (hasImage) event.preventDefault();
});

const inputBoxEl = document.getElementById("input-box");
inputBoxEl.addEventListener("dragover", (event) => {
  event.preventDefault();
  inputBoxEl.classList.add("drag-over");
});
inputBoxEl.addEventListener("dragleave", () => inputBoxEl.classList.remove("drag-over"));
inputBoxEl.addEventListener("drop", (event) => {
  event.preventDefault();
  inputBoxEl.classList.remove("drag-over");
  for (const file of event.dataTransfer.files) {
    if (file.type.startsWith("image/")) addPastedImage(file);
  }
});

function fmtTime(date = new Date()) {
  const hours = `${date.getHours()}`.padStart(2, "0");
  const minutes = `${date.getMinutes()}`.padStart(2, "0");
  return `${hours}:${minutes}`;
}

function shouldShowTs(previous) {
  if (!previous) return true;
  return Date.now() - previous > 300000;
}

function maybeAddTs() {
  if (!shouldShowTs(lastMsgTs)) return;
  lastMsgTs = Date.now();
  const ts = document.createElement("div");
  ts.className = "msg-timestamp";
  ts.textContent = fmtTime();
  msgList.appendChild(ts);
}

function getFallbackPresence() {
  return {
    greeting: "我不是来回一轮答案的。我会把你在做的事、产生的文件和后续动作接成一条线。",
    status: "打开我时，最重要的应该不是能力列表，而是你最近那几条还在继续的主线。",
    identityLine: "",
    continuityLine: "",
    memoryNotes: [
      "我会记住你的偏好、项目背景和最近在推进的事。",
      "你给过我的图片、下载过的视频、生成过的文件，都应该还能被我找回来。",
    ],
    openLoops: [],
    taskHistory: [],
    artifacts: [],
    suggestedActions: [
      {
        label: "回顾今天",
        prompt: "回顾一下你最近替我完成了什么，并告诉我下一步",
        description: "先把连续上下文接起来",
      },
      {
        label: "做 PPT",
        prompt: "帮我做一个PPT",
        description: "生成精美演示文稿",
      },
      {
        label: "做表格",
        prompt: "帮我做一个Excel表格",
        description: "生成 Excel 表格和图表",
      },
      {
        label: "找回文件",
        prompt: "把我最近处理过的文件和图片列出来",
        description: "看看最近留下了哪些数字物料",
      },
      {
        label: "下载视频",
        prompt: "帮我下载一个视频",
        description: "从网页链接下载视频到本地",
      },
    ],
    capabilities: [
      "把对话、任务和文件串成连续时间线",
      "记住你处理过的数字物料，并在需要时重新发给你",
      "接着昨天没做完的事，而不是让你重新讲一遍",
    ],
    relationshipProfile: null,
    needsRelationshipSetup: false,
  };
}

function getActionIcon(label) {
  const map = {
    "帮我做点事": "#i-zap",
    "聊聊现在": "#i-heart", "帮我推进": "#i-zap", "设置提醒": "#i-clock",
    "回顾今天": "#i-check", "找回文件": "#i-folder", "整理桌面": "#i-folder",
    "做 PPT": "#i-presentation", "做表格": "#i-table", "下载视频": "#i-download",
  };
  return map[label] || "#i-sparkles";
}

function getActionColor(label) {
  const map = {
    "帮我做点事": "wc-orange",
    "聊聊现在": "wc-red", "帮我推进": "wc-cyan", "设置提醒": "wc-orange",
    "回顾今天": "wc-green", "找回文件": "wc-blue", "整理桌面": "wc-cyan",
    "做 PPT": "wc-orange", "做表格": "wc-green", "下载视频": "wc-purple",
  };
  return map[label] || "wc-green";
}

function getArtifactIcon(kind) {
  if (kind === "image") return "#i-image";
  if (kind === "video") return "#i-video";
  if (kind === "audio") return "#i-music";
  return "#i-file";
}

function normalizePassiveContext(context) {
  return {
    calendar: Array.isArray(context && context.calendar) ? context.calendar : [],
    clipboard: typeof (context && context.clipboard) === "string" ? context.clipboard : "",
    frontApp: typeof (context && context.frontApp) === "string" ? context.frontApp : "",
    currentPage: context && context.currentPage && typeof context.currentPage === "object" ? {
      title: typeof context.currentPage.title === "string" ? context.currentPage.title : "",
      url: typeof context.currentPage.url === "string" ? context.currentPage.url : "",
      description: typeof context.currentPage.description === "string" ? context.currentPage.description : "",
      snippet: typeof context.currentPage.snippet === "string" ? context.currentPage.snippet : "",
      domainLabel: typeof context.currentPage.domainLabel === "string" ? context.currentPage.domainLabel : "",
      kind: typeof context.currentPage.kind === "string" ? context.currentPage.kind : "",
      appName: typeof context.currentPage.appName === "string" ? context.currentPage.appName : "",
    } : null,
  };
}

function refreshPassiveContext({ rerender = false } = {}) {
  if (passiveContextRequest) return passiveContextRequest;
  passiveContextRequest = window.herAPI.getContext()
    .then((context) => {
      currentPassiveContext = normalizePassiveContext(context);
      if (rerender && document.getElementById("welcome")) {
        fillHomeCalendar(currentPassiveContext.calendar);
      }
      return currentPassiveContext;
    })
    .catch(() => currentPassiveContext)
    .finally(() => {
      passiveContextRequest = null;
    });
  return passiveContextRequest;
}

const TRAIT_ZH = {
  "early riser": "早起型", "night owl": "夜猫子",
  "brief messenger": "简洁派", "detailed communicator": "细节控",
  "loves emoji": "爱用 emoji", "direct and action-oriented": "行动派",
  "polite and considerate": "温和有礼",
  "perfectionist tendency": "完美主义", "curious and experimental": "好奇心强", "decisive": "果断",
  "values efficiency": "效率优先", "values aesthetics": "审美驱动",
  "values reliability": "稳定可靠", "values creativity": "创意至上",
  "planner": "计划型", "action-first doer": "先干再说", "multitasker": "多线程选手",
  "currently stressed": "最近有点累", "positive mood": "状态不错",
  "prone to indecision under pressure": "选择困难",
  "software development": "写代码", "design": "做设计",
  "entrepreneurship": "搞创业", "music": "听音乐", "film & shows": "追剧",
  "fitness": "健身运动", "AI & machine learning": "关注 AI",
  "office worker": "上班族", "indie builder / entrepreneur": "独立开发者", "student": "学生党",
};

function traitLabel(trait) {
  const key = (trait || "").toLowerCase().trim();
  return TRAIT_ZH[key] || trait;
}

function updateHomeProfile(profileData) {
  const el = document.getElementById("home-profile");
  if (!el) return;
  profileData = profileData || { score: 0, totalObservations: 0, topTraits: [] };
  const score = profileData.score || 0;
  const scoreLabel = score < 10 ? "刚认识" : score < 30 ? "有点了解" : score < 55 ? "比较了解" : score < 80 ? "很了解" : "默契十足";
  const scoreSub = score < 10 ? "聊聊天让我更懂你"
    : score < 30 ? "慢慢了解中"
    : score < 55 ? "已经摸到一些规律了"
    : score < 80 ? "大部分时候能猜到你的意思"
    : "几乎不用你多说了";
  const traitTags = (profileData.topTraits || []).slice(0, 5).map((t) => {
    const conf = t.confidence >= 0.7 ? "high" : t.confidence >= 0.45 ? "mid" : "low";
    return `<span class="profile-tag ${conf}">${esc(traitLabel(t.trait))}</span>`;
  }).join("");
  el.innerHTML = `
    <div class="profile-score-header">
      <div class="profile-score-ring">
        <svg viewBox="0 0 40 40">
          <circle cx="20" cy="20" r="17" fill="none" stroke="rgba(255,255,255,.06)" stroke-width="3"/>
          <circle cx="20" cy="20" r="17" fill="none" stroke="var(--accent)" stroke-width="3"
            stroke-dasharray="${(score / 100) * 106.8} 106.8"
            stroke-linecap="round" transform="rotate(-90 20 20)"
            style="transition:stroke-dasharray .6s ease"/>
        </svg>
        <span class="profile-score-num">${score}</span>
      </div>
      <div class="profile-score-info">
        <span class="profile-score-label">${scoreLabel}</span>
        <span class="profile-score-sub">${scoreSub}</span>
      </div>
    </div>
    ${traitTags ? `<div class="profile-tags">${traitTags}</div>` : ""}
  `;
}

function loadHomeProfile() {
  window.herAPI.getProfile().catch(() => null).then((profileData) => {
    updateHomeProfile(profileData);
  });
}

function updateHomeBrowserDigest(digestData) {
  const el = document.getElementById("home-browser-digest");
  if (!el) return;
  digestData = digestData || { summary: "", topThreads: [], topDomains: [], lastError: "", lastImportedAt: null };

  if (digestData.lastError && !digestData.summary) {
    el.innerHTML = `<div class="browser-digest-card compact"><div class="browser-digest-summary">浏览历史暂时还没读到：${esc(digestData.lastError)}</div></div>`;
    return;
  }

  if (!digestData.summary) {
    el.innerHTML = '<div class="todo-empty">还没形成浏览摘要。等 Her 跑完第一次 nightly evolution，这里会开始显示你最近在关注什么。</div>';
    return;
  }

  const threadChips = (digestData.topThreads || []).slice(0, 4).map((item) => `<span class="browser-digest-chip">${esc(item)}</span>`).join("");
  const domainText = (digestData.topDomains || []).slice(0, 4).join(" · ");
  el.innerHTML = `
    <div class="browser-digest-card">
      <div class="browser-digest-summary">${esc(digestData.summary)}</div>
      ${threadChips ? `<div class="browser-digest-chips">${threadChips}</div>` : ""}
      ${domainText ? `<div class="browser-digest-meta">主要来源：${esc(domainText)}</div>` : ""}
    </div>
  `;
}

function loadHomeBrowserDigest() {
  window.herAPI.getBrowserDigest().catch(() => null).then((digestData) => {
    updateHomeBrowserDigest(digestData);
  });
}

function updateHomeTodos(todos) {
  const el = document.getElementById("home-todos");
  if (!el) return;
  todos = todos || [];
  el.innerHTML = todos.length === 0
    ? '<div class="todo-empty">暂无待办</div>'
    : todos.slice(0, 8).map((t) => `
      <div class="todo-item">
        <div class="todo-check"><svg><use href="#i-clock"/></svg></div>
        <div class="todo-content">
          <span class="todo-title">${esc(t.title)}</span>
          ${t.dueDate ? `<span class="todo-due">${esc(formatDueDate(t.dueDate))}</span>` : ""}
          ${t.detail ? `<span class="todo-detail">${esc(t.detail)}</span>` : ""}
        </div>
      </div>
    `).join("");
}

function loadHomeTodos() {
  window.herAPI.getTodos().catch(() => []).then((todos) => {
    updateHomeTodos(todos);
  });
}

function loadHomeNewsBriefing() {
  const section = document.getElementById("home-briefing-section");
  if (!section) return;
  window.herAPI.getNewsBriefing().catch(() => null).then((config) => {
    renderNewsBriefingCard(section, config);
  });
}

function renderNewsBriefingCard(section, config) {
  const enabled = config && config.enabled;
  const hour = (config && config.hour) || 9;
  const minute = (config && config.minute) || 0;
  const timeStr = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

  const HOUR_OPTIONS = [7, 8, 9, 10, 11];
  const hourChips = HOUR_OPTIONS.map((h) => `<button class="briefing-hour${h === hour ? " active" : ""}" data-h="${h}">${String(h).padStart(2, "0")}:00</button>`).join("");

  if (enabled) {
    section.innerHTML = `
      <div class="presence-section-title"><svg><use href="#i-globe"/></svg>每日早报</div>
      <div class="briefing-card">
        <div class="briefing-status-row">
          <div class="briefing-status-dot"></div>
          <div class="briefing-status-text">
            <span class="briefing-status-on">已开启 · 每个工作日 ${timeStr}</span>
            <span class="briefing-desc">Her 会根据对你的了解自动推送新闻</span>
          </div>
        </div>
        <div class="briefing-hours">${hourChips}</div>
        <div class="briefing-actions">
          <button class="briefing-now" id="briefing-now">现在就来一份</button>
          <button class="briefing-off" id="briefing-off">关闭早报</button>
        </div>
      </div>
    `;
  } else {
    section.innerHTML = `
      <div class="presence-section-title"><svg><use href="#i-globe"/></svg>每日早报</div>
      <div class="briefing-card briefing-card--off">
        <div class="briefing-pitch">
          <div class="briefing-pitch-text">
            <span class="briefing-pitch-title">让 Her 每天早上给你一份新闻</span>
            <span class="briefing-desc">不用选行业 — Her 已经知道你关注什么</span>
          </div>
        </div>
        <div class="briefing-hours">${hourChips}</div>
        <div class="briefing-actions">
          <button class="briefing-save" id="briefing-save">开启早报</button>
          <button class="briefing-now" id="briefing-now">先试一份</button>
        </div>
      </div>
    `;
  }

  // Hour chip selection
  let selectedHour = hour;
  section.querySelectorAll(".briefing-hour").forEach((chip) => {
    chip.addEventListener("click", async () => {
      section.querySelectorAll(".briefing-hour").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      selectedHour = parseInt(chip.dataset.h, 10);
      if (enabled) {
        await window.herAPI.saveNewsBriefing({ enabled: true, hour: selectedHour, minute: 0 });
        toast(`早报时间已更新为 ${String(selectedHour).padStart(2, "0")}:00`);
        loadHomeNewsBriefing();
      }
    });
  });

  const saveBtn = section.querySelector("#briefing-save");
  if (saveBtn) {
    saveBtn.addEventListener("click", async () => {
      await window.herAPI.saveNewsBriefing({ enabled: true, hour: selectedHour, minute: 0 });
      toast(`早报已开启：每个工作日 ${String(selectedHour).padStart(2, "0")}:00`);
      loadHomeNewsBriefing();
    });
  }

  const offBtn = section.querySelector("#briefing-off");
  if (offBtn) {
    offBtn.addEventListener("click", async () => {
      await window.herAPI.saveNewsBriefing({ enabled: false, hour: 9, minute: 0 });
      toast("早报已关闭");
      loadHomeNewsBriefing();
    });
  }

  section.querySelector("#briefing-now").addEventListener("click", () => {
    send("给我来一份今天的新闻早报，根据你对我的了解搜我会感兴趣的内容，图文并茂展示，最后简短总结。");
  });
}

function fillHomeCalendar(calendar) {
  const el = document.getElementById("home-calendar");
  if (!el || !calendar || calendar.length === 0) {
    if (el) el.innerHTML = "";
    return;
  }
  el.innerHTML = `<div class="presence-section">
    <div class="presence-section-title"><svg><use href="#i-clock"/></svg>今天日程</div>
    ${calendar.slice(0, 8).map((ev) => {
      const timePart = (ev.startDate || "").replace(/.*(\d{1,2}:\d{2}).*/, "$1");
      return `<div class="cal-item"><span class="cal-time">${esc(timePart)}</span><span class="cal-title">${esc(ev.title)}${ev.location ? ` · ${esc(ev.location)}` : ""}</span></div>`;
    }).join("")}
  </div>`;
}

function buildSetupOptions(group, selectedValue) {
  return RELATIONSHIP_SETUP_OPTIONS[group].map((item) => `
    <button class="setup-option${item.value === selectedValue ? " selected" : ""}" type="button" data-setup-value="${encodeURIComponent(item.value)}">
      <span class="setup-option-title">${esc(item.value)}</span>
      <span class="setup-option-desc">${esc(item.description)}</span>
    </button>
  `).join("");
}

function renderRelationshipSetup(setup = currentRelationshipSetup || { needsSetup: true, profile: null }) {
  currentRelationshipSetup = setup;
  const profile = setup.profile || {};
  msgList.innerHTML = "";

  const welcome = document.createElement("div");
  welcome.className = "welcome presence-home relationship-setup";
  welcome.id = "welcome";
  welcome.innerHTML = `
    <div class="setup-card">
      <div class="setup-block">
        <div class="setup-label">我先用什么样的方式陪你，会让你更舒服？</div>
        <div class="setup-options" data-setup-group="tone">
          ${buildSetupOptions("tone", profile.tone || "像搭子一起推进")}
        </div>
      </div>
      <div class="setup-block">
        <div class="setup-label">在你这边，我更像什么？</div>
        <div class="setup-options" data-setup-group="relationshipMode">
          ${buildSetupOptions("relationshipMode", profile.relationshipMode || "长期陪伴者")}
        </div>
      </div>
      <div class="setup-block">
        <div class="setup-label">我主动一点，会不会打扰你？</div>
        <div class="setup-options" data-setup-group="proactivity">
          ${buildSetupOptions("proactivity", profile.proactivity || "适度主动")}
        </div>
      </div>
      <div class="setup-block">
        <div class="setup-label">最近你最想让我接住哪件事？</div>
        <textarea class="setup-textarea" id="setupFocus" placeholder="随便说说，比如在做一个项目、准备面试、调整状态，或者只是想有人接住你。">${esc(profile.currentFocus || "")}</textarea>
      </div>
      <button class="setup-submit" id="setupSubmit" type="button">好，我记住了</button>
    </div>
  `;

  welcome.querySelectorAll("[data-setup-group]").forEach((group) => {
    group.querySelectorAll(".setup-option").forEach((button) => {
      button.addEventListener("click", () => {
        group.querySelectorAll(".setup-option").forEach((entry) => entry.classList.remove("selected"));
        button.classList.add("selected");
      });
    });
  });

  welcome.querySelector("#setupSubmit").addEventListener("click", async () => {
    const tone = decodeURIComponent(welcome.querySelector('[data-setup-group="tone"] .setup-option.selected').dataset.setupValue);
    const relationshipMode = decodeURIComponent(welcome.querySelector('[data-setup-group="relationshipMode"] .setup-option.selected').dataset.setupValue);
    const proactivity = decodeURIComponent(welcome.querySelector('[data-setup-group="proactivity"] .setup-option.selected').dataset.setupValue);
    const currentFocus = welcome.querySelector("#setupFocus").value.trim();
    const button = welcome.querySelector("#setupSubmit");

    button.disabled = true;
    button.textContent = "记住中...";
    try {
      const result = await window.herAPI.saveRelationshipProfile({
        tone,
        relationshipMode,
        proactivity,
        currentFocus,
      });
      currentPresence = result.presence || currentPresence || getFallbackPresence();
      currentRelationshipSetup = result.onboarding || { needsSetup: false, profile: result.profile || null };
      toast("这样就够了，剩下的我会慢慢学。");
      renderPresenceHome(currentPresence);
    } catch (error) {
      button.disabled = false;
      button.textContent = "好，我记住了";
      toast(`保存失败: ${error.message}`);
    }
  });

  msgList.appendChild(welcome);
  scrollDown();
}

function renderPresenceHome(presence = currentPresence || getFallbackPresence(), options = {}) {
  if (presence && presence.needsRelationshipSetup) {
    renderRelationshipSetup(currentRelationshipSetup || {
      needsSetup: true,
      profile: presence.relationshipProfile || null,
    });
    return;
  }
  currentPresence = presence;
  msgList.innerHTML = "";
  const welcome = document.createElement("div");
  welcome.className = "welcome presence-home";
  welcome.id = "welcome";

  // Build action buttons (sync, no data needed)
  const extraActions = [
    { label: "下载视频", prompt: "帮我下载一个视频", description: "从网页链接下载视频到本地" },
    { label: "做 PPT", prompt: "帮我做一个PPT", description: "生成精美演示文稿" },
    { label: "做表格", prompt: "帮我做一个Excel表格", description: "生成 Excel 表格和图表" },
  ];
  const seenLabels = new Set((presence.suggestedActions || []).map((a) => a.label));
  const dedupedExtra = extraActions.filter((a) => !seenLabels.has(a.label));
  const allActions = [...(presence.suggestedActions || []), ...dedupedExtra];
  const actions = allActions.slice(0, 6).map((action) => `
    <button class="presence-action" data-msg="${encodeURIComponent(action.prompt)}">
      <div class="presence-action-icon ${getActionColor(action.label)}"><svg><use href="${getActionIcon(action.label)}"/></svg></div>
      <div class="presence-action-text">
        <span class="presence-action-label">${esc(action.label)}</span>
        <span class="presence-action-desc">${esc(action.description)}</span>
      </div>
    </button>
  `).join("");

  // Render skeleton immediately — no await
  welcome.innerHTML = `
    <div class="profile-score-card" id="home-profile">
      <div class="profile-score-header">
        <div class="profile-score-ring">
          <svg viewBox="0 0 40 40">
            <circle cx="20" cy="20" r="17" fill="none" stroke="rgba(255,255,255,.06)" stroke-width="3"/>
            <circle cx="20" cy="20" r="17" fill="none" stroke="var(--accent)" stroke-width="3"
              stroke-dasharray="0 106.8" stroke-linecap="round" transform="rotate(-90 20 20)"
              style="transition:stroke-dasharray .6s ease"/>
          </svg>
          <span class="profile-score-num">–</span>
        </div>
        <div class="profile-score-info">
          <span class="profile-score-label">加载中</span>
          <span class="profile-score-sub">Her 对你的了解程度</span>
        </div>
      </div>
    </div>
    <div id="home-calendar"></div>
    <div class="presence-section">
      <div class="presence-section-title"><svg><use href="#i-check"/></svg>待办</div>
      <div id="home-todos"><div class="todo-empty" style="opacity:.4">加载中...</div></div>
    </div>
    <div class="presence-section" id="home-briefing-section"></div>
    <div class="presence-section">
      <div class="presence-section-title"><svg><use href="#i-sparkles"/></svg>试试说</div>
      <div class="presence-actions">${actions}</div>
    </div>
  `;
  welcome.querySelectorAll("[data-msg]").forEach((card) => card.addEventListener("click", () => send(decodeURIComponent(card.dataset.msg))));
  msgList.appendChild(welcome);

  loadHomeProfile();
  loadHomeBrowserDigest();
  loadHomeTodos();
  loadHomeNewsBriefing();

  // Calendar from cached context first, then refresh
  fillHomeCalendar(currentPassiveContext.calendar);
  if (!options.skipContextRefresh) {
    refreshPassiveContext().then(() => {
      fillHomeCalendar(currentPassiveContext.calendar);
    }).catch(() => {});
  }
}

function setStatusConnected() {
  statusDot.className = "hd-dot";
}

function setModelDisplay(model) {
  const element = document.getElementById("modelSelect");
  element.dataset.value = model || "claude-opus-4-6";
  if ((model || "").includes("opus-4-6")) element.textContent = "Opus 4.6";
  else if ((model || "").includes("opus")) element.textContent = "Opus";
  else if ((model || "").includes("sonnet")) element.textContent = "Sonnet";
  else if ((model || "").includes("haiku")) element.textContent = "Haiku";
  else element.textContent = model || "Model";
}

function handle(data) {
  if (data.type === "phase") {
    if (data.clear) removePhase();
    else {
      setPhase(data);
      scrollDown();
    }
    return;
  }

  if (data.type === "thinking") {
    removeThinking();
    if (streamEl && streamBuf) {
      if (streamTimer) {
        clearTimeout(streamTimer);
        streamTimer = null;
      }
      finalizeStreamMarkup();
      streamEl.classList.remove("typing-cursor");
      streamEl = null;
      streamBuf = "";
    }
    setGenerating(true);
    const group = getHerGroup();
    const dots = document.createElement("div");
    dots.className = "thinking";
    dots.innerHTML = "<span></span><span></span><span></span>";
    group.appendChild(dots);
    thinkingEl = dots;
    scrollDown();
    return;
  }

  removeThinking();

  if (data.type === "stream") {
    removePhase();
    finishCmd();
    if (!isGenerating) setGenerating(true);
    if (!streamEl) {
      const group = getHerGroup();
      streamEl = document.createElement("div");
      streamEl.className = "md";
      group.appendChild(streamEl);
      streamBuf = "";
    }
    appendStream(data.text);
    return;
  }

  if (data.type === "stream_end") {
    removePhase();
    finishCmd();
    endStream();
    finalizeHerGroup();
    return;
  }

  if (data.type === "command") {
    finishCmd();
    const group = getHerGroup();
    const block = document.createElement("div");
    block.className = "cmd-block";
    const command = data.command || "";
    const title = data.title || "执行命令";
    const detail = data.detail || command;
    const meta = detail ? `<div class="cmd-meta">${esc(detail)}</div>` : "";
    block.innerHTML = `<div class="cmd-bar" onclick="this.querySelector('.cmd-toggle').classList.toggle('open');this.nextElementSibling.classList.toggle('open')"><div class="cmd-spinner"></div><div class="cmd-copy"><span class="cmd-label">${esc(title)}</span>${meta}</div><span class="cmd-toggle">▼</span></div><div class="cmd-detail"><div class="cmd-detail-cmd">$ ${esc(command)}</div></div>`;
    group.appendChild(block);
    currentCmd = block;
    scrollDown();
    return;
  }

  if (data.type === "command_output") {
    if (currentCmd) {
      const output = (data.output || "").trim();
      if (output) {
        const detail = currentCmd.querySelector(".cmd-detail");
        if (detail) {
          const out = document.createElement("div");
          out.className = "cmd-detail-out";
          out.textContent = output;
          detail.appendChild(out);
        }
      }
      finishCmd();
      scrollDown();
    }
    return;
  }

  if (data.type === "file") {
    const group = getHerGroup();
    const card = document.createElement("div");
    card.className = "file-card";
    let preview = "";
    if (data.fileType === "video") preview = `<video controls preload="metadata" src="${data.url}"></video>`;
    else if (data.fileType === "image") preview = `<img class="file-preview" src="${data.url}" alt="${esc(data.filename)}">`;
    else if (data.fileType === "audio") preview = `<audio controls src="${data.url}"></audio>`;
    const icons = { video: "#i-video", image: "#i-image", audio: "#i-music", file: "#i-file" };
    card.innerHTML = `${preview}<div class="file-bar"><div class="file-icon"><svg><use href="${icons[data.fileType] || "#i-file"}"/></svg></div><div class="file-meta"><div class="file-name">${esc(data.filename)}</div><div class="file-size">${data.size}</div></div><a class="file-dl" href="${data.url}" download="${esc(data.filename)}"><svg><use href="#i-download"/></svg></a></div>`;
    group.appendChild(card);
    scrollDown();
    return;
  }

  if (data.type === "news_cards") {
    const cards = Array.isArray(data.cards) ? data.cards : [];
    if (cards.length === 0) return;

    const group = getHerGroup();
    const wrap = document.createElement("div");
    wrap.className = "news-wrap";

    const header = document.createElement("div");
    header.className = "news-header";
    header.innerHTML = `<svg><use href="#i-globe"/></svg>${esc(data.query || "新闻摘要")}`;
    wrap.appendChild(header);

    const grid = document.createElement("div");
    grid.className = "news-grid";

    cards.forEach((item) => {
      const article = document.createElement("article");
      article.className = item.imageUrl ? "news-card" : "news-card news-card--no-image";

      if (item.imageUrl) {
        const image = document.createElement("img");
        image.className = "news-card-image";
        image.src = item.imageUrl;
        image.alt = item.title || "";
        image.loading = "lazy";
        image.onerror = function () { this.remove(); article.classList.add("news-card--no-image"); };
        article.appendChild(image);
      }

      const body = document.createElement("div");
      body.className = "news-card-body";

      const title = document.createElement("a");
      title.className = "news-card-title";
      title.href = item.url || "#";
      title.target = "_blank";
      title.rel = "noopener";
      title.textContent = item.title || "未命名新闻";
      body.appendChild(title);

      const summary = document.createElement("p");
      summary.className = "news-card-summary";
      summary.textContent = item.summary || "";
      body.appendChild(summary);

      const meta = document.createElement("div");
      meta.className = "news-card-meta";
      meta.textContent = [item.source, item.publishedAt].filter(Boolean).join(" · ");
      body.appendChild(meta);

      article.appendChild(body);
      grid.appendChild(article);
    });

    wrap.appendChild(grid);
    group.appendChild(wrap);
    scrollDown();
    return;
  }

  if (data.type === "response") {
    removePhase();
    const group = getHerGroup();
    const text = document.createElement("div");
    text.className = "md";
    text.innerHTML = mdCached(data.text);
    group.appendChild(text);
    currentCmd = null;
    setGenerating(false);
    finalizeHerGroup();
    scrollDown();
    return;
  }

  if (data.type === "memory_saved") {
    toast(`已记住: ${data.key}`);
    return;
  }

  if (data.type === "todo_updated") {
    if (document.getElementById("home-todos")) loadHomeTodos();
    return;
  }

  if (data.type === "presence") {
    currentPresence = data.presence || getFallbackPresence();
    currentRelationshipSetup = {
      needsSetup: Boolean(currentPresence.needsRelationshipSetup),
      profile: currentPresence.relationshipProfile || (currentRelationshipSetup ? currentRelationshipSetup.profile : null),
    };
    if (document.getElementById("welcome")) {
      if (currentRelationshipSetup.needsSetup) renderRelationshipSetup(currentRelationshipSetup);
      else renderPresenceHome(currentPresence);
    }
    return;
  }

  if (data.type === "compaction") {
    finalizeHerGroup();
    const notice = document.createElement("div");
    notice.className = "compaction";
    notice.innerHTML = '<div class="compaction-tag">上下文已压缩</div>';
    msgList.appendChild(notice);
    scrollDown();
    return;
  }

  if (data.type === "open-file") {
    send(`帮我看看这个文件: ${data.filePath}`);
    return;
  }

  if (data.type === "context_reminder") {
    showContextReminder(data.reminder || {});
    return;
  }

  if (data.type === "browser_companion_offer") {
    showBrowserOffer(data.offer || {});
    return;
  }

  if (data.type === "browser_history_digest") {
    if (document.getElementById("home-browser-digest")) loadHomeBrowserDigest();
    return;
  }

  if (data.type === "pin-changed") {
    document.getElementById("pinBtn").classList.toggle("pinned", data.pinned);
    return;
  }

  if (data.type === "clear") {
    removePhase();
    finalizeHerGroup();
    endStream();
    removeThinking();
    currentCmd = null;
    document.getElementById("usageDisplay").className = "usage-display";
    if (currentRelationshipSetup && currentRelationshipSetup.needsSetup) renderRelationshipSetup(currentRelationshipSetup);
    else renderPresenceHome(currentPresence || getFallbackPresence());
    sendBtn.disabled = true;
    toast("对话已清空");
    return;
  }

  if (data.type === "schedule_result") {
    removePhase();
    finalizeHerGroup();
    const group = getHerGroup();
    const header = document.createElement("div");
    header.className = "schedule-hdr";
    header.innerHTML = `<svg><use href="#i-clock"/></svg> ${esc(data.description)}`;
    group.appendChild(header);
    if (data.output && data.output.trim()) {
      const output = document.createElement("div");
      output.className = "md";
      output.innerHTML = md(data.output.trim());
      group.appendChild(output);
    }
    finalizeHerGroup();
    scrollDown();
    return;
  }

  if (data.type === "client_status") {
    const prev = lastClients.join(",");
    lastClients = data.clients || [];
    if (lastClients.length > 0) {
      statusText.textContent = `${lastClients.join(" & ")} 已连接`;
      statusText.className = "hd-status connected";
      if (prev !== lastClients.join(",")) toast(`${lastClients.join(" & ")} 已连接`);
    } else {
      statusText.textContent = "";
      statusText.className = "hd-status";
    }
    const winDot = document.getElementById("slash-win-status");
    const macDot = document.getElementById("slash-mac-status");
    if (winDot) winDot.className = `slash-status${data.win ? " online" : ""}`;
    if (macDot) macDot.className = `slash-status${data.mac ? " online" : ""}`;
    return;
  }

  if (data.type === "usage") {
    const element = document.getElementById("usageDisplay");
    const tokens = data.input_tokens + data.output_tokens;
    const count = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens;
    element.textContent = `${count} tokens · $${data.total_cost}`;
    element.className = "usage-display visible";
    return;
  }

  if (data.type === "restore") {
    removePhase();
    const welcome = document.getElementById("welcome");
    if (welcome) welcome.style.display = "none";
    msgList.innerHTML = "";
    lastMsgTs = 0;
    for (const message of data.messages) {
      if (message.role === "user") {
        const el = document.createElement("div");
        el.className = "msg msg-user";
        const bubble = document.createElement("div");
        bubble.className = "bubble";
        if (message.hasImages) {
          const marker = document.createElement("div");
          marker.style.cssText = "font-size:12px;color:var(--text3);margin-bottom:4px";
          marker.textContent = "[图片]";
          bubble.appendChild(marker);
        }
        const text = document.createElement("div");
        text.textContent = message.text;
        bubble.appendChild(text);
        el.appendChild(bubble);
        msgList.appendChild(el);
      } else {
        const el = document.createElement("div");
        el.className = "msg msg-her";
        const bubble = document.createElement("div");
        bubble.className = "bubble";
        bubble.innerHTML = '<div class="her-label"><svg><use href="#i-bot"/></svg> Her</div>';
        const content = document.createElement("div");
        content.className = "md";
        content.innerHTML = mdCached(message.text);
        bubble.appendChild(content);
        el.appendChild(bubble);
        msgList.appendChild(el);
      }
    }
    scrollDown();
    return;
  }

  if (data.type === "error") {
    removePhase();
    finishCmd();
    removeThinking();
    const group = getHerGroup();
    const text = document.createElement("div");
    text.className = "md";
    text.style.color = "#f87171";
    text.textContent = data.text;
    group.appendChild(text);
    setGenerating(false);
    finalizeHerGroup();
    scrollDown();
  }
}

function showBrowserOffer(offer) {
  const old = document.getElementById("browser-offer");
  if (old) old.remove();
  if (!offer || !offer.message) return;

  const bar = document.createElement("div");
  bar.id = "browser-offer";
  bar.className = "browser-offer";
  bar.innerHTML = `
    <div class="browser-offer-meta">
      <span class="browser-offer-chip">${esc(offer.domainLabel || offer.appName || "网页")}</span>
      ${offer.title ? `<span class="browser-offer-title">${esc(offer.title)}</span>` : ""}
    </div>
    <div class="browser-offer-text">${esc(offer.message)}</div>
    <div class="browser-offer-actions">
      <button class="browser-offer-btn" data-action="primary">${esc(offer.primaryLabel || "聊这个")}</button>
      <button class="browser-offer-btn ghost" data-action="secondary">${esc(offer.secondaryLabel || "补背景")}</button>
      <button class="browser-offer-dismiss" aria-label="关闭">✕</button>
    </div>
  `;

  bar.querySelector(".browser-offer-dismiss").addEventListener("click", () => bar.remove());
  bar.querySelector('[data-action="primary"]').addEventListener("click", () => {
    bar.remove();
    send(offer.primaryPrompt || `顺着我刚刚正在看的内容继续聊：${offer.title || offer.url || ""}`);
  });
  bar.querySelector('[data-action="secondary"]').addEventListener("click", () => {
    bar.remove();
    send(offer.secondaryPrompt || `围绕我刚刚正在看的内容补一点背景：${offer.title || offer.url || ""}`);
  });

  const inputArea = document.getElementById("input-area");
  inputArea.insertBefore(bar, inputArea.firstChild);

  setTimeout(() => {
    if (bar.parentNode) bar.remove();
  }, 22000);
}

function showContextReminder(reminder) {
  const old = document.getElementById("context-reminder");
  if (old) old.remove();
  if (!reminder || !reminder.title) return;

  const bar = document.createElement("div");
  bar.id = "context-reminder";
  bar.className = "context-reminder";
  bar.innerHTML = `
    <div class="context-reminder-copy">
      <div class="context-reminder-eyebrow">Her 提醒你</div>
      <div class="context-reminder-title">${esc(reminder.title)}</div>
      ${reminder.body ? `<div class="context-reminder-body">${esc(reminder.body)}</div>` : ""}
    </div>
    <div class="context-reminder-actions">
      <button class="context-reminder-btn" data-action="plan">帮我安排</button>
      <button class="context-reminder-btn ghost" data-action="dismiss">知道了</button>
    </div>
  `;

  bar.querySelector('[data-action="plan"]').addEventListener("click", () => {
    bar.remove();
    send(`这个提醒到了：${reminder.title}${reminder.meta && reminder.meta.dueDate ? `（${reminder.meta.dueDate}）` : ""}。帮我顺一下接下来要怎么安排。`);
  });
  bar.querySelector('[data-action="dismiss"]').addEventListener("click", () => {
    bar.remove();
  });

  const inputArea = document.getElementById("input-area");
  inputArea.insertBefore(bar, inputArea.firstChild);

  setTimeout(() => {
    if (bar.parentNode) bar.remove();
  }, 18000);
}

window.addEventListener("focus", () => {
  const old = document.getElementById("browser-offer");
  if (old) old.remove();
});

function updateSendBtn() {
  const has = input.value.trim().length > 0 || pastedImages.length > 0;
  sendBtn.disabled = !has;
  sendBtn.classList.toggle("active", has);
}

function refreshInputLayout() {
  if (inputLayoutFrame) cancelAnimationFrame(inputLayoutFrame);
  inputLayoutFrame = requestAnimationFrame(() => {
    inputLayoutFrame = null;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
    updateSendBtn();
  });
}

async function send(text) {
  text = (text || input.value).trim();
  if (!text && pastedImages.length === 0) return;

  const prefix = window.getTargetPrefix ? window.getTargetPrefix() : "";
  const displayText = text;
  const aiText = prefix && text !== "/clear" ? `${prefix}${text}` : text;

  finalizeHerGroup();
  endStream();
  const welcome = document.getElementById("welcome");
  if (welcome) welcome.remove();

  maybeAddTs();
  const message = document.createElement("div");
  message.className = "msg msg-user";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  pastedImages.forEach((image) => {
    const el = document.createElement("img");
    el.src = image.dataUrl;
    el.className = "msg-img";
    el.onclick = () => openLightbox(image.dataUrl);
    bubble.appendChild(el);
  });
  if (displayText) {
    const paragraph = document.createElement("div");
    if (prefix && displayText !== "/clear") {
      const target = prefix.match(/Windows|Mac|服务器/);
      if (target) {
        paragraph.innerHTML = `<span class="slash-target-badge" style="margin-right:6px"><svg style="width:12px;height:12px"><use href="${prefix.includes("服务器") ? "#i-server" : "#i-monitor"}"/></svg>${target[0]}</span>${esc(displayText)}`;
      } else {
        paragraph.textContent = displayText;
      }
    } else {
      paragraph.textContent = displayText;
    }
    bubble.appendChild(paragraph);
  }
  message.appendChild(bubble);
  msgList.appendChild(message);
  scrollDown();

  let storedImages = pastedImages;
  try {
    if (pastedImages.length > 0) {
      storedImages = await persistPastedImages(pastedImages);
    }
  } catch (error) {
    toast(`图片保存失败: ${error.message}`);
  }

  const imageFileNote = storedImages
    .map((image) => image.filename)
    .filter(Boolean)
    .join(", ");
  const messageForAI = imageFileNote
    ? `${aiText || "请分析这张图片"}\n\n[用户图片已保存到共享目录，可直接发送给用户: ${imageFileNote}]`
    : (aiText || "请分析这张图片");

  window.herAPI.sendMessage({
    message: messageForAI,
    images: storedImages.map((image) => ({
      base64: image.base64,
      mediaType: image.mediaType,
      filename: image.filename || "",
      originalName: image.name || "",
    })),
    passiveContext: currentPassiveContext,
    model: document.getElementById("modelSelect").dataset.value || "claude-sonnet-4-6",
  });

  input.value = "";
  input.style.height = "auto";
  pastedImages = [];
  imgPreviews.innerHTML = "";
  sendBtn.disabled = true;
  sendBtn.classList.remove("active");
}

function openLightbox(src) {
  document.getElementById("lightbox-img").src = src;
  document.getElementById("lightbox").classList.add("open");
}

document.getElementById("lightbox").onclick = () => document.getElementById("lightbox").classList.remove("open");
sendBtn.addEventListener("click", () => {
  if (isGenerating) stopGeneration();
  else send();
});
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    const slashMenu = document.getElementById("slashMenu");
    if (slashMenu && slashMenu.classList.contains("open")) return;
    event.preventDefault();
    send();
  }
});
input.addEventListener("input", () => {
  refreshInputLayout();
});
const fileInput = document.getElementById("file-upload");
document.querySelector("label[title='上传文件']").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  if (!file) return;
  if (file.type.startsWith("image/")) {
    addPastedImage(file);
    fileInput.value = "";
    return;
  }

  try {
    const response = await window.herAPI.uploadFile({
      name: file.name,
      type: file.type,
      data: await file.arrayBuffer(),
    });
    const size = file.size < 1024 * 1024 ? `${(file.size / 1024).toFixed(1)}KB` : `${(file.size / 1024 / 1024).toFixed(1)}MB`;
    toast(`已上传: ${response.filename}`);
    send(`我上传了一个文件: ${response.filename}(${size})，已保存到共享目录。`);
  } catch (error) {
    toast(`上传失败: ${error.message}`);
  }
  fileInput.value = "";
});



(function setupSlashMenu() {
  const menu = document.getElementById("slashMenu");
  const badge = document.getElementById("targetBadge");
  const items = menu.querySelectorAll(".slash-item");
  let currentTarget = null;
  let activeIndex = 0;

  function showMenu() {
    activeIndex = 0;
    items.forEach((item, index) => item.classList.toggle("active", index === 0));
    menu.classList.add("open");
  }

  function hideMenu() {
    menu.classList.remove("open");
  }

  function setTarget(target, prefix) {
    if (target === "clear") {
      input.value = "";
      hideMenu();
      send("/clear");
      return;
    }

    currentTarget = target;
    badge.innerHTML = `<span class="slash-target-badge"><svg><use href="${target === "server" ? "#i-server" : "#i-monitor"}"/></svg>${prefix.replace(/[\[\] ]/g, "")}<span class="remove" onclick="clearTarget()">✕</span></span>`;
    input.value = "";
    input.placeholder = `在 ${prefix.replace(/[\[\] ]/g, "")} 上做什么...`;
    hideMenu();
    input.focus();
    updateSendBtn();
  }

  window.clearTarget = function clearTarget() {
    currentTarget = null;
    badge.innerHTML = "";
    input.placeholder = "说点什么...";
    updateSendBtn();
  };

  window.getTargetPrefix = function getTargetPrefix() {
    if (!currentTarget) return "";
    const prefixes = { win: "[在 Windows 上执行] ", mac: "[在 Mac 上执行] ", server: "[在服务器上执行] " };
    return prefixes[currentTarget] || "";
  };

  items.forEach((item, index) => {
    item.addEventListener("click", () => setTarget(item.dataset.target, item.dataset.prefix));
    item.addEventListener("mouseenter", () => {
      activeIndex = index;
      items.forEach((entry, innerIndex) => entry.classList.toggle("active", innerIndex === index));
    });
  });

  input.addEventListener("input", () => {
    const value = input.value;
    if (value === "/") {
      showMenu();
      return;
    }

    if (value.startsWith("/")) {
      const query = value.slice(1).toLowerCase();
      let anyVisible = false;
      items.forEach((item) => {
        const matches = item.dataset.target.includes(query) || item.querySelector(".slash-label").textContent.toLowerCase().includes(query);
        item.style.display = matches ? "flex" : "none";
        if (matches) anyVisible = true;
      });
      if (anyVisible) menu.classList.add("open");
      else hideMenu();
      return;
    }

    hideMenu();
  });

  input.addEventListener("keydown", (event) => {
    if (!menu.classList.contains("open")) return;
    const visible = [...items].filter((item) => item.style.display !== "none");
    if (event.key === "ArrowDown") {
      event.preventDefault();
      activeIndex = Math.min(activeIndex + 1, visible.length - 1);
      visible.forEach((item, index) => item.classList.toggle("active", index === activeIndex));
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      visible.forEach((item, index) => item.classList.toggle("active", index === activeIndex));
      return;
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      const selected = visible[activeIndex];
      if (selected) setTarget(selected.dataset.target, selected.dataset.prefix);
      return;
    }

    if (event.key === "Escape") {
      hideMenu();
      input.value = "";
      refreshInputLayout();
    }
  });

  document.addEventListener("click", (event) => {
    if (!menu.contains(event.target) && event.target !== input) hideMenu();
  });
}());

function fallbackCopy(text) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.cssText = "position:fixed;left:-9999px;top:-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

function doCopy(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  fallbackCopy(text);
  return Promise.resolve();
}

window.copyCodeBlock = function copyCodeBlock(button) {
  const code = button.closest("pre").querySelector("code").innerText;
  doCopy(code).then(() => {
    button.textContent = "已复制 ✓";
    button.classList.add("copied");
    setTimeout(() => {
      button.textContent = "复制";
      button.classList.remove("copied");
    }, 1500);
  });
};

document.getElementById("newChatBtn").addEventListener("click", () => {
  if (confirm("开始新对话？当前对话历史将被清空。")) send("/clear");
});

document.getElementById("pinBtn").addEventListener("click", async () => {
  const button = document.getElementById("pinBtn");
  if (button.disabled) return;
  button.disabled = true;
  try {
    const pinned = await window.herAPI.togglePin();
    button.classList.toggle("pinned", Boolean(pinned));
  } catch (error) {
    toast(`置顶失败: ${error.message}`);
  } finally {
    setTimeout(() => {
      button.disabled = false;
    }, 120);
  }
});

let resizeTimer = null;
window.addEventListener("resize", () => {
  document.body.classList.add("is-resizing");
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    document.body.classList.remove("is-resizing");
  }, 140);
});

function showApiKeySetup(onDone) {
  const overlay = document.createElement("div");
  overlay.className = "apikey-overlay";
  overlay.innerHTML = `
    <div class="apikey-card">
      <div class="apikey-icon"><svg><use href="#i-zap"/></svg></div>
      <div class="apikey-title">连接 AI</div>
      <div class="apikey-desc">Her 需要一个 API Key 来驱动对话。<br>填入后即可开始。</div>
      <input class="apikey-input" type="password" placeholder="sk-..." autocomplete="off" spellcheck="false">
      <div class="apikey-error"></div>
      <button class="apikey-submit" disabled>继续</button>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = overlay.querySelector(".apikey-input");
  const btn = overlay.querySelector(".apikey-submit");
  const errorEl = overlay.querySelector(".apikey-error");

  input.addEventListener("input", () => {
    btn.disabled = !input.value.trim();
    errorEl.textContent = "";
  });

  async function submit() {
    const key = input.value.trim();
    if (!key) return;
    btn.disabled = true;
    btn.textContent = "验证中...";
    errorEl.textContent = "";
    try {
      await window.herAPI.saveApiKey(key);
      overlay.style.transition = "opacity .4s";
      overlay.style.opacity = "0";
      setTimeout(() => { overlay.remove(); if (typeof onDone === "function") onDone(); }, 400);
    } catch (e) {
      errorEl.textContent = e.message || "保存失败";
      btn.disabled = false;
      btn.textContent = "继续";
    }
  }

  btn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !btn.disabled) submit(); });
  setTimeout(() => input.focus(), 100);
}

function showOnboarding(onDone) {
  const slides = [
    {
      icon: "i-clock",
      headline: "工业革命让我们<span class=\"accent\">围着时钟</span>转",
      sub: "日程表、闹钟、倒计时——我们把生活切成了一格一格。",
    },
    {
      icon: "i-globe",
      headline: "你不用再每次都<span class=\"accent\">从头解释自己</span>",
      sub: "我会慢慢记住你的语气、你最近在忙的事，还有那些你没说完的话。",
    },
    {
      icon: "i-brain",
      headline: "我不只是<span class=\"accent\">回答你</span>",
      sub: "你发给我的图片、文件、提醒，还有今天发生过的事，我会把它们接成同一条线。",
    },
    {
      icon: "i-heart",
      headline: "Her 会越来越像那个<span class=\"accent\">懂你的人</span>",
      sub: "不是因为我拿到了很多数据，而是因为我会在时间里慢慢认识你。",
    },
    {
      icon: "i-sparkles",
      headline: "开始之前，先让我<span class=\"accent\">认识你一点点</span>",
      sub: "你告诉我你喜欢我怎么陪你。剩下的，我会慢慢学。",
    },
  ];

  const overlay = document.createElement("div");
  overlay.className = "onboarding-overlay";

  slides.forEach((slide, i) => {
    const el = document.createElement("div");
    el.className = `onboarding-slide${i === 0 ? " active" : ""}`;
    el.innerHTML = `
      <div class="onboarding-icon"><svg><use href="#${slide.icon}"/></svg></div>
      <div class="onboarding-headline">${slide.headline}</div>
      <div class="onboarding-sub">${slide.sub.replace(/\n/g, "<br>")}</div>
    `;
    overlay.appendChild(el);
  });

  const dots = document.createElement("div");
  dots.className = "onboarding-dots";
  slides.forEach((_, i) => {
    const dot = document.createElement("div");
    dot.className = `onboarding-dot${i === 0 ? " active" : ""}`;
    dots.appendChild(dot);
  });
  overlay.appendChild(dots);

  const cta = document.createElement("button");
  cta.className = `onboarding-cta${slides.length <= 1 ? " visible" : ""}`;
  cta.innerHTML = `<span class="cta-inner"><svg><use href="#i-sparkles"/></svg>先认识一下</span>`;
  overlay.appendChild(cta);

  const skip = document.createElement("button");
  skip.className = "onboarding-skip";
  skip.textContent = "跳过";
  overlay.appendChild(skip);

  document.body.appendChild(overlay);

  let current = 0;
  let transitioning = false;

  function goTo(index) {
    if (transitioning || index === current || index < 0 || index >= slides.length) return;
    transitioning = true;
    const allSlides = overlay.querySelectorAll(".onboarding-slide");
    const allDots = overlay.querySelectorAll(".onboarding-dot");
    allSlides[current].classList.remove("active");
    allSlides[current].classList.add("exit");
    allSlides[index].classList.remove("exit");
    // Force reflow for animation
    void allSlides[index].offsetWidth;
    allSlides[index].classList.add("active");
    allDots[current].classList.remove("active");
    allDots[index].classList.add("active");
    current = index;
    // Show CTA on last slide
    if (current === slides.length - 1) cta.classList.add("visible");
    else cta.classList.remove("visible");
    setTimeout(() => { transitioning = false; }, 1200);
  }

  function finish() {
    overlay.style.transition = "opacity .5s";
    overlay.style.opacity = "0";
    setTimeout(() => {
      overlay.remove();
      if (typeof onDone === "function") onDone();
    }, 500);
  }

  // Auto-advance every 3.5s, stop on last slide
  let autoTimer = setInterval(() => {
    if (current < slides.length - 1) goTo(current + 1);
    else clearInterval(autoTimer);
  }, 3500);

  // Click anywhere to advance (except CTA/skip)
  overlay.addEventListener("click", (e) => {
    if (e.target === cta || e.target === skip) return;
    if (current < slides.length - 1) {
      clearInterval(autoTimer);
      goTo(current + 1);
    }
  });

  cta.addEventListener("click", () => { clearInterval(autoTimer); finish(); });
  skip.addEventListener("click", () => { clearInterval(autoTimer); finish(); });
}

// --- Settings panel ---
document.getElementById("settingsBtn").addEventListener("click", async () => {
  try {
    const s = await window.herAPI.getSettings();
    document.getElementById("settingsApiKey").value = s.apiKey || "";
    document.getElementById("settingsBaseUrl").value = s.baseURL || "";
    document.getElementById("settingsModel").value = s.model || "";
    document.getElementById("settingsMsg").textContent = "";
  } catch (_) {}
  settingsOverlay.classList.add("open");
});

document.getElementById("settingsClose").addEventListener("click", () => {
  settingsOverlay.classList.remove("open");
});

settingsOverlay.addEventListener("click", (e) => {
  if (e.target === settingsOverlay) settingsOverlay.classList.remove("open");
});

document.getElementById("settingsSave").addEventListener("click", async () => {
  const btn = document.getElementById("settingsSave");
  const msgEl = document.getElementById("settingsMsg");
  btn.disabled = true;
  msgEl.textContent = "";
  try {
    await window.herAPI.saveSettings({
      apiKey: document.getElementById("settingsApiKey").value.trim(),
      baseURL: document.getElementById("settingsBaseUrl").value.trim(),
      model: document.getElementById("settingsModel").value.trim(),
    });
    msgEl.textContent = "已保存";
    setTimeout(() => { settingsOverlay.classList.remove("open"); }, 800);
  } catch (e) {
    msgEl.textContent = e.message || "保存失败";
    msgEl.style.color = "#f87171";
  }
  btn.disabled = false;
});

async function bootstrapApp() {
  try {
    window.herAPI.onEvent(handle);
    const bootstrap = await window.herAPI.bootstrap();
    currentPresence = bootstrap.presence || getFallbackPresence();
    currentRelationshipSetup = bootstrap.onboarding || {
      needsSetup: Boolean(currentPresence.needsRelationshipSetup),
      profile: currentPresence.relationshipProfile || null,
    };
    setStatusConnected();
    setModelDisplay(bootstrap.model);
    if (bootstrap.messages && bootstrap.messages.length > 0) handle({ type: "restore", messages: bootstrap.messages });
    else if (currentRelationshipSetup.needsSetup) {
      const afterApiKey = () => renderRelationshipSetup(currentRelationshipSetup);
      const afterOnboarding = currentRelationshipSetup.needsApiKey
        ? () => showApiKeySetup(afterApiKey)
        : afterApiKey;
      showOnboarding(afterOnboarding);
    }
    else if (currentRelationshipSetup.needsApiKey) showApiKeySetup(() => renderPresenceHome(currentPresence));
    else renderPresenceHome(currentPresence);
    refreshPassiveContext({ rerender: true }).catch(() => {});
    handle({ type: "client_status", ...bootstrap.status });
    if (bootstrap.usage && (bootstrap.usage.input_tokens || bootstrap.usage.output_tokens)) {
      handle({
        type: "usage",
        input_tokens: bootstrap.usage.input_tokens,
        output_tokens: bootstrap.usage.output_tokens,
        total_cost: bootstrap.usage.total_cost || "0.0000",
      });
    }
  } catch (error) {
    statusDot.className = "hd-dot offline";
    handle({ type: "error", text: error.message || "应用初始化失败" });
  }
}

bootstrapApp();
