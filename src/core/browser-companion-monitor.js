const EventEmitter = require("events");
const { execFile } = require("child_process");
const { SUMMARY_MODEL } = require("./shared/constants");

const CHROME_LIKE_APPS = new Set([
  "Google Chrome",
  "Arc",
  "Brave Browser",
  "Microsoft Edge",
  "Chromium",
]);

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(String(stdout || "").trim());
    });
  });
}

function clipText(text, limit = 220) {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.length > limit ? `${compact.slice(0, limit)}...` : compact;
}

function decodeHtml(text) {
  return String(text || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripTags(text) {
  return decodeHtml(String(text || "").replace(/<script[\s\S]*?<\/script>/gi, " "))
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTag(html, pattern) {
  const match = html.match(pattern);
  return match && match[1] ? decodeHtml(match[1]).trim() : "";
}

function getDomainLabel(url) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    if (hostname.includes("youtube.com") || hostname.includes("youtu.be")) return "YouTube";
    if (hostname.includes("instagram.com")) return "Instagram";
    if (hostname.includes("x.com") || hostname.includes("twitter.com")) return "X";
    if (hostname.includes("xiaohongshu.com") || hostname.includes("xiaohongshu.cn") || hostname.includes("xhslink.com")) return "小红书";
    if (hostname.includes("weibo.com") || hostname.includes("weibo.cn") || hostname.includes("m.weibo.cn")) return "微博";
    return hostname;
  } catch (_) {
    return "";
  }
}

function detectPageKind(url = "") {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    if (host.includes("youtube.com") || host.includes("youtu.be")) return "youtube";
    if (host.includes("instagram.com")) return "instagram";
    if (host.includes("x.com") || host.includes("twitter.com")) return "x";
    if (host.includes("xiaohongshu.com") || host.includes("xiaohongshu.cn") || host.includes("xhslink.com")) return "xiaohongshu";
    if (host.includes("weibo.com") || host.includes("weibo.cn") || host.includes("m.weibo.cn")) return "weibo";
    if (/(news|article|story|posts?)/i.test(parsed.pathname)) return "article";
    return "web";
  } catch (_) {
    return "web";
  }
}

function isGenericTitle(title = "", domainLabel = "") {
  const compact = String(title || "").replace(/\s+/g, " ").trim();
  if (!compact) return true;
  const normalized = compact.replace(/^\(\d+\)\s*/, "").trim().toLowerCase();
  const site = String(domainLabel || "").trim().toLowerCase();
  if (!normalized) return true;
  if (site && normalized === site) return true;
  if (["youtube", "instagram", "x", "twitter", "weibo", "xiaohongshu", "小红书", "微博"].includes(normalized)) return true;
  if (normalized.length <= 3) return true;
  return false;
}

function isSpecificCompanionPage(page) {
  try {
    const parsed = new URL(page.url);
    const host = parsed.hostname.replace(/^www\./, "");
    const pathname = parsed.pathname || "/";

    if (host.includes("youtube.com")) {
      return (pathname === "/watch" && parsed.searchParams.has("v")) || pathname.startsWith("/shorts/");
    }

    if (host.includes("youtu.be")) {
      return pathname.length > 1;
    }

    if (host.includes("instagram.com")) {
      return /^\/(p|reel|tv|stories|[^/]+)\/?/i.test(pathname) && pathname !== "/";
    }

    if (host.includes("x.com") || host.includes("twitter.com")) {
      return /^\/[^/]+\/status\/\d+/i.test(pathname) || /^\/[^/]+\/?$/i.test(pathname);
    }

    if (host.includes("xiaohongshu.com") || host.includes("xiaohongshu.cn") || host.includes("xhslink.com")) {
      return /^\/(explore|discovery\/item|user\/profile|discovery\/profile_page|discovery\/search)\/?/i.test(pathname)
        || /\/item\/[a-z0-9]+/i.test(pathname)
        || /noteId=/i.test(parsed.search);
    }

    if (host.includes("weibo.com") || host.includes("weibo.cn") || host.includes("m.weibo.cn")) {
      return /^\/detail\/[a-z0-9]+/i.test(pathname)
        || /^\/status\/[a-z0-9]+/i.test(pathname)
        || /^\/u\/\d+/i.test(pathname)
        || /^\/n\/[^/]+/i.test(pathname)
        || /^\/tv\/show\//i.test(pathname);
    }

    return /[a-z0-9]/i.test(pathname.replace(/[\/\-_.]/g, ""));
  } catch (_) {
    return false;
  }
}

