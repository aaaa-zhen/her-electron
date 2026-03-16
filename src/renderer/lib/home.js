/* --- Home screen / presence rendering --- */

const RELATIONSHIP_SETUP_OPTIONS = {
  tone: [
    { value: "简洁直接", description: "抓重点，少一点客套", icon: "#i-zap" },
    { value: "温柔一点", description: "更柔和，更像被接住", icon: "#i-heart" },
    { value: "像朋友聊天", description: "自然、轻松、有人味", icon: "#i-chat", popular: true },
    { value: "像搭子一起推进", description: "边聊边做，别太端着", icon: "#i-sparkles" },
  ],
  relationshipMode: [
    { value: "长期陪伴者", description: "更像一直在的人", icon: "#i-heart", popular: true },
    { value: "朋友搭子", description: "熟一点，轻一点", icon: "#i-chat" },
    { value: "做事助手", description: "以推进事务为主", icon: "#i-zap" },
  ],
  proactivity: [
    { value: "主动提醒我", description: "你可以更主动接续我", icon: "#i-bell" },
    { value: "适度主动", description: "有判断地提醒，不要太频繁", icon: "#i-check", popular: true },
    { value: "尽量少打扰", description: "主要等我叫你", icon: "#i-clock" },
  ],
};

const SETUP_STEPS = [
  { group: "tone", title: "选择说话风格", subtitle: "我先用什么样的方式陪你，会让你更舒服？" },
  { group: "relationshipMode", title: "选择关系模式", subtitle: "在你这边，我更像什么？" },
  { group: "proactivity", title: "选择主动程度", subtitle: "我主动一点，会不会打扰你？" },
];

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
      { label: "回顾今天", prompt: "回顾一下你最近替我完成了什么，并告诉我下一步", description: "先把连续上下文接起来" },
      { label: "做 PPT", prompt: "帮我做一个PPT", description: "生成精美演示文稿" },
      { label: "做表格", prompt: "帮我做一个Excel表格", description: "生成 Excel 表格和图表" },
      { label: "找回文件", prompt: "把我最近处理过的文件和图片列出来", description: "看看最近留下了哪些数字物料" },
      { label: "下载视频", prompt: "帮我下载一个视频", description: "从网页链接下载视频到本地" },
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
  window.herAPI.getProfile().catch(() => null).then((profileData) => updateHomeProfile(profileData));
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
  window.herAPI.getBrowserDigest().catch(() => null).then((digestData) => updateHomeBrowserDigest(digestData));
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
  window.herAPI.getTodos().catch(() => []).then((todos) => updateHomeTodos(todos));
}

function loadHomeNewsBriefing() {
  const section = document.getElementById("home-briefing-section");
  if (!section) return;
  window.herAPI.getNewsBriefing().catch(() => null).then((config) => renderNewsBriefingCard(section, config));
}

function renderNewsBriefingCard(section, config) {
  const enabled = config && config.enabled;
  if (!enabled) {
    section.innerHTML = "";
    section.style.display = "none";
    return;
  }
  section.style.display = "";
  const hour = (config && config.hour) || 9;
  const minute = (config && config.minute) || 0;
  const timeStr = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const HOUR_OPTIONS = [7, 8, 9, 10, 11];
  const hourChips = HOUR_OPTIONS.map((h) => `<button class="briefing-hour${h === hour ? " active" : ""}" data-h="${h}">${String(h).padStart(2, "0")}:00</button>`).join("");

  if (enabled) {
    section.innerHTML = `
      <div class="presence-section-title"><svg><use href="#i-globe"/></svg>每日早报</div>
      <div class="briefing-card">
        <div class="briefing-status-row"><div class="briefing-status-dot"></div>
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
      <span class="setup-option-icon"><svg width="20" height="20"><use href="${item.icon}"/></svg></span>
      <span class="setup-option-text">
        <span class="setup-option-title">${esc(item.value)}${item.popular ? '<span class="setup-popular">推荐</span>' : ""}</span>
        <span class="setup-option-desc">${esc(item.description)}</span>
      </span>
      <span class="setup-option-check"><svg width="18" height="18"><use href="#i-check"/></svg></span>
    </button>
  `).join("");
}
