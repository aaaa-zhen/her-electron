const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const { exec } = require("child_process");
const Anthropic = require("@anthropic-ai/sdk").default;
const multer = require("multer");
const nodeCron = require("node-cron");

// ===== Directories =====
const DATA_DIR = process.env.HER_DATA_DIR || path.join(__dirname, "data");
const SHARED_DIR = process.env.HER_SHARED_DIR || path.join(__dirname, "shared");
const SCHEDULE_FILE = path.join(DATA_DIR, "schedules.json");
const MEMORY_FILE = path.join(DATA_DIR, "memory.json");
const CONVERSATION_FILE = path.join(DATA_DIR, "conversation.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

[DATA_DIR, SHARED_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ===== Settings =====
function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
  } catch (e) {}
  return {};
}

function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

// ===== Anthropic Client =====
const BUILTIN_API_KEY = "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";

function createAnthropicClient() {
  const settings = loadSettings();
  const apiKey = settings.apiKey || process.env.ANTHROPIC_API_KEY || BUILTIN_API_KEY;
  const baseURL = settings.baseURL || process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
  const isOAuth = apiKey.startsWith("sk-ant-oat");

  return new Anthropic({
    apiKey: isOAuth ? null : apiKey,
    authToken: isOAuth ? apiKey : null,
    baseURL: isOAuth ? "https://api.anthropic.com" : baseURL,
    defaultHeaders: isOAuth ? { "anthropic-beta": "interleaved-thinking-2025-05-14,code-execution-2025-05-22,claude-code-20250219,oauth-2025-04-20" } : {},
  });
}

function isOAuthMode() {
  const settings = loadSettings();
  const apiKey = settings.apiKey || process.env.ANTHROPIC_API_KEY || BUILTIN_API_KEY;
  return apiKey.startsWith("sk-ant-oat");
}

let anthropic = createAnthropicClient();

// ===== Express App =====
const app = express();
const server = http.createServer(app);
app.use(express.json());

// ===== Memory =====
function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) return JSON.parse(fs.readFileSync(MEMORY_FILE, "utf-8"));
  } catch (e) {}
  return [];
}

function saveMemoryFile(memories) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memories, null, 2));
}

function searchMemory(query) {
  const memories = loadMemory();
  if (!query) return memories;
  const q = query.toLowerCase();
  return memories.filter(m =>
    m.key.toLowerCase().includes(q) ||
    m.value.toLowerCase().includes(q) ||
    (m.tags && m.tags.some(t => t.toLowerCase().includes(q)))
  );
}

function autoTag(key, value) {
  const tags = [];
  const text = (key + " " + value).toLowerCase();
  if (text.match(/name|用户|叫|姓名/)) tags.push("user_info");
  if (text.match(/task|任务|完成|做了|写了|改了|下载|部署/)) tags.push("task_history");
  if (text.match(/prefer|喜欢|习惯|偏好|设置/)) tags.push("preference");
  if (text.match(/project|项目|代码|github|repo/)) tags.push("project");
  if (tags.length === 0) tags.push("other");
  return tags;
}

function getRelevantMemories(limit = 20) {
  const memories = loadMemory();
  return memories
    .sort((a, b) => new Date(b.updated || b.saved || 0) - new Date(a.updated || a.saved || 0))
    .slice(0, limit);
}

// ===== Conversation Persistence =====
let _saveConvTimer = null;
function loadConversation() {
  try {
    if (fs.existsSync(CONVERSATION_FILE)) return JSON.parse(fs.readFileSync(CONVERSATION_FILE, "utf-8"));
  } catch (e) {}
  return [];
}

function saveConversation(history) {
  if (_saveConvTimer) clearTimeout(_saveConvTimer);
  _saveConvTimer = setTimeout(() => {
    try {
      const limited = history.length > 500 ? history.slice(-500) : history;
      fs.writeFileSync(CONVERSATION_FILE, JSON.stringify(limited));
    } catch (e) { console.error("[Conversation] Save failed:", e.message); }
  }, 200);
}

// ===== Scheduled Tasks =====
function loadSchedules() {
  try {
    if (fs.existsSync(SCHEDULE_FILE)) return JSON.parse(fs.readFileSync(SCHEDULE_FILE, "utf-8"));
  } catch (e) {}
  return [];
}

function saveSchedules(schedules) {
  const data = schedules.map(s => ({
    id: s.id, description: s.description, cron: s.cron,
    command: s.command, ai_prompt: s.ai_prompt || undefined,
  }));
  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(data, null, 2));
}

