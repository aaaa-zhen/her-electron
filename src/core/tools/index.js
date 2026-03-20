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
const { SUMMARY_MODEL } = require("../shared/constants");

// ── (search helpers moved to defs/web-search.js and defs/search-news.js) ──

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

  // ── Schedule output processing ──

  async function processScheduleOutput(taskData, rawOutput) {
    let output = rawOutput.slice(0, 5000);
    if (taskData.ai_prompt) {
      try {
        const client = createAnthropicClient();
        const response = await client.chat.completions.create({
          model: SUMMARY_MODEL,
          max_tokens: 2048,
          messages: [{ role: "user", content: `${taskData.ai_prompt}\n\n---\nRaw data:\n${rawOutput.slice(0, 8000)}` }],
        });
        output = (response.choices[0].message.content || "").trim();
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
      activeProcesses,
      _model: null,    // set by chat-session before execute
    };

    return ctx;
  }

  // ── Build OpenAI-compatible tool definitions ──

  const ctx = buildCtx([]);
  const anthropicDefs = toolInstances.map((instance) => {
    return typeof instance.definition === "function" && instance.definition.length > 0
      ? instance.definition(ctx)
      : instance.definition();
  });

  // Convert Anthropic format { name, description, input_schema } to OpenAI format
  const tools = anthropicDefs.map((def) => ({
    type: "function",
    function: {
      name: def.name,
      description: def.description,
      parameters: def.input_schema || { type: "object", properties: {} },
    },
  }));

  // Kimi built-in web search tool — added dynamically based on model
  const kimiWebSearchTool = {
    type: "builtin_function",
    function: { name: "$web_search" },
  };

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

  function getTools(model) {
    const m = model || executeWithTimeout._currentModel || "";
    if (/^kimi/i.test(m)) return [...tools, kimiWebSearchTool];
    return tools;
  }

  return { tools, getTools, execute: executeWithTimeout, processScheduleOutput, setModel };
}

module.exports = { createTools };
