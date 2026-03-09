/* --- Main app: bootstrap, event handler, send, event listeners --- */

const msgList = document.getElementById("msgList");
const messagesEl = document.getElementById("messages");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");

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

// --- Scroll & new-message tracking ---

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

// --- Streaming ---

function finishCmd() {
  if (!currentCmd) return;
  const spinner = currentCmd.querySelector(".cmd-spinner");
  if (spinner) spinner.outerHTML = '<svg class="cmd-icon done"><use href="#i-check"/></svg>';
  currentCmd = null;
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
  if (streamTimer) { clearTimeout(streamTimer); streamTimer = null; }
  if (streamEl && streamBuf) finalizeStreamMarkup();
  if (streamEl) streamEl.classList.remove("typing-cursor");
  if (streamGroup) streamGroup.classList.remove("streaming", "fade-in");
  streamEl = null;
  streamBuf = "";
  currentCmd = null;
  setGenerating(false);
  scrollDown();
}

// --- Message group management ---

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
  if (currentPhaseEl) { currentPhaseEl.remove(); currentPhaseEl = null; }
}

function removeThinking() {
  if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
}

// --- Timestamps ---

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

// --- Send button state ---

function updateSendBtn() {
  const has = input.value.trim().length > 0 || getPastedImages().length > 0;
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

// --- Passive context ---

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
    .finally(() => { passiveContextRequest = null; });
  return passiveContextRequest;
}

// --- Send message ---

async function send(text) {
  text = (text || input.value).trim();
  if (!text && getPastedImages().length === 0) return;
  window._firstMeetMode = false;

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
  getPastedImages().forEach((image) => {
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

  let storedImages = getPastedImages();
  try {
    if (storedImages.length > 0) storedImages = await persistPastedImages(storedImages);
  } catch (error) {
    toast(`图片保存失败: ${error.message}`);
  }

  const imageFileNote = storedImages.map((image) => image.filename).filter(Boolean).join(", ");
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
  clearPastedImages();
  document.getElementById("img-previews").innerHTML = "";
  sendBtn.disabled = true;
  sendBtn.classList.remove("active");
}

// --- Relationship setup ---

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
      const result = await window.herAPI.saveRelationshipProfile({ tone, relationshipMode, proactivity, currentFocus });
      currentPresence = result.presence || currentPresence || getFallbackPresence();
      currentRelationshipSetup = result.onboarding || { needsSetup: false, profile: result.profile || null };
      msgList.innerHTML = "";
      window._firstMeetMode = true;
      renderPresenceHome(currentPresence);
      setTimeout(() => {
        window.herAPI.sendMessage({
          message: `[system:first_meet] 这是用户第一次使用 Her。请你现在主动扫描用户的环境来了解他——调用这些工具：
1. apple_notes (action: list) — 看看用户的备忘录
2. apple_reminders (action: list) — 看看用户的待办
3. recent_files (days: 3) — 看看最近在弄什么文件

扫描完成后，用一段温暖、有点调皮的话跟用户打招呼。

要求：
- 调用工具时不要输出任何文字，不要说"让我看看"、"好，我来扫描"之类的话
- 只在拿到所有工具结果之后，才输出一段话
- 绝对不要直接引用用户的任何具体内容（文件名、备忘录原文、提醒标题等）。这会让用户感觉被偷看、被裸露在别人面前
- 而是通过你知道的这些内容，用模糊、感性、温暖的方式表达你的感知。比如不要说"你备忘录里写了xxx"，而是说"感觉你最近在认真做一件自己真正想做的事"
- 像一个有灵性的人，不说"我看了你的文件"，而是说"我有种感觉……"
- 用直觉式的、带温度的话去描述你感知到的用户画像
- 最后留一个轻轻的钩子，让用户好奇想追问，但不要太直接
- 控制在 150 字以内，少即是多
- 用中文`,
        });
      }, 500);
    } catch (error) {
      button.disabled = false;
      button.textContent = "好，我记住了";
      toast(`保存失败: ${error.message}`);
    }
  });

  msgList.appendChild(welcome);
  scrollDown();
}

// --- Presence home ---

function renderPresenceHome(presence = currentPresence || getFallbackPresence(), options = {}) {
  if (presence && presence.needsRelationshipSetup) {
    renderRelationshipSetup(currentRelationshipSetup || { needsSetup: true, profile: presence.relationshipProfile || null });
    return;
  }
  currentPresence = presence;
  msgList.innerHTML = "";
  const welcome = document.createElement("div");
  welcome.className = "welcome presence-home";
  welcome.id = "welcome";

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

  fillHomeCalendar(currentPassiveContext.calendar);
  if (!options.skipContextRefresh) {
    refreshPassiveContext().then(() => fillHomeCalendar(currentPassiveContext.calendar)).catch(() => {});
  }
}