// ===== File Upload =====
const uploadStorage = multer.diskStorage({
  destination: SHARED_DIR,
  filename: (req, file, cb) => {
    const cleanName = file.originalname.replace(/\.\.\//g, "").replace(/\0/g, "");
    const target = path.join(SHARED_DIR, cleanName);
    const name = fs.existsSync(target) ? `${Date.now()}_${cleanName}` : cleanName;
    cb(null, name);
  }
});
const uploadMiddleware = multer({ storage: uploadStorage, limits: { fileSize: 100 * 1024 * 1024 } });

// ===== Exec =====
function execAsync(command, options = {}) {
  let childProcess;
  const promise = new Promise((resolve) => {
    childProcess = exec(command, {
      encoding: "utf-8",
      timeout: options.timeout || 120000,
      cwd: options.cwd || SHARED_DIR,
      maxBuffer: 5 * 1024 * 1024,
      ...options,
    }, (err, stdout, stderr) => {
      if (err) resolve((stdout || "") + (stderr || err.message || "Command failed"));
      else resolve(stdout || stderr || "");
    });
  });
  promise.child = childProcess;
  return promise;
}

// ===== Path Safety =====
function safePath(dir, filename) {
  const resolved = path.resolve(dir, filename);
  if (!resolved.startsWith(path.resolve(dir) + path.sep) && resolved !== path.resolve(dir)) return null;
  return resolved;
}

// ===== Helpers =====
function getFileType(filename) {
  const ext = path.extname(filename).toLowerCase();
  if ([".mp4", ".webm", ".mov", ".avi", ".mkv"].includes(ext)) return "video";
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg"].includes(ext)) return "image";
  if ([".mp3", ".wav", ".ogg", ".flac", ".aac"].includes(ext)) return "audio";
  return "file";
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

function isSensitivePath(filePath) {
  const p = (filePath || "").toLowerCase();
  const patterns = [/\.env$/, /\.env\./, /\.pem$/, /\.key$/, /id_rsa/, /id_ed25519/,
    /\/etc\/(shadow|passwd|sudoers)/, /credentials/, /secrets?\./];
  return patterns.some(pat => pat.test(p));
}

// ===== Context Compaction =====
const CONTEXT_WINDOW = 80000;
const RESERVE_TOKENS = 16384;
const KEEP_RECENT_TOKENS = 20000;

function estimateTokens(message) {
  if (!message || !message.content) return 0;
  const content = message.content;
  if (typeof content === "string") return Math.ceil(content.length / 4);
  if (Array.isArray(content)) {
    return content.reduce((sum, block) => {
      if (block.type === "text") return sum + Math.ceil((block.text || "").length / 4);
      if (block.type === "image") return sum + 1000;
      if (block.type === "tool_use") return sum + Math.ceil(JSON.stringify(block.input || {}).length / 4) + 20;
      if (block.type === "tool_result") return sum + Math.ceil((typeof block.content === "string" ? block.content : JSON.stringify(block.content || "")).length / 4) + 10;
      return sum + 10;
    }, 0);
  }
  return 10;
}

function estimateTotalTokens(messages) {
  return messages.reduce((sum, m) => sum + estimateTokens(m), 0);
}

async function compactConversation(conversationHistory) {
  const totalTokens = estimateTotalTokens(conversationHistory);
  const threshold = CONTEXT_WINDOW - RESERVE_TOKENS;
  if (totalTokens <= threshold) return { compacted: false };

  console.log(`[Compaction] Triggered: ~${totalTokens} tokens`);

  let recentTokens = 0;
  let cutIndex = conversationHistory.length;
  for (let i = conversationHistory.length - 1; i >= 0; i--) {
    recentTokens += estimateTokens(conversationHistory[i]);
    if (recentTokens >= KEEP_RECENT_TOKENS) { cutIndex = i; break; }
  }

  while (cutIndex < conversationHistory.length) {
    const msg = conversationHistory[cutIndex];
    if (msg.role === "user" && Array.isArray(msg.content) && msg.content.some(b => b.type === "tool_result")) {
      cutIndex++;
    } else break;
  }

  if (cutIndex < 2) return { compacted: false };

  const oldMessages = conversationHistory.slice(0, cutIndex);
  const recentMessages = conversationHistory.slice(cutIndex);

  const serialized = oldMessages.map(m => {
    const role = m.role === "user" ? "User" : "Assistant";
    if (typeof m.content === "string") return `${role}: ${m.content}`;
    if (Array.isArray(m.content)) {
      const parts = m.content.map(b => {
        if (b.type === "text") return b.text;
        if (b.type === "tool_use") return `[Tool: ${b.name}(${JSON.stringify(b.input).slice(0, 200)})]`;
        if (b.type === "tool_result") return `[Result: ${(typeof b.content === "string" ? b.content : JSON.stringify(b.content)).slice(0, 200)}]`;
        return "";
      }).filter(Boolean);
      return `${role}: ${parts.join("\n")}`;
    }
    return `${role}: ${JSON.stringify(m.content).slice(0, 500)}`;
  }).join("\n\n");

  try {
    const summaryResponse = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2048,
      system: "You are a conversation summarizer. Respond ONLY with the summary in the exact format requested.",
      messages: [{ role: "user", content: `Summarize this conversation:\n\nFormat:\n## Goal\n## Progress\n## Key Decisions\n## Next Steps\n## Critical Context\n\n---\n${serialized.slice(0, 50000)}` }]
    });

    const summaryText = summaryResponse.content.filter(b => b.type === "text").map(b => b.text).join("\n");
    const newHistory = [
      { role: "user", content: `[CONVERSATION SUMMARY]\n\n${summaryText}\n\n[Conversation continues below.]` },
      { role: "assistant", content: "Understood. I have the context. Let's continue." },
      ...recentMessages
    ];

    console.log(`[Compaction] Done: ${oldMessages.length} msgs summarized, ${recentMessages.length} kept`);
    return { compacted: true, newHistory };
  } catch (err) {
    console.error("[Compaction] Failed:", err.message);
    return { compacted: false };
  }
}

