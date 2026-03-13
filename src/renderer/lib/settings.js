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

async function refreshPairUI() {
  try {
    const status = await window.herAPI.getPairStatus();
    const unpaired = document.getElementById("pairUnpaired");
    const paired = document.getElementById("pairPaired");
    if (status.paired) {
      unpaired.style.display = "none";
      paired.style.display = "";
      const statusText = document.getElementById("pairStatusText");
      statusText.textContent = status.connected
        ? `✓ 已连接 · ${status.deviceName}`
        : `等待手机扫码连接…`;
      statusText.style.color = status.connected ? "#4ade80" : "";
      // Re-generate QR if no image shown yet
      if (!paired.querySelector("img")) {
        const qrContainer = document.getElementById("pairQrContainer");
        qrContainer.innerHTML = `<div style="color:var(--text3);font-size:13px">已配对，重新生成请先断开</div>`;
      }
    } else {
      unpaired.style.display = "";
      paired.style.display = "none";
    }
  } catch (_) {}
}

function detectProvider(model, baseURL) {
  if (model && model.startsWith("deepseek")) return "deepseek";
  if (baseURL && baseURL.includes("deepseek.com")) return "deepseek";
  return "anthropic";
}

function syncProviderUI(provider) {
  const baseUrlSelect = document.getElementById("settingsBaseUrl");
  const baseUrlHint = document.getElementById("baseUrlHint");
  const modelGroupAnthropic = document.getElementById("modelGroupAnthropic");
  const modelGroupDeepSeek = document.getElementById("modelGroupDeepSeek");

  if (provider === "deepseek") {
    // Show only DeepSeek base URLs
    for (const opt of baseUrlSelect.options) {
      opt.hidden = !opt.value.includes("deepseek.com");
    }
    baseUrlSelect.value = "https://api.deepseek.com";
    baseUrlHint.textContent = "DeepSeek 官方 API";
    modelGroupAnthropic.hidden = true;
    modelGroupDeepSeek.hidden = false;
    // Auto-select first DeepSeek model if current is not DeepSeek
    const modelSelect = document.getElementById("settingsModel");
    if (!modelSelect.value.startsWith("deepseek")) {
      modelSelect.value = "deepseek-chat";
    }
  } else {
    for (const opt of baseUrlSelect.options) {
      opt.hidden = opt.value.includes("deepseek.com");
    }
    if (baseUrlSelect.value.includes("deepseek.com")) {
      baseUrlSelect.value = "https://www.packyapi.com";
    }
    baseUrlHint.textContent = "中转站无需翻墙，官方线路需自备梯子";
    modelGroupAnthropic.hidden = false;
    modelGroupDeepSeek.hidden = true;
    const modelSelect = document.getElementById("settingsModel");
    if (modelSelect.value.startsWith("deepseek")) {
      modelSelect.value = "";
    }
  }
}

