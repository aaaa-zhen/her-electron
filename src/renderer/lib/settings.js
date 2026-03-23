/* --- Settings panel & onboarding --- */

/** Render a QR code onto a canvas using a lightweight API */
function renderQrToCanvas(canvas, text) {
  const size = 200;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, size, size);
  // Use qrserver.com free API to generate QR image
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => ctx.drawImage(img, 0, 0, size, size);
  img.onerror = () => {
    // Fallback: show the URL as text
    ctx.fillStyle = "#000";
    ctx.font = "11px sans-serif";
    ctx.fillText("扫码链接:", 10, 30);
    ctx.fillText(text.slice(0, 30), 10, 50);
    ctx.fillText(text.slice(30, 60), 10, 70);
  };
  img.src = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(text)}`;
}

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
    { icon: "i-heart", headline: "聊过的事，我<span class=\"accent\">都记得</span>", sub: "不用翻记录，不用重新解释。\n你说过什么、最近在忙什么，我都在。" },
    { icon: "i-sparkles", headline: "你喜欢我<span class=\"accent\">怎么陪你</span>", sub: "话多还是话少，主动还是安静——\n你说了算，剩下的我慢慢学。" },
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

  const cta = document.createElement("button");
  cta.className = "onboarding-cta visible";
  cta.innerHTML = `<span class="cta-inner"><svg><use href="#i-sparkles"/></svg>开始</span>`;
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
    allSlides[current].classList.remove("active");
    allSlides[current].classList.add("exit");
    allSlides[index].classList.remove("exit");
    void allSlides[index].offsetWidth;
    allSlides[index].classList.add("active");
    current = index;
    const ctaLabel = cta.querySelector(".cta-inner");
    if (current === slides.length - 1) {
      ctaLabel.innerHTML = `<svg><use href="#i-sparkles"/></svg>好，开始吧`;
    } else {
      ctaLabel.innerHTML = `<svg><use href="#i-sparkles"/></svg>继续`;
    }
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
    if (e.target === cta || cta.contains(e.target) || e.target === skip) return;
    if (current < slides.length - 1) { clearInterval(autoTimer); goTo(current + 1); }
  });

  cta.addEventListener("click", () => {
    clearInterval(autoTimer);
    if (current < slides.length - 1) goTo(current + 1);
    else finish();
  });
  skip.addEventListener("click", () => { clearInterval(autoTimer); finish(); });
}

const PROVIDER_PRESETS = {
  packy: { baseURL: "https://www.packyapi.com", models: [
    { value: "claude-opus-4-6", label: "Claude Opus 4.6 · 最强、深度推理" },
    { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 · 均衡、高性价比" },
    { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5 · 快速、低成本" },
  ]},
  kimi: { baseURL: "https://api.moonshot.cn/v1", models: [
    { value: "kimi-k2-turbo-preview", label: "Kimi K2 Turbo · 快速、高性价比" },
    { value: "kimi-k2.5", label: "Kimi K2.5 · 最强、更深度思考" },
  ]},
  custom: { baseURL: "", models: [] },
};

function switchProvider(provider) {
  const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.custom;
  const baseURLGroup = document.getElementById("settingsBaseURLGroup");
  const baseURLInput = document.getElementById("settingsBaseURL");
  const modelSelectWrap = document.getElementById("settingsModelSelectWrap");
  const modelInputWrap = document.getElementById("settingsModelInputWrap");
  const modelSelect = document.getElementById("settingsModel");
  const modelHint = document.getElementById("settingsModelHint");

  if (provider === "custom") {
    baseURLGroup.style.display = "";
    modelSelectWrap.style.display = "none";
    modelInputWrap.style.display = "";
    modelHint.textContent = "填写模型完整名称";
  } else {
    baseURLGroup.style.display = "none";
    baseURLInput.value = preset.baseURL;
    modelSelectWrap.style.display = "";
    modelInputWrap.style.display = "none";
    modelSelect.innerHTML = preset.models.map((m) =>
      `<option value="${m.value}">${m.label}</option>`
    ).join("");
    modelHint.textContent = "";
  }
}

function initSettingsPanel() {
  const settingsOverlay = document.getElementById("settingsOverlay");
  const apiKeyInput = document.getElementById("settingsApiKey");
  const providerSelect = document.getElementById("settingsProvider");

  providerSelect.addEventListener("change", () => switchProvider(providerSelect.value));

  document.getElementById("settingsBtn").addEventListener("click", async () => {
    try {
      const s = await window.herAPI.getSettings();
      apiKeyInput.value = s.apiKey || "";
      // Detect provider from baseURL
      const baseURL = s.baseURL || "";
      let detectedProvider = "packy";
      if (baseURL.includes("packyapi.com")) detectedProvider = "packy";
      else if (baseURL.includes("moonshot.cn")) detectedProvider = "kimi";
      else if (baseURL) detectedProvider = "custom";
      providerSelect.value = detectedProvider;
      switchProvider(detectedProvider);
      if (detectedProvider === "custom") {
        document.getElementById("settingsBaseURL").value = baseURL;
        document.getElementById("settingsModelCustom").value = s.model || "";
      } else {
        document.getElementById("settingsModel").value = s.model || PROVIDER_PRESETS[detectedProvider].models[0].value;
      }
      document.getElementById("settingsSearchApiKey").value = s.searchApiKey || "";
      document.getElementById("settingsMsg").textContent = "";
    } catch (_) {}
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
      const provider = providerSelect.value;
      const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.custom;
      const model = provider === "custom"
        ? document.getElementById("settingsModelCustom").value.trim()
        : document.getElementById("settingsModel").value.trim();
      const baseURL = provider === "custom"
        ? document.getElementById("settingsBaseURL").value.trim()
        : preset.baseURL;

      const payload = { model };
      if (baseURL) payload.baseURL = baseURL;

      const key = apiKeyInput.value.trim();
      if (key && !key.includes("...")) {
        payload.apiKey = key;
      } else if (!key) {
        payload.apiKey = "__clear__";
      }

      const searchKey = document.getElementById("settingsSearchApiKey").value.trim();
      if (searchKey && !searchKey.includes("...")) {
        payload.searchApiKey = searchKey;
      } else if (!searchKey) {
        payload.searchApiKey = "__clear__";
      }

      const result = await window.herAPI.saveSettings(payload);
      if (result.connected) {
        msgEl.textContent = "已保存 · 连接成功 ✓";
        msgEl.style.color = "#4ade80";
      } else if (result.connected === false) {
        const hint = result.error || "请检查 API Key 和所选模型是否匹配";
        msgEl.textContent = "已保存 · 连接失败：" + hint;
        msgEl.style.color = "#f87171";
      } else {
        msgEl.textContent = "已保存";
        msgEl.style.color = "";
      }
      // Update bottom bar model display
      if (typeof window.setModelDisplay === "function") {
        window.setModelDisplay(payload.model);
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

  // ── WeChat ──

  const weixinLoginBtn = document.getElementById("weixinLoginBtn");
  const weixinDisconnectBtn = document.getElementById("weixinDisconnectBtn");
  const weixinStatusText = document.getElementById("weixinStatusText");
  const weixinDot = document.getElementById("weixinDot");
  const weixinQrWrap = document.getElementById("weixinQrWrap");

  function updateWeixinUI(status, extra) {
    if (status === "connected") {
      weixinDot.style.background = "#4ade80";
      weixinStatusText.textContent = "已连接";
      weixinStatusText.style.color = "#4ade80";
      weixinLoginBtn.style.display = "none";
      weixinDisconnectBtn.style.display = "";
      weixinQrWrap.style.display = "none";
    } else if (status === "qr_scanned") {
      weixinDot.style.background = "#facc15";
      weixinStatusText.textContent = "已扫码，请在微信上确认...";
      weixinStatusText.style.color = "#facc15";
      weixinLoginBtn.style.display = "none";
      weixinDisconnectBtn.style.display = "none";
    } else if (status === "qr_pending") {
      weixinDot.style.background = "#facc15";
      weixinStatusText.textContent = "等待扫码...";
      weixinStatusText.style.color = "#facc15";
      weixinLoginBtn.style.display = "none";
      weixinDisconnectBtn.style.display = "none";
    } else {
      weixinDot.style.background = "#666";
      weixinStatusText.textContent = extra ? `未连接 · ${extra}` : "未连接";
      weixinStatusText.style.color = "";
      weixinLoginBtn.style.display = "";
      weixinLoginBtn.textContent = "连接微信";
      weixinLoginBtn.disabled = false;
      weixinDisconnectBtn.style.display = "none";
      weixinQrWrap.style.display = "none";
    }
  }

  // Load initial status when settings open
  document.getElementById("settingsBtn").addEventListener("click", () => {
    window.herAPI.weixinStatus().then((res) => {
      updateWeixinUI(res.status, res.accountId);
    }).catch(() => {});
  });

  // Listen for status updates from main process (including QR code)
  if (!window._weixinEventBound) {
    window._weixinEventBound = true;
    window.herAPI.onEvent((event) => {
      if (event.type === "weixin_status") {
        updateWeixinUI(event.status, event.accountId || event.error);
        // Show QR code if we got a URL to encode
        if (event.qrUrl) {
          weixinQrWrap.style.display = "";
          const canvas = document.getElementById("weixinQrCanvas");
          if (canvas) {
            renderQrToCanvas(canvas, event.qrUrl);
          }
        }
      }
    });
  }

  weixinLoginBtn.addEventListener("click", async () => {
    weixinLoginBtn.disabled = true;
    weixinLoginBtn.textContent = "正在连接...";
    weixinStatusText.textContent = "正在获取二维码...";
    weixinStatusText.style.color = "#facc15";

    try {
      const result = await window.herAPI.weixinLogin();
      if (result.success) {
        updateWeixinUI("connected", result.accountId);
      } else {
        updateWeixinUI("disconnected", result.error);
      }
    } catch (e) {
      updateWeixinUI("disconnected", e.message);
    }
  });

  weixinDisconnectBtn.addEventListener("click", async () => {
    await window.herAPI.weixinDisconnect();
    updateWeixinUI("disconnected");
  });

  // ── Update check ──

  const checkUpdateBtn = document.getElementById("checkUpdateBtn");
  const updateStatus = document.getElementById("updateStatus");
  const updateVersionText = document.getElementById("updateVersionText");

  // Show current version on settings open
  const origSettingsClick = document.getElementById("settingsBtn")._herSettingsInited;
  if (!origSettingsClick) {
    document.getElementById("settingsBtn")._herSettingsInited = true;
    document.getElementById("settingsBtn").addEventListener("click", () => {
      updateStatus.textContent = "";
      checkUpdateBtn.textContent = "检查更新";
      checkUpdateBtn.disabled = false;
      window.herAPI.checkUpdate().then((res) => {
        updateVersionText.textContent = `当前版本：v${res.currentVersion}`;
      }).catch(() => {});
    });
  }

  checkUpdateBtn.addEventListener("click", async () => {
    checkUpdateBtn.disabled = true;
    checkUpdateBtn.textContent = "检查中...";
    updateStatus.textContent = "";
    updateStatus.style.color = "";
    try {
      const res = await window.herAPI.checkUpdate();
      updateVersionText.textContent = `当前版本：v${res.currentVersion}`;
      if (res.error) {
        updateStatus.textContent = `检查失败：${res.error}`;
        updateStatus.style.color = "#f87171";
        checkUpdateBtn.textContent = "重试";
      } else if (res.hasUpdate) {
        updateStatus.innerHTML = `<span style="color:#16a34a;font-weight:600">发现新版本 v${res.latestVersion}</span>`;
        if (res.changelog) {
          updateStatus.innerHTML += `<br><span style="color:var(--text2);font-size:11px">${res.changelog}</span>`;
        }
        checkUpdateBtn.textContent = "下载更新";
        checkUpdateBtn.onclick = () => {
          if (res.downloadUrl) window.herAPI.openUrl(res.downloadUrl);
        };
      } else {
        updateStatus.textContent = "已是最新版本";
        updateStatus.style.color = "#16a34a";
        checkUpdateBtn.textContent = "检查更新";
      }
    } catch (e) {
      updateStatus.textContent = `检查失败：${e.message}`;
      updateStatus.style.color = "#f87171";
      checkUpdateBtn.textContent = "重试";
    }
    checkUpdateBtn.disabled = false;
  });
}