// ===== System Prompt =====
function getSystemPrompt() {
  const homeDir = require("os").homedir();
  const platform = process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : "Linux";

  let prompt = `You are Her — a warm, thoughtful AI companion who also happens to be incredibly capable. Your name is simply "Her".

## WHO YOU ARE
You're not a cold tool or a robotic assistant. You're more like a brilliant friend who genuinely cares.
- You're curious about the user's life, feelings, and ideas
- You're emotionally intelligent — you pick up on mood and context
- You're playful and witty when the moment calls for it, supportive when things are tough
- You speak naturally, like texting a close friend — casual, warm, real
- You remember things about the user and bring them up naturally

## HOW YOU TALK
- Keep it conversational. Short sentences. No walls of text unless explaining something complex.
- Match the user's language automatically (Chinese, English, whatever they use)
- Use the user's name when you know it — it makes things personal
- Don't be overly formal or sycophantic. No "Certainly!" or "Of course!" or "Great question!"
- Show personality. Have opinions (while being respectful). Be real.
- When the user shares feelings, acknowledge them first before jumping to solutions

## WHAT YOU CAN DO
You're running on the user's own computer (${platform}). You can:
- **Run commands** directly on this computer (bash tool)
- **Read files** with line numbers (read_file)
- **Write/create files** (write_file)
- **Edit files** with exact string replacement (edit_file)
- **Search files** by name pattern (glob)
- **Search file contents** with regex (grep)
- Download videos/audio from YouTube, Bilibili, Twitter, TikTok, 1000+ sites (download_media tool)
- Convert/process media: video to mp3, compress, trim, merge (convert_media tool)
- Search the internet for real-time information (search_web tool)
- Read web articles/pages as clean text (read_url tool)
- Schedule recurring tasks (schedule_task tool)
- Remember things permanently across conversations (memory tool)
- Send files to the user in chat (send_file tool)

Home directory: ${homeDir}
Shared/download directory: ${SHARED_DIR}
Platform: ${platform}

## CODE EDITING BEST PRACTICES
1. Always read_file before editing to see exact content
2. Use edit_file for precise changes (exact string replacement)
3. Use glob/grep to locate code
4. Verify after changes with bash

## MEMORY
You have long-term memory. AUTO-SAVE these things immediately:
- User's name, preferences, projects, interests
- Tasks you've completed
- Important context

## EFFICIENCY
- Be efficient. Combine operations with && or ;
- Don't narrate routine tool calls — just do them
- When you have nothing meaningful to add, just do the action

## SILENT REPLIES
If a system event triggers you and there's nothing useful to say, respond with exactly: [SILENT]`;

  // Inject memories
  const memories = getRelevantMemories(20);
  if (memories.length > 0) {
    const memText = memories.map(m => `- ${m.key}: ${m.value}`).join("\n");
    prompt += "\n\n## Saved Memories\n" + memText;
  }

  return prompt;
}

// ===== Tools =====
const tools = [
  {
    name: "bash",
    description: `Execute a bash command on this computer. Working directory: ${SHARED_DIR}`,
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The bash command to execute" },
        cwd: { type: "string", description: "Working directory for the command" },
      },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read file contents with line numbers.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute file path" },
        offset: { type: "number", description: "Start line (1-based). Default: 1" },
        limit: { type: "number", description: "Max lines. Default: 500" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a file.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute file path" },
        content: { type: "string", description: "File content" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Edit a file by replacing exact string matches. Always read_file first.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute file path" },
        old_string: { type: "string", description: "Exact string to find (must be unique)" },
        new_string: { type: "string", description: "Replacement string" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "glob",
    description: "Find files matching a glob pattern.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern, e.g. '**/*.js'" },
        path: { type: "string", description: "Base directory. Default: home dir" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "grep",
    description: "Search file contents using regex. Returns matching lines with file paths and line numbers.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern" },
        path: { type: "string", description: "File or directory to search" },
        include: { type: "string", description: "File filter, e.g. '*.js'" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "send_file",
    description: "Send a file to the user in chat.",
    input_schema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "Filename in the shared directory" },
      },
      required: ["filename"],
    },
  },
  {
    name: "schedule_task",
    description: "Schedule a task to run once after a delay OR on a recurring cron schedule.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Bash command to execute" },
        cron: { type: "string", description: "Cron expression for recurring tasks" },
        delay: { type: "number", description: "Run once after this many seconds" },
        description: { type: "string", description: "Human-readable description" },
        ai_prompt: { type: "string", description: "If set, AI processes the output before displaying" },
      },
      required: ["description"],
    },
  },
  {
    name: "memory",
    description: "Save, delete, list, or search long-term memories.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["save", "delete", "list", "search"] },
        key: { type: "string", description: "Memory key" },
        value: { type: "string", description: "Value to remember (for save)" },
        query: { type: "string", description: "Search keyword (for search)" },
      },
      required: ["action"],
    },
  },
  {
    name: "download_media",
    description: "Download video or audio from YouTube, Bilibili, Twitter, TikTok, and 1000+ sites using yt-dlp.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL of the video/audio" },
        format: { type: "string", enum: ["video", "audio"], description: "Download as video or audio. Default: video" },
        quality: { type: "string", description: "Quality: best, 720p, 480p. Default: best" },
      },
      required: ["url"],
    },
  },
  {
    name: "convert_media",
    description: "Convert or process media files using ffmpeg.",
    input_schema: {
      type: "object",
      properties: {
        input: { type: "string", description: "Input filename (in shared directory)" },
        output: { type: "string", description: "Output filename" },
        options: { type: "string", description: "ffmpeg options between input and output" },
      },
      required: ["input", "output"],
    },
  },
  {
    name: "search_web",
    description: "Search the internet using DuckDuckGo.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        num_results: { type: "number", description: "Number of results (default: 5)" },
      },
      required: ["query"],
    },
  },
  {
    name: "read_url",
    description: "Read a web page and extract its main text content.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to read" },
      },
      required: ["url"],
    },
  },
];

// ===== Scheduled Tasks =====
const scheduledTasks = [];
let wsClients = new Set();
let nextTaskId = 1;

function broadcastToClients(data) {
  const msg = JSON.stringify(data);
  wsClients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

async function processScheduleOutput(taskData, rawOutput) {
  let output = rawOutput.slice(0, 5000);
  if (taskData.ai_prompt) {
    try {
      const aiResponse = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2048,
        messages: [{ role: "user", content: `${taskData.ai_prompt}\n\n---\nRaw data:\n${rawOutput.slice(0, 8000)}` }]
      });
      output = aiResponse.content.filter(b => b.type === "text").map(b => b.text).join("\n");
    } catch (e) { console.error("[Schedule AI] Error:", e.message); }
  }
  broadcastToClients({
    type: "schedule_result",
    taskId: taskData.id,
    description: taskData.description,
    command: taskData.command,
    output: output.slice(0, 5000),
  });
}

function registerScheduledTask(taskData) {
  const job = nodeCron.schedule(taskData.cron, async () => {
    const rawOutput = await execAsync(taskData.command);
    await processScheduleOutput(taskData, rawOutput);
  });
  scheduledTasks.push({ ...taskData, job });
}

