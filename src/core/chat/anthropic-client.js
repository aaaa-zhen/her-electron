const Anthropic = require("@anthropic-ai/sdk");
const OpenAI = require("openai");

const DEFAULT_BASE_URL = "https://www.packyapi.com";

function createClient(settingsStore) {
  const settings = settingsStore.get();
  const apiKey = settings.apiKey || "";
  const baseURL = settings.baseURL || DEFAULT_BASE_URL;

  // Use Anthropic SDK for PackyAPI / Anthropic, OpenAI SDK for others
  if (/packyapi\.com|anthropic\.com/i.test(baseURL)) {
    return createAnthropicWrapper(apiKey, baseURL);
  }
  // Kimi / custom: keep OpenAI SDK
  return new OpenAI({ apiKey, baseURL });
}

// ── Anthropic SDK wrapper (OpenAI-compatible interface) ──────────────

function createAnthropicWrapper(apiKey, baseURL) {
  const cleanBase = baseURL.replace(/\/v1\/?$/, "");
  const anthropic = new Anthropic({
    authToken: apiKey,
    baseURL: cleanBase,
  });

  return {
    chat: {
      completions: {
        create: (payload, options) => callAnthropic(anthropic, payload, options),
      },
    },
  };
}

async function callAnthropic(anthropic, payload, options) {
  const { model, max_tokens, messages, tools, stream } = payload;

  const { system, messages: anthropicMessages } = convertMessages(messages);
  const anthropicTools = convertTools(tools);

  const params = {
    model,
    max_tokens: max_tokens || 4096,
    messages: anthropicMessages,
  };
  if (system) params.system = system;
  if (anthropicTools && anthropicTools.length > 0) params.tools = anthropicTools;

  if (stream) {
    const rawStream = await anthropic.messages.create({ ...params, stream: true }, options);
    return toOpenAIStream(rawStream);
  }

  const response = await anthropic.messages.create(params, options);
  return toOpenAIResponse(response);
}

// ── Message format conversion (OpenAI → Anthropic) ──────────────────

function convertMessages(messages) {
  let system = "";
  const result = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "system") {
      const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      system += (system ? "\n\n" : "") + text;
      continue;
    }

    if (msg.role === "user") {
      if (Array.isArray(msg.content)) {
        const blocks = msg.content.map(convertContentBlock);
        result.push({ role: "user", content: blocks });
      } else {
        result.push({ role: "user", content: msg.content || "" });
      }
      continue;
    }

    if (msg.role === "assistant") {
      const blocks = [];
      if (msg.content) {
        if (typeof msg.content === "string" && msg.content.trim()) {
          blocks.push({ type: "text", text: msg.content });
        } else if (Array.isArray(msg.content)) {
          for (const b of msg.content) {
            if (b.type === "text" && b.text) blocks.push(b);
          }
        }
      }
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          let input = {};
          try { input = JSON.parse(tc.function.arguments || "{}"); } catch (_) {}
          blocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input,
          });
        }
      }
      if (blocks.length > 0) {
        result.push({ role: "assistant", content: blocks });
      }
      continue;
    }

    if (msg.role === "tool") {
      // Collect consecutive tool messages → single user message with tool_result blocks
      const toolResults = [];
      let j = i;
      while (j < messages.length && messages[j].role === "tool") {
        toolResults.push({
          type: "tool_result",
          tool_use_id: messages[j].tool_call_id,
          content: messages[j].content || "",
        });
        j++;
      }
      result.push({ role: "user", content: toolResults });
      i = j - 1;
      continue;
    }
  }

  // Anthropic requires alternating user/assistant — merge consecutive same-role
  const merged = [];
  for (const msg of result) {
    if (merged.length > 0 && merged[merged.length - 1].role === msg.role) {
      const last = merged[merged.length - 1];
      const lastBlocks = Array.isArray(last.content) ? last.content : [{ type: "text", text: String(last.content) }];
      const thisBlocks = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: String(msg.content) }];
      last.content = [...lastBlocks, ...thisBlocks];
    } else {
      merged.push({ ...msg });
    }
  }

  // Anthropic requires first message to be role:user
  if (merged.length > 0 && merged[0].role !== "user") {
    merged.unshift({ role: "user", content: "." });
  }

  return { system, messages: merged };
}

function convertContentBlock(block) {
  if (block.type === "image_url" && block.image_url) {
    const url = block.image_url.url || "";
    if (url.startsWith("data:")) {
      const match = url.match(/^data:(image\/[^;]+);base64,(.+)$/s);
      if (match) {
        return { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } };
      }
    }
    return { type: "text", text: `[Image]` };
  }
  return block;
}

// ── Tool format conversion (OpenAI → Anthropic) ─────────────────────

function convertTools(tools) {
  if (!tools || !Array.isArray(tools)) return undefined;
  return tools
    .filter((t) => t.type === "function" && t.function)
    .map((t) => ({
      name: t.function.name,
      description: t.function.description || "",
      input_schema: t.function.parameters || { type: "object", properties: {} },
    }));
}

// ── Response conversion (Anthropic → OpenAI) ────────────────────────

function toOpenAIResponse(response) {
  let text = "";
  const toolCalls = [];

  for (const block of response.content || []) {
    if (block.type === "text") text += block.text;
    else if (block.type === "server_tool_use" || block.type === "web_search_tool_result") {
      // Built-in server-side tool (web_search) — results are handled internally by Anthropic
      continue;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
      });
    }
  }

  const finishReason = response.stop_reason === "tool_use" ? "tool_calls" : "stop";
  const message = { role: "assistant", content: text };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return {
    choices: [{ message, finish_reason: finishReason }],
    usage: {
      prompt_tokens: response.usage?.input_tokens || 0,
      completion_tokens: response.usage?.output_tokens || 0,
    },
  };
}

// ── Streaming conversion (Anthropic events → OpenAI chunks) ─────────

async function* toOpenAIStream(rawStream) {
  let toolCallIndex = -1;

  for await (const event of rawStream) {
    if (event.type === "content_block_start") {
      // Skip server-side tool blocks (web_search)
      if (event.content_block.type === "server_tool_use" || event.content_block.type === "web_search_tool_result") {
        continue;
      }
      if (event.content_block.type === "tool_use") {
        toolCallIndex++;
        yield {
          choices: [{
            delta: {
              tool_calls: [{
                index: toolCallIndex,
                id: event.content_block.id,
                function: { name: event.content_block.name, arguments: "" },
              }],
            },
          }],
        };
      }
    } else if (event.type === "content_block_delta") {
      if (event.delta.type === "text_delta") {
        yield { choices: [{ delta: { content: event.delta.text } }] };
      } else if (event.delta.type === "input_json_delta") {
        yield {
          choices: [{
            delta: {
              tool_calls: [{
                index: toolCallIndex,
                function: { arguments: event.delta.partial_json },
              }],
            },
          }],
        };
      }
    } else if (event.type === "message_delta") {
      const sr = event.delta.stop_reason;
      yield {
        choices: [{
          delta: {},
          finish_reason: sr === "tool_use" ? "tool_calls" : "stop",
        }],
        usage: {
          prompt_tokens: event.usage?.input_tokens || 0,
          completion_tokens: event.usage?.output_tokens || 0,
        },
      };
    }
  }
}

// Keep backward-compatible alias
const createAnthropicClient = createClient;

module.exports = { createClient, createAnthropicClient };