function initSettingsPanel() {
  const settingsOverlay = document.getElementById("settingsOverlay");

  document.getElementById("settingsProvider").addEventListener("change", (e) => {
    syncProviderUI(e.target.value);
  });

  document.getElementById("settingsBtn").addEventListener("click", async () => {
    try {
      const s = await window.herAPI.getSettings();
      document.getElementById("settingsApiKey").value = s.apiKey || "";

      // Detect provider from saved model/baseURL
      const provider = detectProvider(s.model, s.baseURL);
      document.getElementById("settingsProvider").value = provider;
      syncProviderUI(provider);

      const baseUrlSelect = document.getElementById("settingsBaseUrl");
      if (s.baseURL) baseUrlSelect.value = s.baseURL;
      if (!baseUrlSelect.value) {
        baseUrlSelect.value = provider === "deepseek" ? "https://api.deepseek.com" : "https://www.packyapi.com";
      }
      document.getElementById("settingsModel").value = s.model || "";
      document.getElementById("settingsMsg").textContent = "";
    } catch (_) {}
    refreshPairUI();
    settingsOverlay.classList.add("open");
  });

  document.getElementById("settingsClose").addEventListener("click", () => {
    settingsOverlay.classList.remove("open");
  });

  // Toggle API key visibility
  document.getElementById("toggleApiKey").addEventListener("click", () => {
    const input = document.getElementById("settingsApiKey");
    const icon = document.getElementById("eyeIcon");
    if (input.type === "password") {
      input.type = "text";
      icon.innerHTML = '<path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46A11.8 11.8 0 001 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z"/>';
    } else {
      input.type = "password";
      icon.innerHTML = '<path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>';
    }
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
      const result = await window.herAPI.saveSettings(payload);
      if (result.connected) {
        msgEl.textContent = "已保存 · 连接成功 ✓";
        msgEl.style.color = "#4ade80";
      } else if (result.connected === false) {
        msgEl.textContent = "已保存 · 连接失败：" + (result.error || "请检查 API Key");
        msgEl.style.color = "#f87171";
      } else {
        msgEl.textContent = "已保存";
        msgEl.style.color = "";
      }
      if (result.connected) {
        setTimeout(() => { settingsOverlay.classList.remove("open"); }, 1500);
      }
    } catch (e) {
      msgEl.textContent = e.message || "保存失败";
      msgEl.style.color = "#f87171";
    }
    btn.disabled = false;
  });

  // ── Pairing ──

  // Store pairing result for tab switching
  let pairResult = null;
  let iphoneQrCache = null;

  function showAndroidQr() {
    const qrContainer = document.getElementById("pairQrContainer");
    const statusText = document.getElementById("pairStatusText");
    document.getElementById("pairShowAndroid").style.background = "#6ee7b7";
    document.getElementById("pairShowAndroid").style.color = "#000";
    document.getElementById("pairShowiPhone").style.background = "#333";
    document.getElementById("pairShowiPhone").style.color = "#fff";
    if (pairResult && pairResult.qrImage) {
      qrContainer.innerHTML = `<img src="${pairResult.qrImage}" style="width:200px;height:200px;border-radius:8px;image-rendering:pixelated">`;
      statusText.textContent = "用 Her Android 扫描此二维码";
    } else {
      qrContainer.innerHTML = `<div style="color:var(--text3);font-size:13px">已配对</div>`;
      statusText.textContent = "";
    }
  }

  async function showIphoneQr() {
    const qrContainer = document.getElementById("pairQrContainer");
    const statusText = document.getElementById("pairStatusText");
    document.getElementById("pairShowiPhone").style.background = "#6ee7b7";
    document.getElementById("pairShowiPhone").style.color = "#000";
    document.getElementById("pairShowAndroid").style.background = "#333";
    document.getElementById("pairShowAndroid").style.color = "#fff";
    qrContainer.innerHTML = `<div style="color:#888;font-size:13px">生成中...</div>`;
    try {
      if (!iphoneQrCache) iphoneQrCache = await window.herAPI.getIphoneQr();
      qrContainer.innerHTML = `<img src="${iphoneQrCache.qrImage}" style="width:200px;height:200px;border-radius:8px;image-rendering:pixelated">`;
      statusText.textContent = "iPhone 相机扫码 → 打开链接 → 安装快捷指令";
    } catch (e) {
      qrContainer.innerHTML = `<div style="color:#f87171;font-size:13px">${e.message}</div>`;
      statusText.textContent = "";
    }
  }

  document.getElementById("pairShowAndroid").addEventListener("click", showAndroidQr);
  document.getElementById("pairShowiPhone").addEventListener("click", showIphoneQr);

  document.getElementById("pairGenerate").addEventListener("click", async () => {
    const btn = document.getElementById("pairGenerate");
    btn.disabled = true;
    btn.textContent = "生成中...";
    try {
      pairResult = await window.herAPI.generatePair();
      iphoneQrCache = null; // reset iPhone QR cache
      document.getElementById("pairUnpaired").style.display = "none";
      document.getElementById("pairPaired").style.display = "";
      showAndroidQr();
    } catch (e) {
      toast(`配对失败: ${e.message}`);
    }
    btn.disabled = false;
    btn.textContent = "生成连接码";
  });

  document.getElementById("pairRevoke").addEventListener("click", async () => {
    if (!confirm("断开后手机将无法连接，确定吗？")) return;
    const btn = document.getElementById("pairRevoke");
    btn.disabled = true;
    try {
      await window.herAPI.revokePair();
      document.getElementById("pairPaired").style.display = "none";
      document.getElementById("pairUnpaired").style.display = "";
      document.getElementById("pairQrContainer").innerHTML = "";
      toast("已断开手机连接");
    } catch (e) {
      toast(`断开失败: ${e.message}`);
    }
    btn.disabled = false;
  });
}