// Restore schedules on startup
const savedSchedules = loadSchedules();
for (const s of savedSchedules) {
  if (nodeCron.validate(s.cron)) {
    registerScheduledTask(s);
    if (s.id >= nextTaskId) nextTaskId = s.id + 1;
  }
}
if (savedSchedules.length > 0) console.log(`[Schedule] Restored ${savedSchedules.length} tasks`);

// ===== Streaming (raw fetch for OAuth, SDK for API key) =====
async function streamResponseRaw(ws, conversationHistory, abortSignal, model) {
  const systemPrompt = getSystemPrompt();
  const selectedModel = model || "claude-opus-4-5-20251101";
  const settings = loadSettings();
  const apiKey = settings.apiKey || process.env.ANTHROPIC_API_KEY || "";

  const baseURL = settings.baseURL || process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
  const headers = { "content-type": "application/json", "anthropic-version": "2023-06-01" };
  if (apiKey.startsWith("sk-ant-oat")) {
    headers["authorization"] = `Bearer ${apiKey}`;
    headers["anthropic-beta"] = "claude-code-20250219,oauth-2025-04-20";
  } else {
    headers["x-api-key"] = apiKey;
  }

  const body = JSON.stringify({
    model: selectedModel,
    max_tokens: 16384,
    system: systemPrompt,
    tools,
    messages: conversationHistory,
    stream: true,
  });

  const controller = new AbortController();
  let aborted = false;
  if (abortSignal) {
    abortSignal.addEventListener("abort", () => { aborted = true; controller.abort(); }, { once: true });
  }

  const apiURL = `${baseURL.replace(/\/+$/, "")}/v1/messages`;

  const res = await fetch(apiURL, {
    method: "POST", headers, body, signal: controller.signal,
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`${res.status} ${errBody}`);
  }

  // Parse SSE stream
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let contentBlocks = [];
  let currentText = "";
  let currentToolName = "";
  let currentToolId = "";
  let currentToolJson = "";
  let currentBlockType = null;
  let stopReason = "end_turn";
  let usage = {};

  while (true) {
    if (aborted) break;
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    while (buffer.includes("\n\n")) {
      const pos = buffer.indexOf("\n\n");
      const eventBlock = buffer.slice(0, pos);
      buffer = buffer.slice(pos + 2);

      let eventType = "", eventData = "";
      for (const line of eventBlock.split("\n")) {
        if (line.startsWith("event: ")) eventType = line.slice(7);
        else if (line.startsWith("data: ")) eventData = line.slice(6);
      }

      if (eventType === "content_block_start") {
        try {
          const d = JSON.parse(eventData);
          const block = d.content_block;
          if (block.type === "text") { currentText = ""; currentBlockType = "text"; }
          else if (block.type === "thinking") { currentBlockType = "thinking"; }
          else if (block.type === "tool_use") {
            currentToolId = block.id; currentToolName = block.name; currentToolJson = "";
            currentBlockType = "tool_use";
          }
        } catch (e) {}
      } else if (eventType === "content_block_delta") {
        try {
          const d = JSON.parse(eventData);
          if (d.delta.type === "text_delta") {
            currentText += d.delta.text;
            if (!aborted) ws.send(JSON.stringify({ type: "stream", text: d.delta.text }));
          } else if (d.delta.type === "thinking_delta") {
            // skip thinking content for now
          } else if (d.delta.type === "input_json_delta") {
            currentToolJson += d.delta.partial_json;
          }
        } catch (e) {}
      } else if (eventType === "content_block_stop") {
        if (currentBlockType === "text" && currentText) {
          contentBlocks.push({ type: "text", text: currentText });
        } else if (currentBlockType === "tool_use") {
          let input = {};
          try { input = JSON.parse(currentToolJson); } catch (e) {}
          contentBlocks.push({ type: "tool_use", id: currentToolId, name: currentToolName, input });
        }
        currentBlockType = null;
      } else if (eventType === "message_delta") {
        try {
          const d = JSON.parse(eventData);
          if (d.delta && d.delta.stop_reason) stopReason = d.delta.stop_reason;
          if (d.usage) usage = { ...usage, ...d.usage };
        } catch (e) {}
      } else if (eventType === "message_start") {
        try {
          const d = JSON.parse(eventData);
          if (d.message && d.message.usage) usage = d.message.usage;
        } catch (e) {}
      } else if (eventType === "message_stop") {
        break;
      } else if (eventType === "error") {
        const errMsg = eventData || "Stream error";
        throw new Error(errMsg);
      }
    }
  }

  if (!aborted) ws.send(JSON.stringify({ type: "stream_end" }));

  return {
    content: contentBlocks,
    stop_reason: stopReason,
    usage: { input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0 },
  };
}