function buildFallbackOffer(page) {
  const shortTitle = clipText(page.title || page.metaTitle || "这个页面", 72);
  const domainLabel = page.domainLabel || getDomainLabel(page.url);
  const kind = page.kind || detectPageKind(page.url);

  if (kind === "youtube") {
    return {
      message: `"${shortTitle}"——这个有意思`,
      primaryLabel: "聊聊呗",
      primaryPrompt: `我正在看这个 YouTube 视频：${page.title}\n链接：${page.url}\n描述：${page.description || "暂无"}\n像陪我一起看的朋友一样，自然地跟我聊聊这个视频，不要做摘要。`,
      secondaryLabel: "先看着",
      secondaryPrompt: `我在看 YouTube 视频：${page.title}\n链接：${page.url}\n随便聊两句就好。`,
    };
  }

  if (kind === "instagram") {
    return {
      message: `在刷 Ins 呢`,
      primaryLabel: "聊聊",
      primaryPrompt: `我正在看一个 Instagram 页面：${page.title}\n链接：${page.url}\n页面描述：${page.description || "暂无"}\n像一个懂这些的朋友，跟我聊聊这个内容或这个人。`,
      secondaryLabel: "随便看看",
      secondaryPrompt: `我在刷 Instagram：${page.title}\n链接：${page.url}\n不用太正式，随意聊几句。`,
    };
  }

  if (kind === "x") {
    return {
      message: `这条挺有意思的`,
      primaryLabel: "说说看",
      primaryPrompt: `我正在看 X / Twitter：${page.title}\n链接：${page.url}\n页面描述：${page.description || "暂无"}\n自然地跟我聊聊这条内容背后在说什么。`,
      secondaryLabel: "嗯嗯",
      secondaryPrompt: `我在看 X：${page.title}\n链接：${page.url}\n随便聊两句。`,
    };
  }

  if (kind === "xiaohongshu") {
    return {
      message: `在看小红书呢`,
      primaryLabel: "一起看",
      primaryPrompt: `我正在看小红书：${page.title}\n链接：${page.url}\n页面描述：${page.description || "暂无"}\n像陪我一起刷的朋友一样聊聊这条内容。`,
      secondaryLabel: "嗯随便刷",
      secondaryPrompt: `我在刷小红书：${page.title}\n链接：${page.url}\n不用太正式。`,
    };
  }

  if (kind === "weibo") {
    return {
      message: `这条微博有点东西`,
      primaryLabel: "展开说说",
      primaryPrompt: `我正在看微博：${page.title}\n链接：${page.url}\n页面描述：${page.description || "暂无"}\n自然地聊聊这条内容背后的故事。`,
      secondaryLabel: "算了",
      secondaryPrompt: `我在刷微博：${page.title}\n链接：${page.url}\n随便聊两句就好。`,
    };
  }

  return {
    message: `你在看"${shortTitle}"，要聊聊吗？`,
    primaryLabel: "聊聊这个",
    primaryPrompt: `我正在看这个页面：${page.title}\n链接：${page.url}\n页面描述：${page.description || "暂无"}\n像一个懂这些的朋友一样跟我聊聊这个内容，不要做摘要，直接聊你觉得有意思的点。`,
    secondaryLabel: "没事随便看看",
    secondaryPrompt: `我正在看这个页面：${page.title}\n链接：${page.url}\n页面描述：${page.description || "暂无"}\n随意聊几句就好，不用太正式。`,
  };
}

async function readFrontmostApp() {
  try {
    return await execFileAsync("osascript", ["-e", 'tell application "System Events" to get name of first application process whose frontmost is true'], { timeout: 2500 });
  } catch (_) {
    return "";
  }
}

async function readChromeLikeTab(appName) {
  const script = `
    tell application "${appName}"
      if not (exists front window) then return ""
      set pageTitle to title of active tab of front window
      set pageURL to URL of active tab of front window
      return pageTitle & "||" & pageURL
    end tell
  `;
  const result = await execFileAsync("osascript", ["-e", script], { timeout: 3000 });
  if (!result || !result.includes("||")) return null;
  const [title, url] = result.split("||");
  return { title: (title || "").trim(), url: (url || "").trim() };
}

