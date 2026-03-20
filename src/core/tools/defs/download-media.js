const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { BaseTool } = require("../base-tool");
const { safePath, formatSize } = require("../helpers");

// ── Platform detection ──────────────────────────────────────────────────

function detectPlatform(url) {
  if (/douyin\.com|iesdouyin\.com/i.test(url)) return "douyin";
  if (/tiktok\.com/i.test(url)) return "tiktok";
  if (/bilibili\.com|b23\.tv/i.test(url)) return "bilibili";
  if (/youtube\.com|youtu\.be/i.test(url)) return "youtube";
  if (/twitter\.com|x\.com/i.test(url)) return "twitter";
  return "generic";
}

// ── Douyin downloader (pure Node + Electron BrowserWindow) ──────────────

function resolveDouyinShortUrlViaElectron(url) {
  if (!/v\.douyin\.com/i.test(url)) return Promise.resolve(url);
  const { BrowserWindow } = require("electron");
  return new Promise((resolve) => {
    let resolved = false;
    const win = new BrowserWindow({
      show: false, width: 400, height: 300,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    const timeout = setTimeout(() => {
      if (!resolved) { resolved = true; win.destroy(); resolve(url); }
    }, 10000);
    win.webContents.on("did-redirect-navigation", (_e, newUrl) => {
      if (!newUrl.includes("v.douyin.com") && !resolved) {
        resolved = true; clearTimeout(timeout); win.destroy(); resolve(newUrl);
      }
    });
    win.webContents.on("did-navigate", (_e, newUrl) => {
      if (!newUrl.includes("v.douyin.com") && !resolved) {
        resolved = true; clearTimeout(timeout); win.destroy(); resolve(newUrl);
      }
    });
    win.loadURL(url).catch(() => {
      if (!resolved) { resolved = true; clearTimeout(timeout); win.destroy(); resolve(url); }
    });
  });
}

function extractDouyinVideoId(url) {
  for (const pattern of [/\/video\/(\d+)/, /modal_id=(\d+)/, /\/note\/(\d+)/]) {
    const m = url.match(pattern);
    if (m) return m[1];
  }
  return null;
}

function fetchDouyinVideoInfo(videoId) {
  const { BrowserWindow } = require("electron");
  return new Promise((resolve, reject) => {
    const result = {};
    let done = false;

    const win = new BrowserWindow({
      show: false, width: 1920, height: 1080,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });

    const timeout = setTimeout(() => {
      if (!done) { done = true; win.destroy(); reject(new Error("抖音视频信息获取超时（30s），可能被反爬限制")); }
    }, 30000);

    win.webContents.debugger.attach("1.3");
    win.webContents.debugger.sendCommand("Network.enable");
    win.webContents.debugger.on("message", async (_event, method, params) => {
      if (done) return;
      if (method === "Network.responseReceived") {
        const reqUrl = params.response.url || "";
        if (reqUrl.includes("aweme/v1/web/aweme/detail") && params.response.status === 200) {
          try {
            const body = await win.webContents.debugger.sendCommand("Network.getResponseBody", { requestId: params.requestId });
            const data = JSON.parse(body.body);
            const aweme = data.aweme_detail || {};
            const video = aweme.video || {};
            const playAddr = video.play_addr || {};
            const urls = playAddr.url_list || [];
            if (urls.length > 0) {
              result.playUrl = urls[0];
              result.desc = aweme.desc || "video";
              result.duration = video.duration || 0;
              done = true;
              clearTimeout(timeout);
              try { win.webContents.debugger.detach(); } catch (_) {}
              win.destroy();
              resolve(result);
            }
          } catch (_) {}
        }
      }
    });

    const pageUrl = `https://www.douyin.com/video/${videoId}`;
    win.loadURL(pageUrl).catch((err) => {
      if (!done) { done = true; clearTimeout(timeout); win.destroy(); reject(new Error(`无法加载抖音页面: ${err.message}`)); }
    });
  });
}

function sanitizeFilename(name, maxLen = 50) {
  let clean = String(name || "")
    // Remove all non-alphanumeric except CJK chars, spaces, hyphens, underscores, dots
    .replace(/[【】（）\[\](){}《》<>「」『』\u200B-\u200F\uFEFF]/g, "")
    .replace(/[\\/:*?"<>|\n\r\t#@!$%^&+=~`';,]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length > maxLen) clean = clean.slice(0, maxLen).trim();
  return clean || "video";
}

// ── Download with progress (spawn-based) ────────────────────────────────

function downloadWithCurlProgress(url, outputPath, referer, emit, cwd, activeProcesses, timeout = 300000) {
  return new Promise((resolve, reject) => {
    const args = [
      "-L", "-o", outputPath,
      "-H", `Referer: ${referer}`,
      "-H", "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
      "--connect-timeout", "15",
      "--max-time", "300",
      "--progress-bar",
      url,
    ];
    const child = spawn("curl", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    if (activeProcesses) activeProcesses.push(child);
    let lastPercent = -1;

    const cleanup = () => {
      if (activeProcesses) {
        const idx = activeProcesses.indexOf(child);
        if (idx !== -1) activeProcesses.splice(idx, 1);
      }
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      cleanup();
      reject(new Error("下载超时"));
    }, timeout);

    // curl --progress-bar outputs to stderr like: ###                     13.2%
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      const match = text.match(/([\d.]+)%/);
      if (match) {
        const percent = Math.round(parseFloat(match[1]));
        if (percent !== lastPercent && percent % 5 === 0) {
          lastPercent = percent;
          emit({ type: "progress", percent, detail: `下载中 ${percent}%` });
        }
      }
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      cleanup();
      if (code === 0) resolve();
      else reject(new Error(`curl exited with code ${code}`));
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      cleanup();
      reject(err);
    });
  });
}

function downloadWithYtDlpProgress(args, emit, cwd, activeProcesses, timeout = 600000) {
  return new Promise((resolve, reject) => {
    const child = spawn("yt-dlp", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    activeProcesses.push(child);
    let output = "";
    let lastPercent = -1;

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("下载超时"));
    }, timeout);

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      // yt-dlp progress: [download]  45.2% of ~112.5MiB at 5.2MiB/s ETA 00:12
      const match = text.match(/\[download\]\s+([\d.]+)%\s+of\s+~?([\d.]+\s*\w+)/);
      if (match) {
        const percent = Math.round(parseFloat(match[1]));
        const totalSize = match[2];
        if (percent !== lastPercent) {
          lastPercent = percent;
          emit({ type: "progress", percent, detail: `下载中 ${percent}% · ${totalSize}` });
        }
      }
      // yt-dlp merge: [Merger] Merging formats into ...
      if (/\[Merger\]|\[ffmpeg\]/.test(text)) {
        emit({ type: "progress", percent: 100, detail: "合并视频音频中…" });
      }
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const idx = activeProcesses.indexOf(child);
      if (idx !== -1) activeProcesses.splice(idx, 1);
      if (code === 0) resolve(output);
      else reject(new Error(`yt-dlp exited with code ${code}\n${output.slice(-500)}`));
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      const idx = activeProcesses.indexOf(child);
      if (idx !== -1) activeProcesses.splice(idx, 1);
      reject(err);
    });
  });
}