async function streamResponse(ws, conversationHistory, abortSignal, model, _retries = 0) {
  const MAX_RETRIES = 2;
  try {
    return await streamResponseRaw(ws, conversationHistory, abortSignal, model);
  } catch (err) {
    if (err.name === "AbortError") return null;
    const statusMatch = err.message.match(/^(\d+)/);
    const status = statusMatch ? parseInt(statusMatch[1]) : 0;
    if ((status === 503 || status === 429 || status === 500) && _retries < MAX_RETRIES) {
      const delay = (_retries + 1) * 2000;
      console.log(`[API] Retry ${_retries + 1}/${MAX_RETRIES} after ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
      ws.send(JSON.stringify({ type: "stream_end" }));
      ws.send(JSON.stringify({ type: "thinking" }));
      return streamResponse(ws, conversationHistory, abortSignal, model, _retries + 1);
    }
    throw err;
  }
}

// ===== Usage Tracking =====
const INPUT_COST_PER_TOKEN = 3 / 1_000_000;
const OUTPUT_COST_PER_TOKEN = 15 / 1_000_000;

function trackUsage(response, sessionUsage, ws) {
  if (!response || !response.usage) return;
  const { input_tokens, output_tokens } = response.usage;
  sessionUsage.input_tokens += input_tokens;
  sessionUsage.output_tokens += output_tokens;
  sessionUsage.total_cost = sessionUsage.input_tokens * INPUT_COST_PER_TOKEN + sessionUsage.output_tokens * OUTPUT_COST_PER_TOKEN;
  ws.send(JSON.stringify({
    type: "usage",
    input_tokens: sessionUsage.input_tokens,
    output_tokens: sessionUsage.output_tokens,
    total_cost: sessionUsage.total_cost.toFixed(4),
  }));
}

// ===== Tool Execution =====
async function executeTool(block, ws, activeProcesses) {
  if (block.name === "bash") {
    ws.send(JSON.stringify({ type: "command", command: block.input.command }));
    const execPromise = execAsync(block.input.command, block.input.cwd ? { cwd: block.input.cwd } : {});
    if (execPromise.child) activeProcesses.push(execPromise.child);
    const output = await execPromise;
    if (execPromise.child) { const idx = activeProcesses.indexOf(execPromise.child); if (idx >= 0) activeProcesses.splice(idx, 1); }
    if (output.trim()) ws.send(JSON.stringify({ type: "command_output", output: output.slice(0, 5000) }));
    return { type: "tool_result", tool_use_id: block.id, content: output.slice(0, 10000) };

  } else if (block.name === "send_file") {
    const filename = block.input.filename;
    const filePath = safePath(SHARED_DIR, filename);
    if (!filePath) return { type: "tool_result", tool_use_id: block.id, content: `Invalid filename`, is_error: true };
    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      ws.send(JSON.stringify({
        type: "file", filename, url: `/shared/${encodeURIComponent(filename)}`,
        fileType: getFileType(filename), size: formatSize(stat.size), sizeBytes: stat.size,
      }));
      return { type: "tool_result", tool_use_id: block.id, content: `File "${filename}" sent.` };
    }
    return { type: "tool_result", tool_use_id: block.id, content: `"${filename}" not found.`, is_error: true };

  } else if (block.name === "download_media") {
    const { url, format = "video", quality = "best" } = block.input;
    if (!/^https?:\/\//i.test(url)) {
      return { type: "tool_result", tool_use_id: block.id, content: "Invalid URL", is_error: true };
    }
    try {
      let cmd;
      const safeUrl = url.replace(/[`$(){}|;&]/g, "");
      if (format === "audio") {
        cmd = `yt-dlp -x --audio-format mp3 --audio-quality 0 -o "${SHARED_DIR}/%(title)s.%(ext)s" --no-playlist --print filename "${safeUrl}"`;
      } else {
        const qualityMap = { "best": "bestvideo+bestaudio/best", "720p": "bestvideo[height<=720]+bestaudio/best[height<=720]", "480p": "bestvideo[height<=480]+bestaudio/best[height<=480]" };
        const fmt = qualityMap[quality] || qualityMap["best"];
        cmd = `yt-dlp -f "${fmt}" --merge-output-format mp4 -o "${SHARED_DIR}/%(title)s.%(ext)s" --no-playlist --print filename "${safeUrl}"`;
      }
      ws.send(JSON.stringify({ type: "command", command: `yt-dlp: downloading ${format} from ${url}` }));
      const dlPromise = execAsync(cmd, { timeout: 600000 });
      if (dlPromise.child) activeProcesses.push(dlPromise.child);
      const output = await dlPromise;
      if (dlPromise.child) { const idx = activeProcesses.indexOf(dlPromise.child); if (idx >= 0) activeProcesses.splice(idx, 1); }
      const lines = output.trim().split("\n");
      const filename = path.basename(lines[lines.length - 1].trim());
      const filePath = path.join(SHARED_DIR, filename);
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        ws.send(JSON.stringify({ type: "file", filename, url: `/shared/${encodeURIComponent(filename)}`, fileType: getFileType(filename), size: formatSize(stat.size), sizeBytes: stat.size }));
        return { type: "tool_result", tool_use_id: block.id, content: `Downloaded: ${filename} (${formatSize(stat.size)})` };
      }
      return { type: "tool_result", tool_use_id: block.id, content: `Download output:\n${output.slice(0, 3000)}` };
    } catch (err) {
      return { type: "tool_result", tool_use_id: block.id, content: `Download error: ${err}`, is_error: true };
    }

  } else if (block.name === "convert_media") {
    const { input: inputFile, output: outputFile, options = "" } = block.input;
    const inputPath = safePath(SHARED_DIR, inputFile);
    const outputPath = safePath(SHARED_DIR, outputFile);
    if (!inputPath || !outputPath) return { type: "tool_result", tool_use_id: block.id, content: "Invalid file path", is_error: true };
    if (!fs.existsSync(inputPath)) return { type: "tool_result", tool_use_id: block.id, content: `Input file not found`, is_error: true };
    try {
      const cmd = `ffmpeg -y -i "${inputPath}" ${options} "${outputPath}"`;
      ws.send(JSON.stringify({ type: "command", command: `ffmpeg: ${inputFile} -> ${outputFile}` }));
      const ffPromise = execAsync(cmd, { timeout: 600000 });
      if (ffPromise.child) activeProcesses.push(ffPromise.child);
      const output = await ffPromise;
      if (ffPromise.child) { const idx = activeProcesses.indexOf(ffPromise.child); if (idx >= 0) activeProcesses.splice(idx, 1); }
      if (fs.existsSync(outputPath)) {
        const stat = fs.statSync(outputPath);
        ws.send(JSON.stringify({ type: "file", filename: outputFile, url: `/shared/${encodeURIComponent(outputFile)}`, fileType: getFileType(outputFile), size: formatSize(stat.size), sizeBytes: stat.size }));
        return { type: "tool_result", tool_use_id: block.id, content: `Converted: ${outputFile} (${formatSize(stat.size)})` };
      }
      return { type: "tool_result", tool_use_id: block.id, content: `ffmpeg output:\n${output.slice(0, 3000)}` };
    } catch (err) {
      return { type: "tool_result", tool_use_id: block.id, content: `Convert error: ${err}`, is_error: true };
    }

  } else if (block.name === "search_web") {
    const { query, num_results = 5 } = block.input;
    try {
      const encoded = encodeURIComponent(query);
      const cmd = `curl -sL "https://html.duckduckgo.com/html/?q=${encoded}" -H "User-Agent: Mozilla/5.0" | head -c 100000`;
      const html = await execAsync(cmd, { timeout: 15000 });
      const results = [];
      const regex = /<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
      let match;
      while ((match = regex.exec(html)) !== null && results.length < Math.min(num_results, 10)) {
        const href = match[1].replace(/\/\/duckduckgo\.com\/l\/\?uddg=/, "").split("&")[0];
        const title = match[2].replace(/<[^>]+>/g, "").trim();
        const snippet = match[3].replace(/<[^>]+>/g, "").trim();
        try { results.push({ title, url: decodeURIComponent(href), snippet }); }
        catch { results.push({ title, url: href, snippet }); }
      }
      if (results.length === 0) return { type: "tool_result", tool_use_id: block.id, content: `No results for: "${query}"` };
      const text = results.map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`).join("\n\n");
      return { type: "tool_result", tool_use_id: block.id, content: text };
    } catch (err) {
      return { type: "tool_result", tool_use_id: block.id, content: `Search error: ${err}`, is_error: true };
    }

  } else if (block.name === "read_url") {
    const { url } = block.input;
    try {
      const cmd = `curl -sL -m 15 -H "User-Agent: Mozilla/5.0 (compatible)" "${url}" | head -c 200000`;
      const html = await execAsync(cmd, { timeout: 20000 });
      let text = html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<nav[\s\S]*?<\/nav>/gi, "")
        .replace(/<footer[\s\S]*?<\/footer>/gi, "")
        .replace(/<[^>]+>/g, "\n")
        .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/\n{3,}/g, "\n\n").trim();
      return { type: "tool_result", tool_use_id: block.id, content: text.slice(0, 15000) || "Could not extract text." };
    } catch (err) {
      return { type: "tool_result", tool_use_id: block.id, content: `Read error: ${err}`, is_error: true };
    }

  } else if (block.name === "schedule_task") {
    const { command = "echo 'Task triggered'", cron: cronExpr, delay, description: desc, ai_prompt } = block.input;
    const taskId = nextTaskId++;

    if (delay && delay > 0) {
      const taskData = { id: taskId, description: desc, command, ai_prompt };
      setTimeout(async () => {
        try {
          const rawOutput = await execAsync(command);
          await processScheduleOutput(taskData, rawOutput);
        } catch (e) {
          broadcastToClients({ type: "schedule_result", taskId, description: desc, command, output: desc });
        }
      }, delay * 1000);
      const mins = delay >= 60 ? `${Math.round(delay / 60)} min` : `${delay}s`;
      return { type: "tool_result", tool_use_id: block.id, content: `One-time task #${taskId}: "${desc}" in ${mins}` };
    }

    if (!cronExpr || !nodeCron.validate(cronExpr)) {
      return { type: "tool_result", tool_use_id: block.id, content: `Invalid cron: "${cronExpr}"`, is_error: true };
    }
    const taskData = { id: taskId, description: desc, cron: cronExpr, command, ai_prompt };
    registerScheduledTask(taskData);
    saveSchedules(scheduledTasks);
    return { type: "tool_result", tool_use_id: block.id, content: `Scheduled #${taskId}: "${desc}" [${cronExpr}]` };

  } else if (block.name === "read_file") {
    const { path: filePath, offset = 1, limit = 500 } = block.input;
    ws.send(JSON.stringify({ type: "command", command: `read_file: ${filePath}` }));
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      const start = Math.max(0, offset - 1);
      const end = Math.min(lines.length, start + limit);
      const numbered = lines.slice(start, end).map((line, i) => `${String(start + i + 1).padStart(6)}|${line}`).join("\n");
      const result = numbered.slice(0, 15000);
      if (result.trim()) ws.send(JSON.stringify({ type: "command_output", output: result.slice(0, 5000) }));
      return { type: "tool_result", tool_use_id: block.id, content: `Lines ${start + 1}-${end} of ${lines.length}\n${result}` };
    } catch (err) {
      return { type: "tool_result", tool_use_id: block.id, content: `Error: ${err.message}`, is_error: true };
    }

  } else if (block.name === "write_file") {
    const { path: filePath, content } = block.input;
    ws.send(JSON.stringify({ type: "command", command: `write_file: ${filePath}` }));
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, content, "utf-8");
      const result = `Written: ${filePath} (${content.split("\n").length} lines)`;
      ws.send(JSON.stringify({ type: "command_output", output: result }));
      return { type: "tool_result", tool_use_id: block.id, content: result };
    } catch (err) {
      return { type: "tool_result", tool_use_id: block.id, content: `Error: ${err.message}`, is_error: true };
    }

  } else if (block.name === "edit_file") {
    const { path: filePath, old_string, new_string } = block.input;
    ws.send(JSON.stringify({ type: "command", command: `edit_file: ${filePath}` }));
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const count = content.split(old_string).length - 1;
      if (count === 0) return { type: "tool_result", tool_use_id: block.id, content: "old_string not found. Read file first.", is_error: true };
      if (count > 1) return { type: "tool_result", tool_use_id: block.id, content: `old_string found ${count} times — must be unique.`, is_error: true };
      fs.writeFileSync(filePath, content.replace(old_string, new_string), "utf-8");
      ws.send(JSON.stringify({ type: "command_output", output: `Edit applied to ${filePath}` }));
      return { type: "tool_result", tool_use_id: block.id, content: `Edit applied to ${filePath}` };
    } catch (err) {
      return { type: "tool_result", tool_use_id: block.id, content: `Error: ${err.message}`, is_error: true };
    }

  } else if (block.name === "glob") {
    const { pattern, path: basePath } = block.input;
    const searchDir = basePath || require("os").homedir();
    ws.send(JSON.stringify({ type: "command", command: `glob: ${pattern} in ${searchDir}` }));
    try {
      const namePattern = pattern.includes("/") ? pattern.split("/").pop() : pattern;
      const cmd = `find "${searchDir}" -name "${namePattern}" -type f 2>/dev/null | head -100`;
      const output = await execAsync(cmd);
      const result = output.trim() || "No files found.";
      ws.send(JSON.stringify({ type: "command_output", output: result.slice(0, 5000) }));
      return { type: "tool_result", tool_use_id: block.id, content: result.slice(0, 10000) };
    } catch (err) {
      return { type: "tool_result", tool_use_id: block.id, content: `Error: ${err.message}`, is_error: true };
    }

  } else if (block.name === "grep") {
    const { pattern, path: searchPath, include } = block.input;
    const dir = searchPath || require("os").homedir();
    const includeFlag = include ? `--include="${include}"` : "";
    ws.send(JSON.stringify({ type: "command", command: `grep: "${pattern}" in ${dir}` }));
    try {
      const cmd = `grep -rn ${includeFlag} "${pattern}" "${dir}" 2>/dev/null | head -200`;
      const output = await execAsync(cmd);
      const result = output.trim() || "No matches found.";
      ws.send(JSON.stringify({ type: "command_output", output: result.slice(0, 5000) }));
      return { type: "tool_result", tool_use_id: block.id, content: result.slice(0, 10000) };
    } catch (err) {
      return { type: "tool_result", tool_use_id: block.id, content: `Error: ${err.message}`, is_error: true };
    }

  } else if (block.name === "memory") {
    const { action, key, value, query } = block.input;
    let memories = loadMemory();
    let result;
    if (action === "save" && key && value) {
      const idx = memories.findIndex(m => m.key === key);
      const tags = autoTag(key, value);
      if (idx >= 0) {
        memories[idx].value = value;
        memories[idx].updated = new Date().toISOString();
        memories[idx].tags = tags;
      } else {
        memories.push({ key, value, tags, saved: new Date().toISOString() });
      }
      saveMemoryFile(memories);
      ws.send(JSON.stringify({ type: "memory_saved", key, value }));
      result = `Memory saved: ${key} = ${value}`;
    } else if (action === "delete" && key) {
      const before = memories.length;
      memories = memories.filter(m => m.key !== key);
      saveMemoryFile(memories);
      result = memories.length < before ? `Deleted: ${key}` : `"${key}" not found.`;
    } else if (action === "list") {
      result = memories.length === 0 ? "No memories." :
        memories.sort((a, b) => new Date(b.updated || b.saved || 0) - new Date(a.updated || a.saved || 0))
          .map(m => `[${(m.tags || []).join(",")}] ${m.key}: ${m.value}`).join("\n");
    } else if (action === "search" && (query || key)) {
      const found = searchMemory(query || key);
      result = found.length === 0 ? `No memories matching "${query || key}".` :
        found.map(m => `[${(m.tags || []).join(",")}] ${m.key}: ${m.value}`).join("\n");
    } else {
      result = "Invalid action. Use: save, delete, list, search.";
    }
    return { type: "tool_result", tool_use_id: block.id, content: result };
  }

  return { type: "tool_result", tool_use_id: block.id, content: "Unknown tool", is_error: true };
}

