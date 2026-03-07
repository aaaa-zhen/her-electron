const EventEmitter = require("events");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { SUMMARY_MODEL } = require("./shared/constants");
const { DIMENSIONS } = require("./storage/profile-store");
const { extractProfileObservations } = require("./chat/profile-extractor");

const CHROMIUM_BROWSERS = [
  { id: "chrome", label: "Chrome", root: path.join(os.homedir(), "Library/Application Support/Google/Chrome") },
  { id: "arc", label: "Arc", root: path.join(os.homedir(), "Library/Application Support/Arc/User Data") },
  { id: "brave", label: "Brave", root: path.join(os.homedir(), "Library/Application Support/BraveSoftware/Brave-Browser") },
  { id: "edge", label: "Edge", root: path.join(os.homedir(), "Library/Application Support/Microsoft Edge") },
];

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message || "Command failed").trim()));
        return;
      }
      resolve(String(stdout || "").trim());
    });
  });
}

function clipText(text, limit = 180) {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.length > limit ? `${compact.slice(0, limit)}...` : compact;
}

function parseJsonResponse(text) {
  const compact = String(text || "").trim();
  const match = compact.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch (_) {
    return null;
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function normalizeUrl(value) {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    return parsed.toString();
  } catch (_) {
    return String(value || "").trim();
  }
}

function toChromeDate(rawValue) {
  const timestamp = Number(rawValue || 0);
  if (!timestamp) return null;
  const unixMs = (timestamp / 1000) - 11644473600000;
  if (!Number.isFinite(unixMs)) return null;
  return new Date(unixMs);
}

function toSafariDate(rawValue) {
  const seconds = Number(rawValue || 0);
  if (!Number.isFinite(seconds)) return null;
  return new Date((seconds + 978307200) * 1000);
}

function findChromiumProfiles(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && (/^Default$/i.test(entry.name) || /^Profile \d+$/i.test(entry.name)))
    .map((entry) => path.join(root, entry.name))
    .filter((profilePath) => fs.existsSync(path.join(profilePath, "History")));
}

function extractSearchQuery(url) {
  try {
    const parsed = new URL(url);
    const q = parsed.searchParams.get("q") || parsed.searchParams.get("query") || parsed.searchParams.get("search_query");
    return clipText(q || "", 80);
  } catch (_) {
    return "";
  }
}

function buildSignalText(entry) {
  const pieces = [];
  if (entry.query) pieces.push(entry.query);
  if (entry.title) pieces.push(entry.title);
  if (entry.domain) pieces.push(entry.domain);
  return clipText(pieces.join(" · "), 200);
}

function isIgnorableEntry(entry) {
  const title = String(entry.title || "").trim().toLowerCase();
  const url = String(entry.url || "").trim().toLowerCase();
  const domain = String(entry.domain || "").trim().toLowerCase();
  let pathname = "/";
  try {
    pathname = new URL(url).pathname || "/";
  } catch (_) {}

  if (!url || url.startsWith("chrome://") || url.startsWith("about:")) return true;
  if (domain === "accounts.google.com" || domain === "localhost" || domain.startsWith("127.")) return true;
  if (/(login|log in|sign in|settings|authentication successful)/i.test(title)) return true;
  if (domain.includes("youtube.com") && (/^youtube$/i.test(title) || /youtube\.com\/?$/.test(url) || /youtube\.com\/\?/.test(url))) return true;
  if ((domain.includes("x.com") || domain.includes("twitter.com")) && /\/home\/?$/.test(pathname)) return true;
  if (title === "google" && url.includes("google.")) return true;
  if (title === "(no title)" || !title) return !entry.query;
  return false;
}

function dedupeEntries(entries) {
  const seen = new Set();
  const result = [];
  for (const entry of entries) {
    const fingerprint = `${entry.url}::${entry.visitedAt}`;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    result.push(entry);
  }
  return result;
}