// ── yt-dlp dependency management ────────────────────────────────────────

async function checkCommand(name, execAsync, cwd) {
  try {
    const output = await execAsync(`which ${name} 2>/dev/null`, { timeout: 5000, cwd });
    return output.trim().length > 0 && !output.includes("not found");
  } catch (_) {
    return false;
  }
}

async function ensureYtDlp(execAsync, cwd, emit) {
  if (await checkCommand("yt-dlp", execAsync, cwd)) return true;

  emit({ type: "progress", percent: 0, detail: "正在安装 yt-dlp…" });

  try {
    if (process.platform === "darwin") {
      if (await checkCommand("brew", execAsync, cwd)) {
        try {
          await execAsync("brew install yt-dlp 2>&1", { timeout: 120000, cwd });
          if (await checkCommand("yt-dlp", execAsync, cwd)) return true;
        } catch (_) {}
      }
    }

    for (const pip of ["pip3", "pip"]) {
      if (await checkCommand(pip, execAsync, cwd)) {
        try {
          await execAsync(`${pip} install --user yt-dlp 2>&1`, { timeout: 120000, cwd });
          if (await checkCommand("yt-dlp", execAsync, cwd)) return true;
        } catch (_) {}
      }
    }

    if (process.platform !== "win32") {
      const binDir = path.join(process.env.HOME || "/tmp", ".local", "bin");
      await execAsync(`mkdir -p "${binDir}"`, { timeout: 5000, cwd }).catch(() => {});
      const dlUrl = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp";
      await execAsync(`curl -L -o "${binDir}/yt-dlp" "${dlUrl}" && chmod +x "${binDir}/yt-dlp"`, { timeout: 60000, cwd });
      const check = await execAsync(`"${binDir}/yt-dlp" --version 2>/dev/null`, { timeout: 5000, cwd });
      if (check.trim() && !check.includes("error")) {
        process.env.PATH = `${binDir}:${process.env.PATH}`;
        return true;
      }
    }
  } catch (_) {}

  return false;
}

