/**
 * DeepSeek API client — OpenAI-compatible format
 * Supports streaming, tool calls, and chat completions.
 */

const { net } = require("electron");

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

function createDeepSeekClient(settingsStore) {
  const settings = settingsStore.get();
  const apiKey = settings.apiKey || "";
  // Only use stored baseURL if it's a DeepSeek endpoint; otherwise default
  const storedURL = settings.baseURL || "";
  const baseURL = storedURL.includes("deepseek.com") ? storedURL : DEEPSEEK_BASE_URL;

  return {
    apiKey,
    baseURL,

    /**
     * Non-streaming chat completion (for connection test, etc.)
     */
    async chatComplete({ model, messages, max_tokens }) {
      const res = await net.fetch(`${baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: model || "deepseek-chat",
          messages,
          max_tokens: max_tokens || 100,
          stream: false,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        const err = new Error(`${res.status} ${text}`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    },

    /**
     * Streaming chat completion — returns a ReadableStream of SSE events
     */
    async chatStream({ model, messages, max_tokens, tools, signal }) {
      const body = {
        model: model || "deepseek-chat",
        messages,
        max_tokens: max_tokens || 4096,
        stream: true,
        stream_options: { include_usage: true },
      };
      if (tools && tools.length > 0) {
        body.tools = tools;
        body.tool_choice = "auto";
      }

      const res = await net.fetch(`${baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!res.ok) {
        const text = await res.text();
        const err = new Error(`${res.status} ${text}`);
        err.status = res.status;
        throw err;
      }

      return res.body;
    },
  };
}

/**
 * Convert Anthropic-style conversation history to OpenAI/DeepSeek message format.
 *
 * Anthropic format:
 *   system: string (separate field)
 *   messages: [{ role, content: string | Array<{type,text,...}> }]
 *
 * DeepSeek/OpenAI format:
 *   messages: [{ role: "system"|"user"|"assistant"|"tool", content: string, tool_calls?, tool_call_id? }]
 */
function convertMessagesForDeepSeek(systemPrompt, conversationHistory) {
  const messages = [];

  // System prompt as first message
  if (systemPrompt) {
    const systemText = Array.isArray(systemPrompt)
      ? systemPrompt.map((b) => (typeof b === "string" ? b : b.text || "")).join("\n")
      : systemPrompt;
    messages.push({ role: "system", content: systemText });
  }

  for (const msg of conversationHistory) {
    if (msg.role === "user") {
      // User message may be string or array of content blocks
      if (typeof msg.content === "string") {
        messages.push({ role: "user", content: msg.content });
      } else if (Array.isArray(msg.content)) {
        // Check if this is a tool_result array
        const toolResults = msg.content.filter((b) => b.type === "tool_result");
        const textBlocks = msg.content.filter((b) => b.type === "text");

        if (toolResults.length > 0) {
          // Convert Anthropic tool_result to OpenAI tool messages
          for (const tr of toolResults) {
            const content = typeof tr.content === "string"
              ? tr.content
              : Array.isArray(tr.content)
                ? tr.content.map((c) => c.text || "").join("\n")
                : JSON.stringify(tr.content || "");
            messages.push({
              role: "tool",
              tool_call_id: tr.tool_use_id,
              content: content,
            });
          }
          // Also include any text blocks as a separate user message
          if (textBlocks.length > 0) {
            messages.push({
              role: "user",
              content: textBlocks.map((b) => b.text).join("\n"),
            });
          }
        } else {
          // Regular content blocks — extract text (images not supported by DeepSeek)
          const text = msg.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("\n");
          if (text) messages.push({ role: "user", content: text });
        }
      }
    } else if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        messages.push({ role: "assistant", content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const textParts = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
        const toolUseBlocks = msg.content.filter((b) => b.type === "tool_use");

        const assistantMsg = { role: "assistant", content: textParts || null };
        if (toolUseBlocks.length > 0) {
          assistantMsg.tool_calls = toolUseBlocks.map((b) => ({
            id: b.id,
            type: "function",
            function: {
              name: b.name,
              arguments: JSON.stringify(b.input || {}),
            },
          }));
        }
        messages.push(assistantMsg);
      }
    }
  }

  return messages;
}

/**
 * Convert local tool definitions from Anthropic format to OpenAI/DeepSeek format.
 */
function convertToolsForDeepSeek(anthropicTools) {
  if (!anthropicTools || anthropicTools.length === 0) return [];
  return anthropicTools
    .filter((t) => t.name && t.input_schema) // skip server-side tools like web_search
    .map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description || "",
        parameters: t.input_schema || { type: "object", properties: {} },
      },
    }));
}

module.exports = { createDeepSeekClient, convertMessagesForDeepSeek, convertToolsForDeepSeek };
