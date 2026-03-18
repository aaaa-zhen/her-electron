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

function detectProvider(model, baseURL, deepseekBaseURL, kimiBaseURL) {
  if (model && model.startsWith("deepseek")) return "deepseek";
  if (model && (model.startsWith("kimi") || model.startsWith("moonshot"))) return "kimi";
  if (baseURL && baseURL.includes("deepseek.com")) return "deepseek";
  if (deepseekBaseURL && !deepseekBaseURL.includes("deepseek.com")) return "custom";
  return "anthropic";
}

function syncProviderUI(provider) {
  const baseUrlSelect = document.getElementById("settingsBaseUrl");
  const baseUrlHint = document.getElementById("baseUrlHint");
  const baseUrlGroup = document.getElementById("baseUrlGroup");
  const customBaseUrlGroup = document.getElementById("customBaseUrlGroup");
  const modelGroupAnthropic = document.getElementById("modelGroupAnthropic");
  const modelGroupDeepSeek = document.getElementById("modelGroupDeepSeek");
  const modelGroupKimi = document.getElementById("modelGroupKimi");
  const modelGroupCustom = document.getElementById("modelGroupCustom");

  // Save current base URL to the correct slot before switching
  const prev = baseUrlSelect.dataset.currentProvider || "";
  if (prev === "deepseek") {
    baseUrlSelect.dataset.deepseekUrl = baseUrlSelect.value;
  } else if (prev === "kimi") {
    baseUrlSelect.dataset.kimiUrl = baseUrlSelect.value;
  } else if (prev === "custom") {
    // custom uses its own input
  } else if (prev) {
    baseUrlSelect.dataset.anthropicUrl = baseUrlSelect.value;
  }
  baseUrlSelect.dataset.currentProvider = provider;

  if (provider === "custom") {
    baseUrlGroup.style.display = "none";
    customBaseUrlGroup.style.display = "";
    modelGroupAnthropic.hidden = true;
    modelGroupDeepSeek.hidden = true;
    modelGroupKimi.hidden = true;
    modelGroupCustom.hidden = false;
    const modelSelect = document.getElementById("settingsModel");
    if (modelSelect.value.startsWith("deepseek") || modelSelect.value.startsWith("kimi") || modelSelect.value.startsWith("moonshot")) {
      modelSelect.value = "claude-opus-4-6";
    }
  } else if (provider === "kimi") {
    baseUrlGroup.style.display = "";
    customBaseUrlGroup.style.display = "none";
    for (const opt of baseUrlSelect.options) {
      opt.hidden = !opt.value.includes("moonshot.cn");
    }
    baseUrlSelect.value = baseUrlSelect.dataset.kimiUrl || "https://api.moonshot.cn/v1";
    baseUrlHint.textContent = "Kimi 官方 API (月之暗面)";
    modelGroupAnthropic.hidden = true;
    modelGroupDeepSeek.hidden = true;
    modelGroupKimi.hidden = false;
    modelGroupCustom.hidden = true;
    const modelSelect = document.getElementById("settingsModel");
    if (!modelSelect.value.startsWith("kimi") && !modelSelect.value.startsWith("moonshot")) {
      modelSelect.value = "kimi-latest";
    }
  } else if (provider === "deepseek") {
    baseUrlGroup.style.display = "";
    customBaseUrlGroup.style.display = "none";
    for (const opt of baseUrlSelect.options) {
      opt.hidden = !opt.value.includes("deepseek.com");
    }
    baseUrlSelect.value = baseUrlSelect.dataset.deepseekUrl || "https://api.deepseek.com";
    baseUrlHint.textContent = "DeepSeek 官方 API";
    modelGroupAnthropic.hidden = true;
    modelGroupDeepSeek.hidden = false;
    modelGroupKimi.hidden = true;
    modelGroupCustom.hidden = true;
    const modelSelect = document.getElementById("settingsModel");
    if (!modelSelect.value.startsWith("deepseek")) {
      modelSelect.value = "deepseek-chat";
    }
  } else {
    baseUrlGroup.style.display = "";
    customBaseUrlGroup.style.display = "none";
    for (const opt of baseUrlSelect.options) {
      opt.hidden = opt.value.includes("deepseek.com") || opt.value.includes("moonshot.cn");
    }
    baseUrlSelect.value = baseUrlSelect.dataset.anthropicUrl || "https://www.packyapi.com";
    baseUrlHint.textContent = "中转站无需翻墙，官方线路需自备梯子";
    modelGroupAnthropic.hidden = false;
    modelGroupDeepSeek.hidden = true;
    modelGroupKimi.hidden = true;
    modelGroupCustom.hidden = true;
    const modelSelect = document.getElementById("settingsModel");
    if (modelSelect.value.startsWith("deepseek") || modelSelect.value.startsWith("kimi") || modelSelect.value.startsWith("moonshot")) {
      modelSelect.value = "";
    }
  }
}

