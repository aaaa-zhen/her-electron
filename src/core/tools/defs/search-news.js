const http = require("http");
const https = require("https");
const { BaseTool } = require("../base-tool");

const SEARXNG_URL = process.env.SEARXNG_URL || "http://localhost:8080";

function searxngNews(query, options = {}) {
  const params = new URLSearchParams({
    q: query,
    format: "json",
    categories: "news",
    language: options.lang || "auto",
    safesearch: "0",
    pageno: "1",
  });
  if (options.timeRange) params.set("time_range", options.timeRange);

  const url = `${SEARXNG_URL}/search?${params.toString()}`;
  const mod = url.startsWith("https") ? https : http;

  return new Promise((resolve, reject) => {
    const req = mod.get(url, { timeout: 15000 }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        if (res.statusCode !== 200) {
          reject(new Error(`SearxNG returned ${res.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(body)); } catch { reject(new Error("Invalid JSON")); }
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

function checkSearxngAvailable() {
  return new Promise((resolve) => {
    const mod = SEARXNG_URL.startsWith("https") ? https : http;
    const req = mod.get(`${SEARXNG_URL}/healthz`, { timeout: 3000 }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

// ── Fallback: Bing RSS → Google News RSS ────────────────────────────────

async function fallbackNews(query, numResults, ctx) {
  const items = [];

  // Try Bing News RSS
  try {
    const bingUrl = `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss`;
    const rss = await ctx.execAsync(
      `curl -Ls --max-time 15 -H "User-Agent: Mozilla/5.0" "${bingUrl}"`,
      { timeout: 20000, cwd: ctx.paths.sharedDir }
    );
    if (rss.includes("<item>")) {
      const itemRegex = /<item>([\s\S]*?)<\/item>/g;
      let match;
      while ((match = itemRegex.exec(rss)) !== null && items.length < numResults) {
        const block = match[1];
        const title = extractTag(block, "title");
        const link = extractTag(block, "link");
        const desc = extractTag(block, "description");
        const pubDate = extractTag(block, "pubDate");
        const sourceMatch = block.match(/<News:Source>([^<]+)<\/News:Source>/i);
        items.push({
          title,
          url: link,
          snippet: desc || "暂无摘要",
          publishedAt: pubDate ? formatDate(pubDate) : "",
          source: sourceMatch ? decodeHtml(sourceMatch[1]).trim() : "",
        });
      }
      if (items.length > 0) return items;
    }
  } catch (_) {}

  // Try Google News RSS
  try {
    const gUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`;
    const rss = await ctx.execAsync(
      `curl -Ls --max-time 20 "${gUrl}"`,
      { timeout: 25000, cwd: ctx.paths.sharedDir }
    );
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(rss)) !== null && items.length < numResults) {
      const block = match[1];
      const title = extractTag(block, "title").replace(/\s+-\s+[^-]+$/, "");
      const link = extractTag(block, "link");
      const desc = extractTag(block, "description");
      const pubDate = extractTag(block, "pubDate");
      const sourceMatch = block.match(/<source[^>]*>([\s\S]*?)<\/source>/i);
      items.push({
        title,
        url: link,
        snippet: stripHtml(desc) || "暂无摘要",
        publishedAt: pubDate ? formatDate(pubDate) : "",
        source: sourceMatch ? stripHtml(sourceMatch[1]).trim() : "",
      });
    }
  } catch (_) {}

  return items;
}

function extractTag(block, tagName) {
  const match = String(block || "").match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, "i"));
  return match ? stripHtml(match[1]).trim() : "";
}

function stripHtml(str) {
  return String(str || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ").trim();
}

function decodeHtml(str) {
  return String(str || "")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "";
  return date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// ── The Tool ────────────────────────────────────────────────────────────

class SearchNewsTool extends BaseTool {
  get name() { return "search_news"; }
  get timeout() { return 30000; }
  get description() {
    return "Search recent news. Returns headlines, sources and summaries. Uses SearxNG news category with fallback to Bing/Google News RSS.";
  }
  get input_schema() {
    return {
      type: "object",
      properties: {
        query: { type: "string", description: "News search query" },
        num_results: { type: "integer", description: "Number of results (1-10). Default: 5" },
        lang: { type: "string", description: "Language: zh-CN, en, etc. Default: auto" },
        time_range: { type: "string", description: "Time filter: day, week, month. Default: week" },
      },
      required: ["query"],
    };
  }

  async execute(input, ctx) {
    const { query, num_results = 5, lang, time_range = "week" } = input;
    const numResults = Math.max(1, Math.min(num_results || 5, 10));

    let results = [];
    let source = "";

    // Try SearxNG
    const available = await checkSearxngAvailable();
    if (available) {
      try {
        const data = await searxngNews(query, { lang, timeRange: time_range });
        results = (data.results || []).slice(0, numResults).map((r) => ({
          title: r.title || "",
          url: r.url || "",
          snippet: r.content || "",
          publishedAt: r.publishedDate ? formatDate(r.publishedDate) : "",
          source: r.engine || (r.engines || []).join(",") || "",
        }));
        source = "searxng";
      } catch (err) {
        console.error("[News] SearxNG error:", err.message);
      }
    }

    // Fallback
    if (results.length === 0) {
      results = await fallbackNews(query, numResults, ctx);
      source = "fallback";
    }

    if (results.length === 0) {
      return { content: `No news found for: ${query}`, is_error: true };
    }

    // Emit as news cards for rich rendering
    ctx.emit({
      type: "news_cards",
      query,
      cards: results.map((r) => ({
        title: r.title,
        url: r.url,
        summary: r.snippet,
        source: r.source,
        publishedAt: r.publishedAt,
        imageUrl: "",
      })),
    });

    // Also return text for the model
    const lines = results.map((r, i) => {
      const parts = [`[${i + 1}] ${r.title}`];
      if (r.source) parts[0] += ` — ${r.source}`;
      if (r.publishedAt) parts[0] += ` (${r.publishedAt})`;
      parts.push(`    ${r.url}`);
      if (r.snippet) parts.push(`    ${r.snippet}`);
      return parts.join("\n");
    });

    return `${results.length} news results:\n\n${lines.join("\n\n")}`;
  }
}

module.exports = SearchNewsTool;
