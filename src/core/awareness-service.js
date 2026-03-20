/**
 * Awareness Service — Turns raw signals into human-level understanding.
 *
 * Instead of injecting "Open apps: Arc, Figma" into the prompt,
 * this service periodically digests all signals into a short narrative:
 * "用户正在用 Figma 做设计，同时在 Arc 里查参考资料，听着 Lo-fi 音乐，应该在专注创作。"
 *
 * Two outputs:
 * 1. `currentActivity` — What the user is doing RIGHT NOW (updates every few minutes)
 * 2. `recentNarrative` — What the user has been up to in the last few hours (updates less often)
 */

const { SUMMARY_MODEL } = require("./shared/constants");

function clipText(text, limit = 200) {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit)}...` : compact;
}

function parseJsonSafe(text) {
  const match = String(text || "").match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch (_) { return null; }
}

function buildSignalSummary({ environmentSnapshot, profileSummary, recentMemories }) {
  const parts = [];

  if (environmentSnapshot) {
    const env = environmentSnapshot;
    if (env.activeApps && env.activeApps.length > 0) {
      parts.push(`当前打开的应用：${env.activeApps.slice(0, 8).join("、")}`);
    }
    if (env.nowPlaying) parts.push(`正在播放：${env.nowPlaying}`);
    if (env.wifi) parts.push(`Wi-Fi：${env.wifi}`);
    if (env.recentFiles && env.recentFiles.length > 0) {
      parts.push(`最近改动的文件：${env.recentFiles.slice(0, 6).join("、")}`);
    }
  }

  if (profileSummary) {
    parts.push(`已知的用户画像：\n${profileSummary}`);
  }

  if (recentMemories && recentMemories.length > 0) {
    const memLines = recentMemories.slice(0, 5).map((m) => `${m.key}: ${clipText(m.value, 80)}`);
    parts.push(`最近的记忆：\n${memLines.join("\n")}`);
  }

  return parts.join("\n\n");
}

class AwarenessService {
  constructor({ createAnthropicClient, stores, environmentMonitor }) {
    this.createAnthropicClient = createAnthropicClient;
    this.stores = stores;
    this.environmentMonitor = environmentMonitor;
    this.timer = null;
    this._running = false;

    // The outputs
    this.currentActivity = "";   // "正在用 Figma 做设计项目"
    this.recentNarrative = "";   // "这几个小时一直在设计相关的工作..."
    this.lastActivityUpdate = 0;
    this.lastNarrativeUpdate = 0;
  }

  start() {
    if (this.timer) return;
    // Activity update: every 3 minutes
    this.timer = setInterval(() => this._tick(), 3 * 60 * 1000);
    // First run after 8 seconds (let other services init first)
    setTimeout(() => this._tick(), 8000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Get the awareness context for injecting into system prompt.
   * This is called on every message — must be fast (no async).
   */
  getContext() {
    const parts = [];
    if (this.currentActivity) parts.push(this.currentActivity);
    if (this.recentNarrative) parts.push(this.recentNarrative);
    return parts.join("\n\n") || "";
  }

  async _tick() {
    if (this._running) return;
    this._running = true;

    try {
      const now = Date.now();

      // Always try to update current activity (lightweight)
      if (now - this.lastActivityUpdate > 2 * 60 * 1000) {
        await this._updateActivity();
        this.lastActivityUpdate = now;
      }

      // Update narrative less often (every 30 min)
      if (now - this.lastNarrativeUpdate > 30 * 60 * 1000) {
        await this._updateNarrative();
        this.lastNarrativeUpdate = now;
      }
    } catch (err) {
      console.error("[Awareness] tick error:", err.message);
    } finally {
      this._running = false;
    }
  }

  async _updateActivity() {
    const env = this.environmentMonitor ? this.environmentMonitor.getSnapshot() : null;
    if (!env) return;

    // Build a short signal block for the LLM
    const signals = [];
    if (env.activeApps && env.activeApps.length > 0) {
      signals.push(`打开的应用：${env.activeApps.slice(0, 8).join("、")}`);
    }
    if (env.nowPlaying) signals.push(`正在听：${env.nowPlaying}`);
    if (env.wifi) signals.push(`网络：${env.wifi}`);
    if (env.recentFiles && env.recentFiles.length > 0) {
      signals.push(`最近改动文件：${env.recentFiles.slice(0, 5).join("、")}`);
    }

    if (signals.length === 0) {
      this.currentActivity = "";
      return;
    }

    const hour = new Date().getHours();
    const timeHint = hour < 6 ? "凌晨" : hour < 9 ? "早上" : hour < 12 ? "上午" : hour < 14 ? "中午" : hour < 18 ? "下午" : hour < 22 ? "晚上" : "深夜";

    try {
      const client = this.createAnthropicClient();
      const response = await client.chat.completions.create({
        model: SUMMARY_MODEL,
        max_tokens: 120,
        messages: [
          {
            role: "system",
            content: `你是一个观察助手。根据用户电脑的实时信号，用一两句自然的中文描述用户此刻大概在做什么。
不要列举应用名，而是推断行为。不要说"用户"，用"你"。要具体但简短。
示例：
- 信号：Figma, Arc, Spotify playing lo-fi → "你在做设计，开着浏览器查资料，听着 lo-fi 专注中。"
- 信号：VS Code, Terminal, Safari → "你在写代码，可能在调试什么。"
- 信号：没有太多活跃应用 → 输出空字符串
现在是${timeHint}。`,
          },
          {
            role: "user",
            content: signals.join("\n"),
          },
        ],
      });

      const text = (response.choices[0].message.content || "").trim();

      this.currentActivity = clipText(text, 150);
    } catch (_) {
      // Keep previous activity on failure
    }
  }

  async _updateNarrative() {
    const env = this.environmentMonitor ? this.environmentMonitor.getSnapshot() : null;
    const profileSummary = this.stores.profileStore ? this.stores.profileStore.getPromptSummary(0.2) : "";
    const recentMemories = this.stores.memoryStore ? this.stores.memoryStore.getRelevant(6) : [];

    const signalBlock = buildSignalSummary({
      environmentSnapshot: env,
      profileSummary,
      recentMemories,
    });

    if (!signalBlock || signalBlock.length < 20) {
      return; // Not enough data
    }

    try {
      const client = this.createAnthropicClient();
      const response = await client.chat.completions.create({
        model: SUMMARY_MODEL,
        max_tokens: 200,
        messages: [
          {
            role: "system",
            content: `你是用户的 AI 伴侣的内部观察模块。根据以下信号，写一段简短的中文描述，概括这个用户最近的状态和正在做的事情。

要求：
- 用第三人称"用户"
- 重点是：正在推进什么事、关注什么话题、生活节奏是什么样的
- 不要重复列举数据，要做推断和归纳
- 2-4 句话，不超过 150 字
- 这段描述会被注入到对话系统的提示词中，目的是让 AI 在对话时自然地表现出对用户的了解`,
          },
          {
            role: "user",
            content: signalBlock,
          },
        ],
      });

      const text = (response.choices[0].message.content || "").trim();

      if (text.length > 10) {
        this.recentNarrative = clipText(text, 300);
      }
    } catch (_) {
      // Keep previous narrative on failure
    }
  }
}

module.exports = { AwarenessService };