function initSettingsPanel() {
  const settingsOverlay = document.getElementById("settingsOverlay");

  const providerSelect = document.getElementById("settingsProvider");
  const apiKeyInput = document.getElementById("settingsApiKey");

  providerSelect.addEventListener("change", (e) => {
    // Save current key back to correct slot before switching
    const prev = e.target._prevProvider || "anthropic";
    if (prev === "deepseek") {
      apiKeyInput.dataset.deepseekKey = apiKeyInput.value;
    } else if (prev === "kimi") {
      apiKeyInput.dataset.kimiKey = apiKeyInput.value;
    } else if (prev === "custom") {
      apiKeyInput.dataset.customKey = apiKeyInput.value;
    } else {
      apiKeyInput.dataset.anthropicKey = apiKeyInput.value;
    }
    e.target._prevProvider = e.target.value;
    // Show new provider's key
    if (e.target.value === "deepseek") {
      apiKeyInput.value = apiKeyInput.dataset.deepseekKey || "";
    } else if (e.target.value === "kimi") {
      apiKeyInput.value = apiKeyInput.dataset.kimiKey || "";
    } else if (e.target.value === "custom") {
      apiKeyInput.value = apiKeyInput.dataset.customKey || "";
    } else {
      apiKeyInput.value = apiKeyInput.dataset.anthropicKey || "";
    }
    syncProviderUI(e.target.value);
  });

  document.getElementById("settingsBtn").addEventListener("click", async () => {
    try {
      const s = await window.herAPI.getSettings();

      // Detect provider from saved model
      const provider = detectProvider(s.model, s.anthropicBaseURL || s.baseURL, s.deepseekBaseURL, s.kimiBaseURL);
      providerSelect.value = provider;
      providerSelect._prevProvider = provider;
      syncProviderUI(provider);

      // Store per-provider keys in data attributes
      apiKeyInput.dataset.anthropicKey = s.anthropicApiKey || s.apiKey || "";
      apiKeyInput.dataset.deepseekKey = s.deepseekApiKey || "";
      apiKeyInput.dataset.kimiKey = s.kimiApiKey || "";
      apiKeyInput.dataset.customKey = s.customApiKey || "";
      // Show active provider's key
      if (provider === "deepseek") {
        apiKeyInput.value = apiKeyInput.dataset.deepseekKey;
      } else if (provider === "kimi") {
        apiKeyInput.value = apiKeyInput.dataset.kimiKey;
      } else if (provider === "custom") {
        apiKeyInput.value = apiKeyInput.dataset.customKey;
        document.getElementById("settingsCustomBaseUrl").value = s.deepseekBaseURL || "";
      } else {
        apiKeyInput.value = apiKeyInput.dataset.anthropicKey;
      }

      // Seed per-provider base URL data attributes
      const baseUrlSelect = document.getElementById("settingsBaseUrl");
      baseUrlSelect.dataset.anthropicUrl = s.anthropicBaseURL || s.baseURL || "https://www.packyapi.com";
      baseUrlSelect.dataset.deepseekUrl = s.deepseekBaseURL || "https://api.deepseek.com";
      baseUrlSelect.dataset.kimiUrl = s.kimiBaseURL || "https://api.moonshot.cn/v1";
      baseUrlSelect.dataset.currentProvider = provider;
      if (provider === "deepseek") {
        baseUrlSelect.value = baseUrlSelect.dataset.deepseekUrl;
      } else if (provider === "kimi") {
        baseUrlSelect.value = baseUrlSelect.dataset.kimiUrl;
      } else if (provider !== "custom") {
        baseUrlSelect.value = baseUrlSelect.dataset.anthropicUrl;
      }
      if (!baseUrlSelect.value && provider !== "custom") {
        if (provider === "deepseek") baseUrlSelect.value = "https://api.deepseek.com";
        else if (provider === "kimi") baseUrlSelect.value = "https://api.moonshot.cn/v1";
        else baseUrlSelect.value = "https://www.packyapi.com";
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
      // Capture current input into the right provider slot
      const currentProvider = providerSelect.value;
      if (currentProvider === "deepseek") {
        apiKeyInput.dataset.deepseekKey = apiKeyInput.value;
      } else if (currentProvider === "kimi") {
        apiKeyInput.dataset.kimiKey = apiKeyInput.value;
      } else if (currentProvider === "custom") {
        apiKeyInput.dataset.customKey = apiKeyInput.value;
      } else {
        apiKeyInput.dataset.anthropicKey = apiKeyInput.value;
      }

      const baseUrlSelect = document.getElementById("settingsBaseUrl");
      const baseURL = baseUrlSelect.value.trim();
      const payload = {
        model: document.getElementById("settingsModel").value.trim(),
      };

      // Send per-provider keys (only if not masked)
      const aKey = (apiKeyInput.dataset.anthropicKey || "").trim();
      const dKey = (apiKeyInput.dataset.deepseekKey || "").trim();
      const kKey = (apiKeyInput.dataset.kimiKey || "").trim();
      const cKey = (apiKeyInput.dataset.customKey || "").trim();
      if (aKey && !aKey.includes("...")) payload.anthropicApiKey = aKey;
      if (dKey && !dKey.includes("...")) payload.deepseekApiKey = dKey;
      if (kKey && !kKey.includes("...")) payload.kimiApiKey = kKey;

      // Save current base URL to the right slot, and send both
      if (currentProvider === "custom") {
        const customUrl = document.getElementById("settingsCustomBaseUrl").value.trim();
        payload.deepseekBaseURL = customUrl;
        payload.deepseekApiKey = cKey || "dummy";
        payload.anthropicBaseURL = baseUrlSelect.dataset.anthropicUrl || "";
        payload.kimiBaseURL = baseUrlSelect.dataset.kimiUrl || "";
      } else if (currentProvider === "kimi") {
        baseUrlSelect.dataset.kimiUrl = baseURL;
        payload.kimiBaseURL = baseURL;
        payload.anthropicBaseURL = baseUrlSelect.dataset.anthropicUrl || "";
        payload.deepseekBaseURL = baseUrlSelect.dataset.deepseekUrl || "";
      } else if (currentProvider === "deepseek") {
        baseUrlSelect.dataset.deepseekUrl = baseURL;
        payload.deepseekBaseURL = baseURL;
        payload.anthropicBaseURL = baseUrlSelect.dataset.anthropicUrl || "";
        payload.kimiBaseURL = baseUrlSelect.dataset.kimiUrl || "";
      } else {
        baseUrlSelect.dataset.anthropicUrl = baseURL;
        payload.anthropicBaseURL = baseURL;
        payload.deepseekBaseURL = baseUrlSelect.dataset.deepseekUrl || "";
        payload.kimiBaseURL = baseUrlSelect.dataset.kimiUrl || "";
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