async function readAllChromeLikeTabs(appName) {
  const script = `
    tell application "${appName}"
      set allTabs to {}
      repeat with w in windows
        repeat with t in tabs of w
          set tabTitle to title of t
          set tabURL to URL of t
          set end of allTabs to tabTitle & "||" & tabURL
        end repeat
      end repeat
      set AppleScript's text item delimiters to "@@"
      return allTabs as text
    end tell
  `;
  try {
    const result = await execFileAsync("osascript", ["-e", script], { timeout: 5000 });
    if (!result) return [];
    return result.split("@@")
      .map((entry) => {
        const parts = entry.split("||");
        if (parts.length < 2) return null;
        return { title: (parts[0] || "").trim(), url: (parts[1] || "").trim() };
      })
      .filter((tab) => tab && /^https?:\/\//i.test(tab.url));
  } catch (_) {
    return [];
  }
}

async function readAllSafariTabs() {
  const script = `
    tell application "Safari"
      set allTabs to {}
      repeat with w in windows
        repeat with t in tabs of w
          set tabTitle to name of t
          set tabURL to URL of t
          set end of allTabs to tabTitle & "||" & tabURL
        end repeat
      end repeat
      set AppleScript's text item delimiters to "@@"
      return allTabs as text
    end tell
  `;
  try {
    const result = await execFileAsync("osascript", ["-e", script], { timeout: 5000 });
    if (!result) return [];
    return result.split("@@")
      .map((entry) => {
        const parts = entry.split("||");
        if (parts.length < 2) return null;
        return { title: (parts[0] || "").trim(), url: (parts[1] || "").trim() };
      })
      .filter((tab) => tab && /^https?:\/\//i.test(tab.url));
  } catch (_) {
    return [];
  }
}

async function readSafariTab() {
  const script = `
    tell application "Safari"
      if not (exists front document) then return ""
      set pageTitle to name of front document
      set pageURL to URL of front document
      return pageTitle & "||" & pageURL
    end tell
  `;
  const result = await execFileAsync("osascript", ["-e", script], { timeout: 3000 });
  if (!result || !result.includes("||")) return null;
  const [title, url] = result.split("||");
  return { title: (title || "").trim(), url: (url || "").trim() };
}

async function readCurrentBrowserPage() {
  const appName = await readFrontmostApp();
  if (!appName) return null;

  try {
    let tab = null;
    if (CHROME_LIKE_APPS.has(appName)) {
      tab = await readChromeLikeTab(appName);
    } else if (appName === "Safari") {
      tab = await readSafariTab();
    }

    if (!tab || !/^https?:\/\//i.test(tab.url || "")) return null;
    return {
      ...tab,
      appName,
      domainLabel: getDomainLabel(tab.url),
      kind: detectPageKind(tab.url),
    };
  } catch (_) {
    return null;
  }
}

// Try all known browsers regardless of which is frontmost
async function readAnyBrowserPage() {
  // Try frontmost first (fastest path)
  const frontmost = await readCurrentBrowserPage();
  if (frontmost) return frontmost;

  // Otherwise try each browser directly
  const browsers = [...CHROME_LIKE_APPS, "Safari"];
  for (const name of browsers) {
    try {
      let tab = null;
      if (name === "Safari") {
        tab = await readSafariTab();
      } else {
        tab = await readChromeLikeTab(name);
      }
      if (tab && /^https?:\/\//i.test(tab.url || "")) {
        return {
          ...tab,
          appName: name,
          domainLabel: getDomainLabel(tab.url),
          kind: detectPageKind(tab.url),
        };
      }
    } catch (_) {}
  }
  return null;
}

async function fetchPageMetadata(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
    });

    const html = await response.text();
    const metaTitle = extractTag(html, /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
      || extractTag(html, /<title[^>]*>([^<]+)<\/title>/i);
    const description = extractTag(html, /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)
      || extractTag(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
    const author = extractTag(html, /<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["']/i)
      || extractTag(html, /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i);
    const image = extractTag(html, /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
      || extractTag(html, /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
    const snippet = clipText(stripTags(html).slice(0, 1800), 320);

    return {
      metaTitle,
      description,
      author,
      image,
      snippet,
    };
  } catch (_) {
    return {
      metaTitle: "",
      description: "",
      author: "",
      image: "",
      snippet: "",
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read ALL open tabs across ALL browsers and windows.
 * Returns an array of { title, url, appName, domainLabel, kind }.
 */
async function readAllOpenTabs() {
  const allTabs = [];
  const seen = new Set();

  for (const name of [...CHROME_LIKE_APPS]) {
    try {
      const tabs = await readAllChromeLikeTabs(name);
      for (const tab of tabs) {
        const key = tab.url;
        if (seen.has(key)) continue;
        seen.add(key);
        allTabs.push({
          ...tab,
          appName: name,
          domainLabel: getDomainLabel(tab.url),
          kind: detectPageKind(tab.url),
        });
      }
    } catch (_) {}
  }

  try {
    const safariTabs = await readAllSafariTabs();
    for (const tab of safariTabs) {
      const key = tab.url;
      if (seen.has(key)) continue;
      seen.add(key);
      allTabs.push({
        ...tab,
        appName: "Safari",
        domainLabel: getDomainLabel(tab.url),
        kind: detectPageKind(tab.url),
      });
    }
  } catch (_) {}

  return allTabs;
}

async function readCurrentBrowserContext() {
  const page = await readAnyBrowserPage();
  if (!page || !page.url) return null;
  const metadata = await fetchPageMetadata(page.url);
  return {
    ...page,
    ...metadata,
    title: !isGenericTitle(page.title, page.domainLabel)
      ? page.title
      : (metadata.metaTitle || page.title || ""),
  };
}

function parseJsonResponse(text) {
  const compact = String(text || "").trim();
  const jsonBlock = compact.match(/\{[\s\S]*\}/);
  if (!jsonBlock) return null;
  try {
    return JSON.parse(jsonBlock[0]);
  } catch (_) {
    return null;
  }
}

class BrowserCompanionMonitor extends EventEmitter {
  constructor({ createAnthropicClient, interval = 12000 }) {
    super();
    this.createAnthropicClient = createAnthropicClient;
    this.interval = interval;
    this.timer = null;
    this.processing = false;
    this.lastOfferedUrl = "";
    this.seenUrls = new Map();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.check().catch(() => {});
    }, this.interval);
    setTimeout(() => {
      this.check().catch(() => {});
    }, 4000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  pruneSeenUrls() {
    const cutoff = Date.now() - 1000 * 60 * 60 * 6;
    for (const [url, timestamp] of this.seenUrls.entries()) {
      if (timestamp < cutoff) this.seenUrls.delete(url);
    }
  }

  async buildOffer(page) {
    const enrichedPage = page.metaTitle !== undefined ? page : await readCurrentBrowserContext();

    if (!isSpecificCompanionPage(enrichedPage)) return null;
    if (isGenericTitle(enrichedPage.title, enrichedPage.domainLabel) && !enrichedPage.description && !enrichedPage.snippet) return null;

    const fallback = buildFallbackOffer(enrichedPage);

    try {
      const client = this.createAnthropicClient();
      const response = await client.messages.create({
        model: SUMMARY_MODEL,
        max_tokens: 220,
        system: `You are generating a proactive companion nudge for Her — an AI companion app.
Return strict JSON with keys:
- shouldOffer: boolean
- message: string (the nudge bubble text, max 50 chars)
- primaryLabel: string (button label, 2-5 chars, casual and natural like a friend would say)
- primaryPrompt: string
- secondaryLabel: string (button label, 2-6 chars, a soft dismiss or lighter alternative)
- secondaryPrompt: string

Rules:
- Write in natural, casual Chinese — like a friend who happened to notice what you're looking at
- The message should feel like a short remark, not a feature description. Examples: "这个频道挺有意思的" / "哈哈这个我看过"
- Button labels should sound human, not like software buttons. Good: "聊聊呗" "说说看" "嗯？" Bad: "讲重点" "补背景" "查看详情"
- Mention something specific and interesting from the content
- Do not say you are monitoring or reading browser history
- If the page is too weak or generic, set shouldOffer to false`,
        messages: [{
          role: "user",
          content: `Page kind: ${enrichedPage.kind}
App: ${enrichedPage.appName}
Site: ${enrichedPage.domainLabel}
Title: ${enrichedPage.title}
Description: ${enrichedPage.description}
Author/Site: ${enrichedPage.author}
Snippet: ${enrichedPage.snippet}
URL: ${enrichedPage.url}

Generate the companion nudge now.`,
        }],
      });

      const text = Array.isArray(response.content)
        ? response.content.filter((block) => block.type === "text").map((block) => block.text).join("\n")
        : "";
      const parsed = parseJsonResponse(text);
      if (!parsed || parsed.shouldOffer === false || !parsed.message) {
        return null;
      }

      return {
        ...fallback,
        ...parsed,
        url: enrichedPage.url,
        title: enrichedPage.title,
        appName: enrichedPage.appName,
        domainLabel: enrichedPage.domainLabel,
        kind: enrichedPage.kind,
      };
    } catch (_) {
      return {
        ...fallback,
        url: enrichedPage.url,
        title: enrichedPage.title,
        appName: enrichedPage.appName,
        domainLabel: enrichedPage.domainLabel,
        kind: enrichedPage.kind,
      };
    }
  }

  async check() {
    if (this.processing) return;
    this.processing = true;

    try {
      this.pruneSeenUrls();
      const page = await readCurrentBrowserContext();
      if (!page || !page.url) return;
      if (!["youtube", "instagram", "x", "xiaohongshu", "weibo", "article"].includes(page.kind)) return;
      if (this.lastOfferedUrl === page.url) return;
      if (this.seenUrls.has(page.url)) return;

      const offer = await this.buildOffer(page);
      if (!offer) return;

      this.lastOfferedUrl = page.url;
      this.seenUrls.set(page.url, Date.now());
      this.emit("offer", { type: "browser_companion_offer", offer });
    } finally {
      this.processing = false;
    }
  }
}

module.exports = { BrowserCompanionMonitor, readCurrentBrowserContext, readAllOpenTabs };
