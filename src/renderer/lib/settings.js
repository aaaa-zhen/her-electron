/* --- Settings panel & onboarding --- */

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
    { icon: "i-clock", headline: "工业革命让我们<span class=\"accent\">围着时钟</span>转", sub: "日程表、闹钟、倒计时——我们把生活切成了一格一格。" },
    { icon: "i-globe", headline: "你不用再每次都<span class=\"accent\">从头解释自己</span>", sub: "我会慢慢记住你的语气、你最近在忙的事，还有那些你没说完的话。" },
    { icon: "i-brain", headline: "我不只是<span class=\"accent\">回答你</span>", sub: "你发给我的图片、文件、提醒，还有今天发生过的事，我会把它们接成同一条线。" },
    { icon: "i-heart", headline: "Her 会越来越像那个<span class=\"accent\">懂你的人</span>", sub: "不是因为我拿到了很多数据，而是因为我会在时间里慢慢认识你。" },
    { icon: "i-sparkles", headline: "开始之前，先让我<span class=\"accent\">认识你一点点</span>", sub: "你告诉我你喜欢我怎么陪你。剩下的，我会慢慢学。" },
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
    dot.style.cursor = "pointer";
    dot.addEventListener("click", () => goTo(i));
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
    void allSlides[index].offsetWidth;
    allSlides[index].classList.add("active");
    allDots[current].classList.remove("active");
    allDots[index].classList.add("active");
    current = index;
    if (current === slides.length - 1) cta.classList.add("visible");
    else cta.classList.remove("visible");
    setTimeout(() => { transitioning = false; }, 1200);
  }

  function finish() {
    overlay.style.transition = "opacity .5s";
    overlay.style.opacity = "0";
    setTimeout(() => { overlay.remove(); if (typeof onDone === "function") onDone(); }, 500);
  }

  let autoTimer = setInterval(() => {
    if (current < slides.length - 1) goTo(current + 1);
    else clearInterval(autoTimer);
  }, 3500);

  overlay.addEventListener("click", (e) => {
    if (e.target === cta || e.target === skip) return;
    if (current < slides.length - 1) { clearInterval(autoTimer); goTo(current + 1); }
  });

  cta.addEventListener("click", () => { clearInterval(autoTimer); finish(); });
  skip.addEventListener("click", () => { clearInterval(autoTimer); finish(); });
}

function initSettingsPanel() {
  const settingsOverlay = document.getElementById("settingsOverlay");

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
      const apiKeyVal = document.getElementById("settingsApiKey").value.trim();
      const payload = {
        baseURL: document.getElementById("settingsBaseUrl").value.trim(),
        model: document.getElementById("settingsModel").value.trim(),
      };
      // Only send apiKey if user actually typed a new one (not the masked placeholder)
      if (apiKeyVal && !apiKeyVal.includes("...")) {
        payload.apiKey = apiKeyVal;
      }
      await window.herAPI.saveSettings(payload);
      msgEl.textContent = "已保存";
      msgEl.style.color = "";
      setTimeout(() => { settingsOverlay.classList.remove("open"); }, 800);
    } catch (e) {
      msgEl.textContent = e.message || "保存失败";
      msgEl.style.color = "#f87171";
    }
    btn.disabled = false;
  });
}