// ── Bilibili cookie detection ───────────────────────────────────────────

async function detectBrowserForCookies(execAsync, cwd) {
  try {
    for (const browser of ["chrome", "edge", "safari", "firefox"]) {
      const appNames = {
        chrome: "Google Chrome",
        edge: "Microsoft Edge",
        safari: "Safari",
        firefox: "Firefox",
      };
      try {
        if (process.platform === "darwin") {
          const check = await execAsync(`ls "/Applications/${appNames[browser]}.app" 2>/dev/null`, { timeout: 3000, cwd });
          if (check.trim() && !check.includes("No such file")) return browser;
        } else {
          const check = await execAsync(`which ${browser} 2>/dev/null`, { timeout: 3000, cwd });
          if (check.trim()) return browser;
        }
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

// ── Download directory (Desktop by default) ─────────────────────────────

function getDownloadDir() {
  const os = require("os");
  const desktop = path.join(os.homedir(), "Desktop");
  if (fs.existsSync(desktop)) return desktop;
  // Fallback to Downloads
  const downloads = path.join(os.homedir(), "Downloads");
  if (fs.existsSync(downloads)) return downloads;
  return null; // will fall back to sharedDir
}

// ── The Tool ────────────────────────────────────────────────────────────

class DownloadMediaTool extends BaseTool {
  get name() { return "download_media"; }
  get timeout() { return 600000; }
  get description() {
    return "Download video/audio from Douyin, YouTube, Bilibili, Twitter/X, TikTok and other sites. Files are saved to Desktop by default. Handles anti-scraping automatically. Auto-installs dependencies if needed.";
  }
  get input_schema() {
    return {
      type: "object",
      properties: {
        url: { type: "string", description: "URL of the video/audio to download" },
        format: { type: "string", enum: ["video", "audio"], description: "Download as video or audio only. Default: video" },
        quality: { type: "string", description: "Quality: best, 720p, 480p. Default: best" },
      },
      required: ["url"],
    };
  }

  async execute(input, ctx) {
    const { url, format = "video", quality = "best" } = input;
    if (!/^https?:\/\//i.test(url)) return { content: "无效的 URL", is_error: true };

    const platform = detectPlatform(url);

    if (platform === "douyin") {
      return this._downloadDouyin(url, format, ctx);
    }

    return this._downloadGeneric(url, format, quality, platform, ctx);
  }

  // ── Douyin: Playwright script (primary) + Electron fallback ──────────

  async _downloadDouyin(url, format, ctx) {
    const dlDir = getDownloadDir() || ctx.paths.sharedDir;

    // Try Playwright Python script first (more reliable against anti-scraping)
    const scriptPath = path.join(__dirname, "..", "scripts", "douyin_download.py");
    if (fs.existsSync(scriptPath)) {
      ctx.emit({ type: "progress", percent: 0, detail: "使用 Playwright 下载抖音视频…" });
      ctx.emitCommand(`python3 douyin_download.py "${url}"`, "下载抖音", url);

      // Snapshot Desktop before download
      const filesBefore = new Set();
      try { fs.readdirSync(dlDir).forEach((f) => filesBefore.add(f)); } catch (_) {}

      try {
        const result = await new Promise((resolve, reject) => {
          const child = spawn("python3", [scriptPath, url, dlDir], {
            cwd: dlDir,
            stdio: ["ignore", "pipe", "pipe"],
          });
          ctx.activeProcesses.push(child);
          let stdout = "", stderr = "";

          const timer = setTimeout(() => {
            child.kill("SIGTERM");
            reject(new Error("下载超时 (120s)"));
          }, 120000);

          child.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
            const text = chunk.toString();
            if (/\[setup\]/.test(text)) {
              ctx.emit({ type: "progress", percent: 5, detail: "首次使用，正在安装依赖…" });
            } else if (/\[1\/4\]/.test(text)) {
              ctx.emit({ type: "progress", percent: 10, detail: "解析链接…" });
            } else if (/\[2\/4\]/.test(text)) {
              ctx.emit({ type: "progress", percent: 20, detail: "获取视频信息…" });
            } else if (/\[3\/4\]/.test(text)) {
              ctx.emit({ type: "progress", percent: 40, detail: "下载中…" });
            } else if (/\[4\/4\]/.test(text)) {
              ctx.emit({ type: "progress", percent: 90, detail: "完成!" });
            }
          });
          child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
          child.on("close", (code) => {
            clearTimeout(timer);
            const idx = ctx.activeProcesses.indexOf(child);
            if (idx !== -1) ctx.activeProcesses.splice(idx, 1);
            if (code === 0) resolve(stdout);
            else reject(new Error(stderr || stdout || `exit code ${code}`));
          });
          child.on("error", (err) => {
            clearTimeout(timer);
            const idx = ctx.activeProcesses.indexOf(child);
            if (idx !== -1) ctx.activeProcesses.splice(idx, 1);
            reject(err);
          });
        });

        // Find the downloaded file — parse "Saved: <path>" from script output
        let filePath = null;
        const savedMatch = result.match(/Saved:\s*(.+)/);
        if (savedMatch) {
          const candidate = savedMatch[1].trim();
          if (fs.existsSync(candidate)) filePath = candidate;
        }

        // Fallback: diff directory
        if (!filePath) {
          try {
            const filesAfter = fs.readdirSync(dlDir);
            const newFiles = filesAfter.filter((f) => !filesBefore.has(f) && f.endsWith(".mp4"));
            if (newFiles.length > 0) filePath = path.join(dlDir, newFiles[0]);
          } catch (_) {}
        }

        if (filePath && fs.existsSync(filePath)) {
          return this._finishDouyinDownload(filePath, url, format, ctx);
        }
      } catch (err) {
        // Playwright failed — fall through to Electron method
        ctx.emit({ type: "progress", percent: 0, detail: `Playwright 失败，尝试备用方案…` });
      }
    }

    // Fallback: Electron BrowserWindow method
    ctx.emit({ type: "progress", percent: 0, detail: "解析抖音链接…" });

    // 1. Resolve short URL
    let fullUrl = url;
    if (/v\.douyin\.com/i.test(url)) {
      try {
        fullUrl = await resolveDouyinShortUrlViaElectron(url);
      } catch (_) {
        fullUrl = url;
      }
    }

    // 2. Extract video ID
    const videoId = extractDouyinVideoId(fullUrl);
    if (!videoId) {
      return { content: `无法从 URL 中提取视频 ID: ${url}\n支持的格式: douyin.com/video/xxx, v.douyin.com/xxx`, is_error: true };
    }

    // 3. Fetch video info via Electron headless browser
    ctx.emit({ type: "progress", percent: 10, detail: "获取视频信息…" });
    let info;
    try {
      info = await fetchDouyinVideoInfo(videoId);
    } catch (err) {
      return { content: `获取抖音视频信息失败: ${err.message}\n可能原因: 视频不存在、已被删除、或被反爬限制`, is_error: true };
    }

    // 4. Download with progress — save to Desktop
    const filename = `抖音_${sanitizeFilename(info.desc)}.mp4`;
    const filePath = path.join(dlDir, filename);

    ctx.emit({ type: "progress", percent: 15, detail: `开始下载: ${sanitizeFilename(info.desc, 30)}` });

    try {
      await downloadWithCurlProgress(
        info.playUrl, filePath, "https://www.douyin.com/",
        ctx.emit, dlDir, ctx.activeProcesses, 300000
      );
    } catch (err) {
      return { content: `下载失败: ${err.message}`, is_error: true };
    }

    // 5. Verify
    if (!fs.existsSync(filePath)) {
      return { content: "下载失败，文件未生成", is_error: true };
    }
    const stat = fs.statSync(filePath);
    if (stat.size < 10000) {
      try { fs.unlinkSync(filePath); } catch (_) {}
      return { content: "下载的文件过小，可能被反爬拦截。请稍后重试。", is_error: true };
    }

    return this._finishDouyinDownload(filePath, url, format, ctx);
  }

  // ── Common finish for Douyin downloads ─────────────────────────────────

  async _finishDouyinDownload(filePath, url, format, ctx) {
    const filename = path.basename(filePath);
    const stat = fs.statSync(filePath);

    ctx.emit({ type: "progress", percent: 100, detail: `下载完成 · ${formatSize(stat.size)}` });
    // Symlink into shared dir so send_file works
    const sharedLink = safePath(ctx.paths.sharedDir, filename);
    if (sharedLink && sharedLink !== filePath) {
      try { fs.unlinkSync(sharedLink); } catch (_) {}
      try { fs.symlinkSync(filePath, sharedLink); } catch (_) {}
    }
    ctx.emitFile(filename, filePath);
    ctx.rememberTask(`task:download-media:${filename}`, `已为用户下载抖音视频 ${filename} 到桌面，来源 ${url}。`, ["media", "video"]);
    ctx.rememberArtifact(filename, `抖音视频 ${filename}，已保存到桌面。来源 ${url}。`, ["media", "video"], { kind: "video", origin: "download_media_douyin", sourceUrl: url });

    if (format === "audio") {
      return this._extractAudio(filePath, filename, ctx);
    }

    return `已下载到桌面: ${filename} (${formatSize(stat.size)})`;
  }

  // ── Generic: yt-dlp with auto-install + progress ──────────────────────

  async _downloadGeneric(url, format, quality, platform, ctx) {
    // Ensure yt-dlp is available
    const hasYtDlp = await ensureYtDlp(ctx.execAsync, ctx.paths.sharedDir, ctx.emit);
    if (!hasYtDlp) {
      return {
        content: [
          "需要 yt-dlp 来下载此视频，但自动安装失败。",
          "请手动安装:",
          "  macOS:   brew install yt-dlp",
          "  pip:     pip3 install yt-dlp",
          "  直接下载: https://github.com/yt-dlp/yt-dlp/releases",
        ].join("\n"),
        is_error: true,
      };
    }

    ctx.emit({ type: "progress", percent: 0, detail: "准备下载…" });

    // Download to Desktop by default
    const dlDir = getDownloadDir() || ctx.paths.sharedDir;

    // Snapshot existing files before download
    const filesBefore = new Set();
    try {
      fs.readdirSync(dlDir).forEach((f) => filesBefore.add(f));
    } catch (_) {}

    // Build yt-dlp arguments — use ID-based output to avoid encoding issues
    const args = [];
    const expectedExt = format === "audio" ? "mp3" : "mp4";

    if (format === "audio") {
      args.push("-x", "--audio-format", "mp3", "--audio-quality", "0");
    } else {
      // Prefer H.264+AAC for universal playback (macOS QuickTime, iOS, etc.)
      // Fallback to any codec if H.264 not available
      const qualityMap = {
        best: "bestvideo[vcodec~='^(avc|h264)']+bestaudio[acodec~='^(aac|mp4a)']/bestvideo[vcodec~='^(avc|h264)']+bestaudio/bestvideo+bestaudio/best",
        "720p": "bestvideo[vcodec~='^(avc|h264)'][height<=720]+bestaudio[acodec~='^(aac|mp4a)']/bestvideo[height<=720]+bestaudio/best[height<=720]",
        "480p": "bestvideo[vcodec~='^(avc|h264)'][height<=480]+bestaudio[acodec~='^(aac|mp4a)']/bestvideo[height<=480]+bestaudio/best[height<=480]",
      };
      args.push("-f", qualityMap[quality] || qualityMap.best, "--merge-output-format", "mp4");
    }

    // Use %(id)s to guarantee safe filename, download to Desktop
    args.push(
      "-o", `${dlDir}/%(id)s.%(ext)s`,
      "--no-playlist",
      "--newline",  // one progress line per update (crucial for parsing)
      "--print", "after_move:filepath",  // prints final path; older yt-dlp falls back gracefully
    );

    // Bilibili: auto-extract cookies from browser
    if (platform === "bilibili") {
      const browser = await detectBrowserForCookies(ctx.execAsync, ctx.paths.sharedDir);
      if (browser) {
        args.push("--cookies-from-browser", browser);
        ctx.emit({ type: "progress", percent: 2, detail: `使用 ${browser} cookies 登录B站` });
      }
    }

    args.push(url);

    ctx.emitCommand(`yt-dlp ${args.join(" ")}`, "下载媒体", `${format} · ${url}`);

    let output;
    try {
      output = await downloadWithYtDlpProgress(args, ctx.emit, dlDir, ctx.activeProcesses);
    } catch (err) {
      // Bilibili: if cookie extraction fails, retry without cookies
      if (platform === "bilibili" && /cookie|keyring|secretstorage/i.test(err.message)) {
        ctx.emit({ type: "progress", percent: 0, detail: "Cookie 提取失败，尝试无登录下载…" });
        const cookieIdx = args.indexOf("--cookies-from-browser");
        const noCookieArgs = cookieIdx === -1 ? args : [...args.slice(0, cookieIdx), ...args.slice(cookieIdx + 2)];
        try {
          output = await downloadWithYtDlpProgress(noCookieArgs, ctx.emit, dlDir, ctx.activeProcesses);
        } catch (err2) {
          this._cleanupPartialFiles(dlDir, filesBefore);
          return { content: `下载失败: ${err2.message}`, is_error: true };
        }
      } else {
        this._cleanupPartialFiles(dlDir, filesBefore);
        return { content: `下载失败: ${err.message}`, is_error: true };
      }
    }

    // Find the downloaded file: try printed path first, then diff the directory
    let filePath = null;

    // Method 1: parse printed filepath from yt-dlp output
    const lines = output.trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const candidate = lines[i].trim();
      // Skip yt-dlp status/progress lines
      if (!candidate || /^\[/.test(candidate) || /^(WARNING|ERROR)/i.test(candidate)) continue;
      if (fs.existsSync(candidate)) {
        filePath = candidate;
        break;
      }
      // Also try as basename in download dir
      const basename = path.basename(candidate);
      if (basename && /\.\w{2,4}$/.test(basename)) {
        const inDlDir = path.join(dlDir, basename);
        if (fs.existsSync(inDlDir)) {
          filePath = inDlDir;
          break;
        }
      }
    }

    // Method 2: diff directory — find new files that appeared
    if (!filePath) {
      try {
        const filesAfter = fs.readdirSync(dlDir);
        const newFiles = filesAfter.filter((f) => !filesBefore.has(f));
        // Prefer files with expected extension
        const match = newFiles.find((f) => f.endsWith(`.${expectedExt}`)) || newFiles[0];
        if (match) {
          filePath = path.join(dlDir, match);
        }
      } catch (_) {}
    }

    if (filePath && fs.existsSync(filePath)) {
      const filename = path.basename(filePath);
      const stat = fs.statSync(filePath);
      ctx.emit({ type: "progress", percent: 100, detail: `下载完成 · ${formatSize(stat.size)}` });
      // Symlink into shared dir so send_file can find it (avoid copying large files)
      const sharedLink = safePath(ctx.paths.sharedDir, filename);
      if (sharedLink && sharedLink !== filePath) {
        try { fs.unlinkSync(sharedLink); } catch (_) {}
        try { fs.symlinkSync(filePath, sharedLink); } catch (_) {}
      }
      ctx.emitFile(filename, filePath);
      const label = format === "audio" ? "音频" : "视频";
      ctx.rememberTask(`task:download-media:${filename}`, `已为用户下载${label} ${filename} 到桌面，来源 ${url}。`, ["media", format === "audio" ? "audio" : "video"]);
      ctx.rememberArtifact(filename, `${label}文件 ${filename}，已保存到桌面。来源 ${url}。`, ["media", format === "audio" ? "audio" : "video"], { kind: format === "audio" ? "audio" : "video", origin: "download_media", sourceUrl: url });
      return `已下载到桌面: ${filename} (${formatSize(stat.size)})`;
    }

    return `Download output:\n${output.slice(0, 3000)}`;
  }

  // ── Cleanup partial downloads on failure ─────────────────────────────

  _cleanupPartialFiles(dir, filesBefore) {
    try {
      const filesAfter = fs.readdirSync(dir);
      const newFiles = filesAfter.filter((f) => !filesBefore.has(f));
      for (const f of newFiles) {
        // Only clean up media fragments (*.part, *.ytdl, *.tmp) and small partial files
        const fp = path.join(dir, f);
        try {
          const stat = fs.statSync(fp);
          if (/\.(part|ytdl|tmp)$/i.test(f) || stat.size < 10000) {
            fs.unlinkSync(fp);
          }
        } catch (_) {}
      }
    } catch (_) {}
  }

  // ── Audio extraction helper ───────────────────────────────────────────

  async _extractAudio(videoPath, videoFilename, ctx) {
    const audioFilename = videoFilename.replace(/\.mp4$/, ".mp3");
    // Extract audio to same directory as the video (Desktop)
    const videoDir = path.dirname(videoPath);
    const audioPath = path.join(videoDir, audioFilename);

    const hasFfmpeg = await checkCommand("ffmpeg", ctx.execAsync, ctx.paths.sharedDir);
    if (!hasFfmpeg) {
      ctx.emitFile(videoFilename, videoPath);
      return `已下载视频: ${videoFilename}\n(需要 ffmpeg 才能提取音频，请运行: brew install ffmpeg)`;
    }

    ctx.emit({ type: "progress", percent: 95, detail: "提取音频中…" });
    await ctx.execAsync(`ffmpeg -i "${videoPath}" -vn -acodec libmp3lame -q:a 2 "${audioPath}" -y 2>&1`, { timeout: 120000, cwd: videoDir });
    if (fs.existsSync(audioPath)) {
      ctx.emitFile(audioFilename, audioPath);
      try { fs.unlinkSync(videoPath); } catch (_) {}
      return `已提取音频到桌面: ${audioFilename}`;
    }

    ctx.emitFile(videoFilename, videoPath);
    return `已下载视频: ${videoFilename} (音频提取失败)`;
  }
}

module.exports = DownloadMediaTool;