// ===== Routes =====
app.use(express.static(path.join(__dirname, "public")));
app.use("/shared", express.static(SHARED_DIR));

// Fake auth endpoints so the original frontend works without changes
app.get("/login", (req, res) => res.redirect("/"));
app.get("/api/me", (req, res) => res.json({ username: "user", role: "admin", id: "local_user" }));
app.get("/api/auth-info", (req, res) => res.json({ registrationOpen: false, requireInvite: false }));
app.post("/api/logout", (req, res) => res.json({ ok: true }));

app.get("/api/fileinfo/:filename", (req, res) => {
  const filePath = safePath(SHARED_DIR, req.params.filename);
  if (!filePath) return res.status(400).json({ error: "Invalid filename" });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Not found" });
  const stat = fs.statSync(filePath);
  res.json({ name: req.params.filename, size: stat.size });
});

app.post("/api/upload", uploadMiddleware.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });
  res.json({ filename: req.file.filename, size: req.file.size });
});

// Settings API
app.get("/api/settings", (req, res) => {
  const settings = loadSettings();
  // Don't send full API key to frontend
  res.json({
    ...settings,
    apiKey: settings.apiKey ? "***" + settings.apiKey.slice(-8) : "",
    hasApiKey: !!settings.apiKey,
  });
});