function buildTopDomains(entries, limit = 6) {
  const counts = new Map();
  for (const entry of entries) {
    if (!entry.domain) continue;
    counts.set(entry.domain, (counts.get(entry.domain) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([domain, visits]) => ({ domain, visits }));
}

function buildTopThreads(entries, limit = 6) {
  const counts = new Map();
  for (const entry of entries) {
    const key = entry.query || entry.title || entry.domain;
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([label, visits]) => ({ label: clipText(label, 72), visits }));
}

function buildFallbackDigest(entries) {
  const topDomains = buildTopDomains(entries, 5);
  const topThreads = buildTopThreads(entries, 5);
  const combinedTexts = entries.slice(0, 36).map((entry) => buildSignalText(entry)).filter(Boolean);

  const observations = [];
  for (const text of combinedTexts) {
    observations.push(...extractProfileObservations({
      userText: text,
      assistantText: "",
      timestamp: new Date().toISOString(),
      messageCount: 0,
    }));
  }

  const summary = topThreads.length > 0
    ? `最近浏览主线主要集中在：${topThreads.slice(0, 3).map((item) => item.label).join("； ")}`
    : "最近没有抓到足够清晰的浏览主线。";

  return {
    summary,
    topThreads: topThreads.map((item) => item.label),
    topDomains: topDomains.map((item) => item.domain),
    observations: observations.slice(0, 24),
  };
}

async function querySqliteJson(dbPath, sql) {
  const raw = await execFileAsync("sqlite3", ["-json", dbPath, sql], { timeout: 15000, maxBuffer: 1024 * 1024 * 4 });
  return JSON.parse(raw || "[]");
}

async function importChromiumHistory({ browser, root, cacheDir, days = 3 }) {
  const profiles = findChromiumProfiles(root);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const allEntries = [];

  for (const profilePath of profiles) {
    const historyPath = path.join(profilePath, "History");
    const cachePath = path.join(cacheDir, `${browser.id}-${path.basename(profilePath)}-History.db`);
    try {
      fs.copyFileSync(historyPath, cachePath);
      const rows = await querySqliteJson(cachePath, `
        SELECT urls.url as url,
               urls.title as title,
               urls.visit_count as visit_count,
               urls.typed_count as typed_count,
               visits.visit_time as visit_time,
               visits.visit_duration as visit_duration
        FROM visits
        JOIN urls ON urls.id = visits.url
        ORDER BY visits.visit_time DESC
        LIMIT 800;
      `);

      for (const row of rows) {
        const visitedAt = toChromeDate(row.visit_time);
        if (!visitedAt || visitedAt.getTime() < cutoff) continue;
        let domain = "";
        try {
          domain = new URL(row.url).hostname.replace(/^www\./, "");
        } catch (_) {}
        const entry = {
          browser: browser.id,
          browserLabel: browser.label,
          profile: path.basename(profilePath),
          url: normalizeUrl(row.url),
          title: clipText(row.title || "", 140),
          domain,
          visitCount: Number(row.visit_count || 0),
          typedCount: Number(row.typed_count || 0),
          visitDurationMs: Number(row.visit_duration || 0) / 1000,
          visitedAt: visitedAt.toISOString(),
          query: extractSearchQuery(row.url),
        };
        if (isIgnorableEntry(entry)) continue;
        entry.signalText = buildSignalText(entry);
        allEntries.push(entry);
      }
    } catch (_) {}
  }

  return allEntries;
}

async function importSafariHistory({ cacheDir, days = 3 }) {
  const sourcePath = path.join(os.homedir(), "Library/Safari/History.db");
  const cachePath = path.join(cacheDir, "safari-History.db");
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  try {
    fs.copyFileSync(sourcePath, cachePath);
    const rows = await querySqliteJson(cachePath, `
      SELECT history_items.url as url,
             history_visits.title as title,
             history_visits.visit_time as visit_time
      FROM history_visits
      JOIN history_items ON history_items.id = history_visits.history_item
      ORDER BY history_visits.visit_time DESC
      LIMIT 800;
    `);

    return rows.map((row) => {
      const visitedAt = toSafariDate(row.visit_time);
      let domain = "";
      try {
        domain = new URL(row.url).hostname.replace(/^www\./, "");
      } catch (_) {}
      return {
        browser: "safari",
        browserLabel: "Safari",
        profile: "Default",
        url: normalizeUrl(row.url),
        title: clipText(row.title || "", 140),
        domain,
        visitedAt: visitedAt ? visitedAt.toISOString() : "",
        visitCount: 1,
        typedCount: 0,
        visitDurationMs: 0,
        query: extractSearchQuery(row.url),
      };
    }).filter((entry) => entry.visitedAt && new Date(entry.visitedAt).getTime() >= cutoff && !isIgnorableEntry(entry))
      .map((entry) => ({ ...entry, signalText: buildSignalText(entry) }));
  } catch (error) {
    return { error: error.message || String(error), entries: [] };
  }
}

async function summarizeBrowsing({ client, entries }) {
  const condensed = entries.slice(0, 120).map((entry) => ({
    browser: entry.browserLabel,
    title: entry.title,
    domain: entry.domain,
    query: entry.query,
    visitedAt: entry.visitedAt,
  }));

  const response = await client.messages.create({
    model: SUMMARY_MODEL,
    max_tokens: 500,
    system: `You are analyzing a user's browser history to evolve Her's user-understanding model.
Return strict JSON with keys:
- summary: short Chinese paragraph
- topThreads: string[]
- topDomains: string[]
- observations: {dimension, trait, evidence, confidence}[]

Rules:
- Focus on repeated attention patterns, not one-off noise
- Prefer personality/workStyle/interests/values/communication/lifeContext/emotionalPatterns dimensions only
- dimension must be one of: ${DIMENSIONS.join(", ")}
- confidence should be between 0.08 and 0.35
- topThreads max 6, topDomains max 6, observations max 18
- Ignore login pages, home pages, generic tabs
- Write naturally in Chinese`,
    messages: [{
      role: "user",
      content: `Recent browsing entries:\n${JSON.stringify(condensed, null, 2)}`,
    }],
  });

  const text = Array.isArray(response.content)
    ? response.content.filter((block) => block.type === "text").map((block) => block.text).join("\n")
    : "";
  return parseJsonResponse(text);
}

class BrowserHistoryEvolutionService extends EventEmitter {
  constructor({ paths, stores, createAnthropicClient, emit, intervalMs = 60 * 60 * 1000 }) {
    super();
    this.paths = paths;
    this.stores = stores;
    this.createAnthropicClient = createAnthropicClient;
    this.emit = emit;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) return;
    this.tick().catch(() => {});
    this.timer = setInterval(() => {
      this.tick().catch(() => {});
    }, this.intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  shouldRunNow() {
    const settings = this.stores.settingsStore.get();
    if (!settings.browserHistoryEnabled) return false;

    const state = this.stores.browserHistoryStore.getState();
    if (!state.lastImportedAt) return true;

    const lastRun = new Date(state.lastImportedAt);
    if (Number.isNaN(lastRun.getTime())) return true;

    const now = new Date();
    const scanHour = Number(settings.browserHistoryScanHour || 4);
    const sameDay = now.toDateString() === lastRun.toDateString();
    if (sameDay) return false;
    if (now.getHours() >= scanHour) return true;

    return (Date.now() - lastRun.getTime()) > 30 * 60 * 60 * 1000;
  }

  async tick(force = false) {
    if (this.running) return;
    if (!force && !this.shouldRunNow()) return;
    this.running = true;

    try {
      ensureDir(path.join(this.paths.dataDir, "cache"));
      const cacheDir = path.join(this.paths.dataDir, "cache", "browser-history");
      ensureDir(cacheDir);

      const importedEntries = [];
      const sources = [];

      for (const browser of CHROMIUM_BROWSERS) {
        const entries = await importChromiumHistory({ browser, root: browser.root, cacheDir });
        if (entries.length > 0) {
          importedEntries.push(...entries);
          sources.push({ browser: browser.label, count: entries.length });
        }
      }

      const safari = await importSafariHistory({ cacheDir });
      if (Array.isArray(safari) && safari.length > 0) {
        importedEntries.push(...safari);
        sources.push({ browser: "Safari", count: safari.length });
      } else if (safari && safari.error) {
        sources.push({ browser: "Safari", count: 0, error: safari.error });
      }

      const filtered = dedupeEntries(importedEntries)
        .sort((a, b) => new Date(b.visitedAt) - new Date(a.visitedAt))
        .slice(0, 240);

      if (filtered.length === 0) {
        this.stores.browserHistoryStore.saveFailure("No readable browser history entries found");
        return;
      }

      let digest = null;
      try {
        digest = await summarizeBrowsing({ client: this.createAnthropicClient(), entries: filtered });
      } catch (_) {}

      if (!digest || !digest.summary) {
        digest = buildFallbackDigest(filtered);
      }

      const observations = Array.isArray(digest.observations)
        ? digest.observations
          .filter((item) => item && DIMENSIONS.includes(item.dimension) && item.trait)
          .map((item) => ({
            dimension: item.dimension,
            trait: clipText(item.trait, 60),
            evidence: clipText(item.evidence || digest.summary, 120),
            confidence: Math.max(0.08, Math.min(Number(item.confidence || 0.14), 0.35)),
          }))
        : [];

      if (observations.length > 0 && this.stores.profileStore) {
        this.stores.profileStore.observe(observations);
      }

      if (this.stores.memoryStore) {
        this.stores.memoryStore.saveEntry("最近浏览主线", digest.summary, {
          type: "relationship",
          tags: ["browser_history", "relationship"],
        });
        if (Array.isArray(digest.topThreads) && digest.topThreads.length > 0) {
          this.stores.memoryStore.saveEntry("最近浏览关注点", `最近持续在看：${digest.topThreads.slice(0, 4).join("； ")}`, {
            type: "project",
            tags: ["browser_history", "project"],
          });
        }
      }

      const normalizedDigest = {
        summary: clipText(digest.summary, 220),
        topThreads: (digest.topThreads || []).map((item) => typeof item === "string" ? clipText(item, 80) : clipText(item.label || "", 80)).filter(Boolean).slice(0, 6),
        topDomains: (digest.topDomains || []).map((item) => typeof item === "string" ? item : item.domain).filter(Boolean).slice(0, 6),
      };
      this.stores.browserHistoryStore.saveDigest({ digest: normalizedDigest, sources });

      if (typeof this.emit === "function") {
        this.emit({ type: "browser_history_digest", digest: normalizedDigest });
      }
    } catch (error) {
      this.stores.browserHistoryStore.saveFailure(error.message || String(error));
    } finally {
      this.running = false;
    }
  }
}

module.exports = { BrowserHistoryEvolutionService };