// --- Notification bars ---

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
  setTimeout(() => { if (bar.parentNode) bar.remove(); }, 22000);
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
  bar.querySelector('[data-action="dismiss"]').addEventListener("click", () => bar.remove());
  const inputArea = document.getElementById("input-area");
  inputArea.insertBefore(bar, inputArea.firstChild);
  setTimeout(() => { if (bar.parentNode) bar.remove(); }, 18000);
}

window.addEventListener("focus", () => {
  const old = document.getElementById("browser-offer");
  if (old) old.remove();
});

// --- Event handler ---

function handle(data) {
  if (window._firstMeetMode) {
    if (data.type === "phase" || data.type === "command" || data.type === "command_output" || data.type === "thinking") return;
  }

  if (data.type === "phase") {
    if (data.clear) removePhase();
    else { setPhase(data); scrollDown(); }
    return;
  }

  if (data.type === "thinking") {
    removeThinking();
    if (streamEl && streamBuf) {
      if (streamTimer) { clearTimeout(streamTimer); streamTimer = null; }
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
    removePhase(); finishCmd(); endStream(); finalizeHerGroup();
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

  if (data.type === "memory_saved") { toast(`已记住: ${data.key}`); return; }

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

  if (data.type === "open-file") { send(`帮我看看这个文件: ${data.filePath}`); return; }
  if (data.type === "context_reminder") { showContextReminder(data.reminder || {}); return; }
  if (data.type === "browser_companion_offer") { showBrowserOffer(data.offer || {}); return; }
  if (data.type === "browser_history_digest") { if (document.getElementById("home-browser-digest")) loadHomeBrowserDigest(); return; }

  if (data.type === "pin-changed") {
    document.getElementById("pinBtn").classList.toggle("pinned", data.pinned);
    return;
  }

  if (data.type === "clear") {
    removePhase(); finalizeHerGroup(); endStream(); removeThinking();
    currentCmd = null;
    document.getElementById("usageDisplay").className = "usage-display";
    if (currentRelationshipSetup && currentRelationshipSetup.needsSetup) renderRelationshipSetup(currentRelationshipSetup);
    else renderPresenceHome(currentPresence || getFallbackPresence());
    sendBtn.disabled = true;
    toast("对话已清空");
    return;
  }

  if (data.type === "schedule_result") {
    removePhase(); finalizeHerGroup();
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
    removePhase(); finishCmd(); removeThinking();
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

// --- Status helpers ---

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

// --- Event listeners ---

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

input.addEventListener("input", () => refreshInputLayout());

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
inputBoxEl.addEventListener("dragover", (event) => { event.preventDefault(); inputBoxEl.classList.add("drag-over"); });
inputBoxEl.addEventListener("dragleave", () => inputBoxEl.classList.remove("drag-over"));
inputBoxEl.addEventListener("drop", (event) => {
  event.preventDefault();
  inputBoxEl.classList.remove("drag-over");
  for (const file of event.dataTransfer.files) {
    if (file.type.startsWith("image/")) addPastedImage(file);
  }
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
    setTimeout(() => { button.disabled = false; }, 120);
  }
});

let resizeTimer = null;
window.addEventListener("resize", () => {
  document.body.classList.add("is-resizing");
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => document.body.classList.remove("is-resizing"), 140);
});

// --- Slash command menu ---

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

  function hideMenu() { menu.classList.remove("open"); }

  function setTarget(target, prefix) {
    if (target === "clear") { input.value = ""; hideMenu(); send("/clear"); return; }
    currentTarget = target;
    badge.innerHTML = `<span class="slash-target-badge"><svg><use href="${target === "server" ? "#i-server" : "#i-monitor"}"/></svg>${prefix.replace(/[\[\] ]/g, "")}<span class="remove" onclick="clearTarget()">✕</span></span>`;
    input.value = "";
    input.placeholder = `在 ${prefix.replace(/[\[\] ]/g, "")} 上做什么...`;
    hideMenu();
    input.focus();
    updateSendBtn();
  }

  window.clearTarget = function () {
    currentTarget = null;
    badge.innerHTML = "";
    input.placeholder = "说点什么...";
    updateSendBtn();
  };

  window.getTargetPrefix = function () {
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
    if (value === "/") { showMenu(); return; }
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
    if (event.key === "ArrowDown") { event.preventDefault(); activeIndex = Math.min(activeIndex + 1, visible.length - 1); visible.forEach((item, index) => item.classList.toggle("active", index === activeIndex)); return; }
    if (event.key === "ArrowUp") { event.preventDefault(); activeIndex = Math.max(activeIndex - 1, 0); visible.forEach((item, index) => item.classList.toggle("active", index === activeIndex)); return; }
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); const selected = visible[activeIndex]; if (selected) setTarget(selected.dataset.target, selected.dataset.prefix); return; }
    if (event.key === "Escape") { hideMenu(); input.value = ""; refreshInputLayout(); }
  });

  document.addEventListener("click", (event) => {
    if (!menu.contains(event.target) && event.target !== input) hideMenu();
  });
}());

// --- Init settings panel & bootstrap ---

initSettingsPanel();

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
      showOnboarding(() => renderRelationshipSetup(currentRelationshipSetup));
    }
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