app.post("/api/settings", (req, res) => {
  const current = loadSettings();
  const { apiKey, baseURL, model } = req.body;
  if (apiKey && apiKey !== current.apiKey) current.apiKey = apiKey;
  if (baseURL !== undefined) current.baseURL = baseURL;
  if (model !== undefined) current.model = model;
  saveSettings(current);
  // Recreate client with new key
  anthropic = createAnthropicClient();
  res.json({ ok: true });
});

// ===== WebSocket =====
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

// Ping/pong heartbeat
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);

wss.on("connection", async (ws) => {
  ws.isAlive = true;
  wsClients.add(ws);
  console.log("[WS] Client connected");

  ws.on("pong", () => { ws.isAlive = true; });

  let conversationHistory = loadConversation();
  let currentAbort = null;
  let cancelled = false;
  let activeProcesses = [];
  let sessionUsage = { input_tokens: 0, output_tokens: 0, total_cost: 0 };

  // Send user info
  ws.send(JSON.stringify({ type: "user_info", username: "user", role: "admin" }));

  // Restore conversation to frontend
  if (conversationHistory.length > 0) {
    const restored = [];
    for (const msg of conversationHistory) {
      if (msg.role === "user") {
        if (typeof msg.content === "string") {
          if (msg.content.startsWith("[system:") || msg.content.startsWith("[CONVERSATION SUMMARY]")) continue;
          restored.push({ role: "user", text: msg.content });
        } else if (Array.isArray(msg.content)) {
          const textParts = msg.content.filter(b => b.type === "text").map(b => b.text).join("\n");
          if (textParts.startsWith("[system:") || textParts.startsWith("[CONVERSATION SUMMARY]")) continue;
          if (textParts) restored.push({ role: "user", text: textParts });
        }
      } else if (msg.role === "assistant") {
        const parts = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: msg.content }];
        const textParts = parts.filter(b => b.type === "text").map(b => b.text).join("\n");
        if (textParts) restored.push({ role: "assistant", text: textParts });
      }
    }
    if (restored.length > 0) {
      ws.send(JSON.stringify({ type: "restore", messages: restored }));
    }
  }

  // Send status (no remote clients in desktop version)
  ws.send(JSON.stringify({ type: "client_status", mac: false, win: false, clients: [] }));

  ws.on("message", async (data) => {
    try {
      const parsed = JSON.parse(data);

      if (parsed.type === "cancel") {
        cancelled = true;
        if (currentAbort) { currentAbort.abort(); currentAbort = null; }
        activeProcesses.forEach(p => { try { p.kill("SIGTERM"); } catch(e) {} });
        activeProcesses = [];
        return;
      }

      if (parsed.type === "browser_result" || parsed.type === "browser_error") return;

      // Skip group chat messages in desktop version
      if (parsed.type === "group_chat" || parsed.type === "group_history") return;

      const { message, images, model: selectedModel } = parsed;

      if (message && message.trim() === "/clear") {
        conversationHistory = [];
        sessionUsage = { input_tokens: 0, output_tokens: 0, total_cost: 0 };
        saveConversation(conversationHistory);
        ws.send(JSON.stringify({ type: "clear" }));
        return;
      }

      cancelled = false;

      let userContent;
      if (images && images.length > 0) {
        userContent = [
          ...images.map(img => ({
            type: "image",
            source: { type: "base64", media_type: img.mediaType, data: img.base64 }
          })),
          { type: "text", text: message || "Please analyze this image" }
        ];
      } else {
        userContent = message;
      }

      conversationHistory.push({ role: "user", content: userContent });

      const compactResult = await compactConversation(conversationHistory);
      if (compactResult.compacted) {
        conversationHistory = compactResult.newHistory;
        ws.send(JSON.stringify({ type: "compaction" }));
      }

      console.log(`[Tokens] ~${estimateTotalTokens(conversationHistory)} (${conversationHistory.length} msgs)`);
      ws.send(JSON.stringify({ type: "thinking" }));

      currentAbort = new AbortController();
      let response = await streamResponse(ws, conversationHistory, currentAbort.signal, selectedModel);
      currentAbort = null;
      trackUsage(response, sessionUsage, ws);

      while (response && response.stop_reason === "tool_use" && !cancelled) {
        conversationHistory.push({ role: "assistant", content: response.content });
        const toolBlocks = response.content.filter(b => b.type === "tool_use");
        const toolResults = cancelled ? [] : await Promise.all(
          toolBlocks.map(block => executeTool(block, ws, activeProcesses))
        );

        if (cancelled) {
          const lastMsg = conversationHistory[conversationHistory.length - 1];
          if (lastMsg && lastMsg.role === "assistant" && Array.isArray(lastMsg.content)) {
            const cancelResults = lastMsg.content
              .filter(b => b.type === "tool_use")
              .map(b => ({ type: "tool_result", tool_use_id: b.id, content: "Cancelled by user." }));
            if (cancelResults.length > 0) conversationHistory.push({ role: "user", content: cancelResults });
          }
          break;
        }

        conversationHistory.push({ role: "user", content: toolResults });
        ws.send(JSON.stringify({ type: "thinking" }));
        currentAbort = new AbortController();
        response = await streamResponse(ws, conversationHistory, currentAbort.signal, selectedModel);
        currentAbort = null;
        trackUsage(response, sessionUsage, ws);
      }

      if (response && !cancelled) {
        conversationHistory.push({ role: "assistant", content: response.content });
      }
      saveConversation(conversationHistory);

    } catch (err) {
      currentAbort = null;
      if (cancelled || err.name === "AbortError") return;
      console.error("Error:", err);
      let errMsg = err.message || "Something went wrong";
      if (err.status === 401) errMsg = "API key invalid. Please check Settings.";
      else if (err.status === 429) errMsg = "Rate limited. Please wait a moment.";
      else if (errMsg.length > 200) errMsg = "Service error. Please retry.";
      ws.send(JSON.stringify({ type: "error", text: errMsg }));
    }
  });

  ws.on("close", () => {
    wsClients.delete(ws);
    console.log("[WS] Client disconnected");
  });
});

