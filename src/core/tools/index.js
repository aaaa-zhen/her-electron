/**
 * Tool Registry — modular replacement for the old monolithic registry.js
 *
 * Each tool lives in its own file under ./defs/ and extends BaseTool.
 * This file auto-discovers all tools, builds the Anthropic tool definitions,
 * validates inputs, and dispatches execution.
 *
 * The public API is identical to the old createTools():
 *   const { tools, execute, processScheduleOutput } = createTools({ ... })
 */

const fs = require("fs");
const path = require("path");
const { safePath, getFileType, formatSize, toFileUrl } = require("./helpers");
const { execAsync } = require("./process-utils");

// ── News / search helpers (kept here — shared across the search pipeline) ──

function decodeHtml(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
}
function stripTags(value) {
  return decodeHtml(String(value || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}
function extractTag(block, tagName) {
  const match = String(block || "").match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, "i"));
  return match ? decodeHtml(match[1]).trim() : "";
}
function extractSource(block) {
  const match = String(block || "").match(/<source[^>]*url="([^"]*)"[^>]*>([\s\S]*?)<\/source>/i);
  if (!match) return { name: "", url: "" };
  return { url: decodeHtml(match[1]).trim(), name: decodeHtml(match[2]).trim() };
}
function formatNewsDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "";
  return date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function extractBingImageUrl(block) {
  const match = String(block || "").match(/<News:Image>([^<]+)<\/News:Image>/i);
  if (!match) return "";
  const raw = decodeHtml(match[1]).trim();
  if (raw.includes("bing.com/th?")) return `${raw}&w=400&h=240&c=7`;
  return raw;
}
function extractBingRealUrl(linkText) {
  const match = String(linkText || "").match(/[?&]url=(https?%3[aA]%2[fF]%2[fF][^&]+)/i);
  if (match) { try { return decodeURIComponent(match[1]); } catch { return ""; } }
  return "";
}
function extractRssImage(block) {
  const mediaMatch = String(block || "").match(/<media:content[^>]+url=["']([^"']+)["']/i);
  if (mediaMatch) return decodeHtml(mediaMatch[1]).trim();
  const encMatch = String(block || "").match(/<enclosure[^>]+url=["']([^"']+)["'][^>]+type=["']image\//i);
  if (encMatch) return decodeHtml(encMatch[1]).trim();
  const imgMatch = String(block || "").match(/<img[^>]+src=["'](https?:\/\/[^"']+)["']/i);
  if (imgMatch) return decodeHtml(imgMatch[1]).trim();
  return "";
}
function extractCurlFailure(output) {
  const text = String(output || "").trim();
  if (!text) return "";
  return text.split("\n").map((l) => l.trim()).find((l) => /curl:\s*\(\d+\)|Could not resolve host|Failed to connect|Connection refused|proxyconnect|timed out|Connection reset|SSL|Empty reply/i.test(l)) || "";
}

// ── Auto-load all tool definitions ─────────────────────────────────────

function loadToolClasses() {
  const defsDir = path.join(__dirname, "defs");
  if (!fs.existsSync(defsDir)) return [];
  return fs.readdirSync(defsDir)
    .filter((f) => f.endsWith(".js"))
    .sort()
    .map((f) => {
      try { return require(path.join(defsDir, f)); } catch (err) {
        console.error(`[Tools] Failed to load ${f}:`, err.message);
        return null;
      }
    })
    .filter(Boolean);
}

// ── createTools — public API (same signature as old registry.js) ───────

function createTools({ paths, stores, scheduleService, createAnthropicClient, emit }) {
  const memoryStore = stores.memoryStore;
  const todoStore = stores.todoStore;

  // ── Shared helpers exposed to every tool via ctx ──

  function shortValue(value, fallback = "") {
    const text = String(value || fallback || "").trim();
    if (!text) return "";
    return text.length > 72 ? `${text.slice(0, 72)}...` : text;
  }

  function emitCommand(command, title, detail) {
    emit({ type: "command", command, title, detail: shortValue(detail, command) });
  }

  function emitFile(filename, filePath) {
    const stat = fs.statSync(filePath);
    emit({ type: "file", filename, url: toFileUrl(filePath), fileType: getFileType(filename), size: formatSize(stat.size), sizeBytes: stat.size });
  }

  function rememberTask(key, value, tags = []) {
    memoryStore.saveEntry(key, value, { type: "task_history", tags: ["task_history", ...tags] });
  }

  function rememberArtifact(filename, detail, tags = [], meta = {}) {
    if (!filename) return;
    memoryStore.saveEntry(`artifact:${filename}`, detail, { type: "artifact", tags: ["artifact", ...tags], meta: { filename, ...meta } });
  }

  function rememberShellTask(command, output) {
    const textCommand = String(command || "");
    if (!/\byt-dlp\b/.test(textCommand)) return;
    const urlMatch = textCommand.match(/https?:\/\/[^\s"]+/);
    const lines = String(output || "").trim().split("\n").map((l) => l.trim()).filter(Boolean);
    const lastLine = lines[lines.length - 1] || "";
    const filename = lastLine ? path.basename(lastLine) : "";
    const label = filename || "媒体文件";
    const source = urlMatch ? `，来源 ${urlMatch[0]}` : "";
    rememberTask(`task:download-media:${label}`, `已为用户下载媒体 ${label}${source}。`, ["media", "video"]);
    if (filename) {
      rememberArtifact(filename, `这是我通过终端替用户下载的媒体文件 ${filename}${source}。`, ["media", "video"], { kind: getFileType(filename), origin: "bash_yt_dlp", sourceUrl: urlMatch ? urlMatch[0] : "" });
    }
  }

  function describeShellCommand(command) {
    const executable = String(command || "").trim().split(/\s+/)[0];
    const labels = { git: "运行 Git", npm: "运行 npm", npx: "运行 npx", node: "运行 Node.js", python: "运行 Python", python3: "运行 Python", ls: "查看目录", cat: "查看文件", rg: "搜索代码", grep: "搜索内容", curl: "请求网页", search_news: "搜索新闻", ffmpeg: "处理媒体", "yt-dlp": "下载媒体" };
    return labels[executable] || "执行终端命令";
  }

  // ── News search (still needed by web_search built-in) ──

  async function resolveFinalUrl(url) {
    if (!url) return "";
    if (url.includes("news.google.com")) {
      try { return await resolveGoogleNewsUrl(url); } catch { return url; }
    }
    const command = `curl -Ls -o /dev/null -w "%{url_effective}" "${url}"`;
    const output = await execAsync(command, { timeout: 15000, cwd: paths.sharedDir });
    return String(output || "").trim() || url;
  }

  function resolveGoogleNewsUrl(googleUrl) {
    const { BrowserWindow } = require("electron");
    return new Promise((resolve) => {
      let resolved = false;
      const win = new BrowserWindow({ show: false, width: 400, height: 300, webPreferences: { nodeIntegration: false, contextIsolation: true } });
      const timeout = setTimeout(() => { if (!resolved) { resolved = true; win.destroy(); resolve(googleUrl); } }, 10000);
      win.webContents.on("did-redirect-navigation", (_e, newUrl) => { if (!newUrl.includes("news.google.com") && !resolved) { resolved = true; clearTimeout(timeout); win.destroy(); resolve(newUrl); } });
      win.webContents.on("did-navigate", (_e, newUrl) => { if (!newUrl.includes("news.google.com") && !resolved) { resolved = true; clearTimeout(timeout); win.destroy(); resolve(newUrl); } });
      win.loadURL(googleUrl).catch(() => { if (!resolved) { resolved = true; clearTimeout(timeout); win.destroy(); resolve(googleUrl); } });
    });
  }

  async function fetchPreviewImage(url) {
    if (!url) return "";
    try {
      const command = `curl -Ls -m 8 -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" "${url}" | head -c 200000`;
      const html = await execAsync(command, { timeout: 12000, cwd: paths.sharedDir });
      const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
      if (ogMatch && ogMatch[1]) return decodeHtml(ogMatch[1]).trim();
      const twitterMatch = html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i) || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);
      if (twitterMatch && twitterMatch[1]) return decodeHtml(twitterMatch[1]).trim();
      const imgMatches = html.matchAll(/<img[^>]+src=["'](https?:\/\/[^"']+)["'][^>]*>/gi);
      for (const m of imgMatches) {
        const src = decodeHtml(m[1]).trim();
        if (/\.(svg|gif|ico)(\?|$)/i.test(src)) continue;
        if (/logo|icon|avatar|badge|pixel|tracker|1x1/i.test(src)) continue;
        const tag = m[0]; const widthMatch = tag.match(/width=["']?(\d+)/i);
        if (widthMatch && parseInt(widthMatch[1], 10) < 100) continue;
        return src;
      }
    } catch { }
    return "";
  }

  function parseDuckDuckGoResults(html, numResults) {
    const results = [];
    const regex = /<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let match;
    while ((match = regex.exec(html)) !== null && results.length < numResults) {
      const href = match[1].replace(/\/\/duckduckgo\.com\/l\/\?uddg=/, "").split("&")[0];
      const title = stripTags(match[2]).trim();
      const snippet = stripTags(match[3]).trim();
      try { results.push({ title, url: decodeURIComponent(href), snippet }); } catch { results.push({ title, url: href, snippet }); }
    }
    return results.filter((r) => r.title && r.url);
  }

  function parseBingSearchResults(html, numResults) {
    const results = [];
    const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) || [];
    for (const block of blocks) {
      if (results.length >= numResults) break;
      const titleMatch = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      if (!titleMatch) continue;
      const snippetMatch = block.match(/<div class="b_caption"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i) || block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
      results.push({ title: stripTags(titleMatch[2]).trim(), url: decodeHtml(titleMatch[1]).trim(), snippet: stripTags(snippetMatch ? snippetMatch[1] : "").trim() });
    }
    return results.filter((r) => r.title && /^https?:\/\//i.test(r.url));
  }

  async function searchNews(query, numResults = 5) {
    const limitedResults = Math.max(1, Math.min(Number(numResults) || 5, 8));
    try {
      const bingUrl = `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss`;
      const bingRss = await execAsync(`curl -Ls --max-time 15 -H "User-Agent: Mozilla/5.0" "${bingUrl}"`, { timeout: 20000, cwd: paths.sharedDir });
      const bingFailure = extractCurlFailure(bingRss);
      if (bingFailure) throw new Error(bingFailure);
      if (bingRss.includes("<item>")) {
        const items = [];
        const itemRegex = /<item>([\s\S]*?)<\/item>/g;
        let match;
        while ((match = itemRegex.exec(bingRss)) !== null && items.length < limitedResults) {
          const block = match[1];
          const title = stripTags(extractTag(block, "title")).trim();
          const bingLink = extractTag(block, "link");
          const realUrl = extractBingRealUrl(bingLink) || bingLink;
          const summary = stripTags(extractTag(block, "description"));
          const publishedAt = formatNewsDate(extractTag(block, "pubDate"));
          const imageUrl = extractBingImageUrl(block);
          const sourceMatch = block.match(/<News:Source>([^<]+)<\/News:Source>/i);
          const source = sourceMatch ? decodeHtml(sourceMatch[1]).trim() : "";
          items.push({ title, source, summary: summary || "暂无摘要", publishedAt, url: realUrl, imageUrl });
        }
        if (items.length > 0) return items;
      }
    } catch (err) {
      console.error("[News] Bing RSS failed, falling back to Google:", err.message);
    }

    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`;
    const rss = await execAsync(`curl -Ls --max-time 20 "${rssUrl}"`, { timeout: 25000, cwd: paths.sharedDir });
    const rssFailure = extractCurlFailure(rss);
    if (rssFailure) throw new Error(rssFailure);
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(rss)) !== null && items.length < limitedResults) {
      const block = match[1];
      const title = stripTags(extractTag(block, "title")).replace(/\s+-\s+[^-]+$/, "").trim();
      const source = extractSource(block);
      const googleUrl = extractTag(block, "link");
      const summary = stripTags(extractTag(block, "description"));
      const publishedAt = formatNewsDate(extractTag(block, "pubDate"));
      const rssImage = extractRssImage(block);
      items.push({ title, source: source.name, summary: summary || "暂无摘要", publishedAt, googleUrl, rssImage });
    }
    const cards = await Promise.all(items.map(async (item) => {
      const finalUrl = await resolveFinalUrl(item.googleUrl);
      const imageUrl = item.rssImage || await fetchPreviewImage(finalUrl);
      return { title: item.title, source: item.source, summary: item.summary, publishedAt: item.publishedAt, url: finalUrl || item.googleUrl, imageUrl };
    }));
    return cards;
  }

  // ── Schedule output processing ──

  async function processScheduleOutput(taskData, rawOutput) {
    let output = rawOutput.slice(0, 5000);
    if (taskData.ai_prompt) {
      try {
        const anthropic = createAnthropicClient();
        const response = await anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 2048,
          messages: [{ role: "user", content: `${taskData.ai_prompt}\n\n---\nRaw data:\n${rawOutput.slice(0, 8000)}` }],
        });
        output = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      } catch (error) {
        console.error("[Schedule AI] Error:", error.message);
      }
    }
    return output.slice(0, 5000);
  }

  if (!scheduleService.processScheduleOutput) {
    scheduleService.processScheduleOutput = processScheduleOutput;
  }

  // ── Instantiate all tools ──

  const ToolClasses = loadToolClasses();
  const toolInstances = ToolClasses.map((Cls) => new Cls());
  const toolMap = new Map();
  for (const instance of toolInstances) {
    toolMap.set(instance.name, instance);
  }

  // ── Build context object shared with all tools ──

  function buildCtx(activeProcesses) {
    const ctx = {
      paths,
      stores,
      scheduleService,
      createAnthropicClient,
      emit,
      execAsync,
      emitCommand,
      emitFile,
      rememberTask,
      rememberArtifact,
      rememberShellTask,
      describeShellCommand,
      searchNews,
      parseDuckDuckGoResults,
      parseBingSearchResults,
      activeProcesses,
      _delegationDepth: 0,
      _allTools: null, // set after tools are built
      _model: null,    // set by chat-session before execute
    };

    // Allow delegate_task to execute child tool calls
    ctx._executeChildTool = async (block) => {
      const instance = toolMap.get(block.name);
      if (!instance) {
        return { type: "tool_result", tool_use_id: block.id, content: `Unknown tool: ${block.name}`, is_error: true };
      }
      const childCtx = { ...ctx, activeProcesses, _delegationDepth: ctx._delegationDepth + 1 };
      try {
        const result = await Promise.race([
          instance.execute(block.input || {}, childCtx),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out")), instance.timeout)),
        ]);
        if (typeof result === "string") {
          return { type: "tool_result", tool_use_id: block.id, content: result };
        }
        if (result && result.content) {
          return { type: "tool_result", tool_use_id: block.id, content: typeof result.content === "string" ? result.content : JSON.stringify(result.content), is_error: result.is_error || false };
        }
        return { type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) };
      } catch (err) {
        return { type: "tool_result", tool_use_id: block.id, content: `Error: ${err.message}`, is_error: true };
      }
    };

    return ctx;
  }

  // ── Build Anthropic tool definitions ──

  const ctx = buildCtx([]);
  const tools = toolInstances.map((instance) => {
    return typeof instance.definition === "function" && instance.definition.length > 0
      ? instance.definition(ctx)
      : instance.definition();
  });
  // Make tool definitions available for delegate_task subagents
  ctx._allTools = tools;

  // ── Execute with timeout + validation ──

  async function executeWithTimeout(block, activeProcesses) {
    const instance = toolMap.get(block.name);
    if (!instance) {
      return { type: "tool_result", tool_use_id: block.id, content: `Unknown tool: ${block.name}`, is_error: true };
    }

    // Schema validation
    const validationError = instance.validate(block.input || {});
    if (validationError) {
      return { type: "tool_result", tool_use_id: block.id, content: validationError, is_error: true };
    }

    const timeout = instance.timeout;
    const start = Date.now();
    const toolCtx = buildCtx(activeProcesses);
    toolCtx._allTools = tools;
    toolCtx._model = executeWithTimeout._currentModel || null;

    try {
      const result = await Promise.race([
        instance.execute(block.input || {}, toolCtx),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Tool "${block.name}" timed out after ${timeout / 1000}s`)), timeout)),
      ]);

      console.log(`[Tool] ${block.name} done in ${Date.now() - start}ms`);

      // Normalize result
      if (typeof result === "string") {
        return { type: "tool_result", tool_use_id: block.id, content: result };
      }
      if (result && typeof result === "object") {
        return {
          type: "tool_result",
          tool_use_id: block.id,
          content: result.content || "",
          ...(result.is_error ? { is_error: true } : {}),
        };
      }
      return { type: "tool_result", tool_use_id: block.id, content: String(result || "") };
    } catch (err) {
      console.error(`[Tool] ${block.name} failed: ${err.message}`);
      return { type: "tool_result", tool_use_id: block.id, content: `Error: ${err.message}`, is_error: true };
    }
  }

  function setModel(model) {
    executeWithTimeout._currentModel = model || null;
  }

  return { tools, execute: executeWithTimeout, processScheduleOutput, setModel };
}

module.exports = { createTools };
