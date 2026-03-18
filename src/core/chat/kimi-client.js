/**
 * Kimi API client — OpenAI-compatible format with multimodal support.
 * Supports streaming, tool calls, image inputs, and chat completions.
 */

const { net } = require("electron");

const KIMI_BASE_URL = "https://api.moonshot.cn/v1";

function createKimiClient(settingsStore) {
  const settings = settingsStore.get();
  const apiKey = settings.kimiApiKey || "";
  const storedURL = settings.kimiBaseURL || "";
  const baseURL = storedURL || KIMI_BASE_URL;

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
          model: model || "kimi-latest",
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
        model: model || "kimi-latest",
        messages,
        max_tokens: max_tokens || 8192,
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
 * Convert Anthropic-style conversation history to OpenAI/Kimi message format.
 * Supports multimodal content (images).
 */
function convertMessagesForKimi(systemPrompt, conversationHistory) {
  const messages = [];

  if (systemPrompt) {
    const systemText = Array.isArray(systemPrompt)
      ? systemPrompt.map((b) => (typeof b === "string" ? b : b.text || "")).join("\n")
      : systemPrompt;
    messages.push({ role: "system", content: systemText });
  }

  for (const msg of conversationHistory) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        messages.push({ role: "user", content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const toolResults = msg.content.filter((b) => b.type === "tool_result");
        const otherBlocks = msg.content.filter((b) => b.type !== "tool_result");

        if (toolResults.length > 0) {
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
          const textBlocks = otherBlocks.filter((b) => b.type === "text");
          if (textBlocks.length > 0) {
            messages.push({
              role: "user",
              content: textBlocks.map((b) => b.text).join("\n"),
            });
          }
        } else {
          // Build multimodal content array for Kimi (supports images)
          const parts = [];
          for (const block of otherBlocks) {
            if (block.type === "text") {
              parts.push({ type: "text", text: block.text });
            } else if (block.type === "image" && block.source) {
              if (block.source.type === "base64") {
                parts.push({
                  type: "image_url",
                  image_url: {
                    url: `data:${block.source.media_type};base64,${block.source.data}`,
                  },
                });
              } else if (block.source.type === "url") {
                parts.push({
                  type: "image_url",
                  image_url: { url: block.source.url },
                });
              }
            }
          }
          if (parts.length === 1 && parts[0].type === "text") {
            messages.push({ role: "user", content: parts[0].text });
          } else if (parts.length > 0) {
            messages.push({ role: "user", content: parts });
          }
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
 * Convert local tool definitions from Anthropic format to OpenAI/Kimi format.
 */
function convertToolsForKimi(anthropicTools) {
  if (!anthropicTools || anthropicTools.length === 0) return [];
  return anthropicTools
    .filter((t) => t.name && t.input_schema)
    .map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description || "",
        parameters: t.input_schema || { type: "object", properties: {} },
      },
    }));
}

module.exports = { createKimiClient, convertMessagesForKimi, convertToolsForKimi };