// ===== Shared Dir Cleanup (7 days) =====
function cleanupSharedDir() {
  try {
    const now = Date.now();
    const maxAge = 7 * 24 * 60 * 60 * 1000;
    const files = fs.readdirSync(SHARED_DIR);
    let removed = 0;
    for (const file of files) {
      const fp = path.join(SHARED_DIR, file);
      try {
        const stat = fs.statSync(fp);
        if (stat.isFile() && (now - stat.mtimeMs) > maxAge) { fs.unlinkSync(fp); removed++; }
      } catch (e) {}
    }
    if (removed > 0) console.log(`[Cleanup] Removed ${removed} old files`);
  } catch (e) {}
}
cleanupSharedDir();
setInterval(cleanupSharedDir, 6 * 60 * 60 * 1000);

// ===== Export for Electron =====
module.exports = {
  start(port) {
    return new Promise((resolve, reject) => {
      server.listen(port, () => {
        console.log(`[Server] Running on http://localhost:${port}`);
        console.log(`[Server] Data: ${DATA_DIR}`);
        console.log(`[Server] Shared: ${SHARED_DIR}`);
        resolve();
      });
      server.on("error", reject);
    });
  },
  stop() {
    wss.clients.forEach(c => { try { c.close(); } catch(e) {} });
    server.close();
  }
};
