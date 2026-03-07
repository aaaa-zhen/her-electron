const { SUMMARY_MODEL } = require("../shared/constants");

const CONTEXT_WINDOW = 80000;
const RESERVE_TOKENS = 16384;
const KEEP_RECENT_TOKENS = 20000;

function estimateTokens(message) {
  if (!message || !message.content) return 0;
  const { content } = message;
  if (typeof content === "string") return Math.ceil(content.length / 4);
  if (Array.isArray(content)) {
    return content.reduce((sum, block) => {
      if (block.type === "text") return sum + Math.ceil((block.text || "").length / 4);
      if (block.type === "image") return sum + 1000;
      if (block.type === "tool_use") return sum + Math.ceil(JSON.stringify(block.input || {}).length / 4) + 20;
      if (block.type === "tool_result") {
        const contentText = typeof block.content === "string" ? block.content : JSON.stringify(block.content || "");
        return sum + Math.ceil(contentText.length / 4) + 10;
      }
      return sum + 10;
    }, 0);
  }
  return 10;
}

function estimateTotalTokens(messages) {
  return messages.reduce((sum, message) => sum + estimateTokens(message), 0);
}

async function compactConversation({ conversationHistory, anthropic, emit }) {
  const totalTokens = estimateTotalTokens(conversationHistory);
  const threshold = CONTEXT_WINDOW - RESERVE_TOKENS;
  if (totalTokens <= threshold) return { compacted: false };

  console.log(`[Compaction] Triggered: ~${totalTokens} tokens`);

  let recentTokens = 0;
  let cutIndex = conversationHistory.length;
  for (let index = conversationHistory.length - 1; index >= 0; index -= 1) {
    recentTokens += estimateTokens(conversationHistory[index]);
    if (recentTokens >= KEEP_RECENT_TOKENS) {
      cutIndex = index;
      break;
    }
  }

  // Ensure cut doesn't split a tool_use / tool_result pair.
  // If recentMessages starts with a tool_result, pull back to include the matching assistant tool_use.
  while (cutIndex > 0 && cutIndex < conversationHistory.length) {
    const message = conversationHistory[cutIndex];
    if (message.role === "user" && Array.isArray(message.content) && message.content.some((block) => block.type === "tool_result")) {
      // Pull cutIndex back to include the preceding assistant message (which should have tool_use)
      cutIndex -= 1;
      continue;
    }
    break;
  }

  if (cutIndex < 2) return { compacted: false };

  const oldMessages = conversationHistory.slice(0, cutIndex);
  const recentMessages = conversationHistory.slice(cutIndex);

  const serialized = oldMessages.map((message) => {
    const role = message.role === "user" ? "User" : "Assistant";
    if (typeof message.content === "string") return `${role}: ${message.content}`;
    if (Array.isArray(message.content)) {
      const parts = message.content.map((block) => {
        if (block.type === "text") return block.text;
        if (block.type === "tool_use") return `[Tool: ${block.name}(${JSON.stringify(block.input).slice(0, 200)})]`;
        if (block.type === "tool_result") {
          const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
          return `[Result: ${text.slice(0, 200)}]`;
        }
        return "";
      }).filter(Boolean);
      return `${role}: ${parts.join("\n")}`;
    }
    return `${role}: ${JSON.stringify(message.content).slice(0, 500)}`;
  }).join("\n\n");

  try {
    const summaryResponse = await anthropic.messages.create({
      model: SUMMARY_MODEL,
      max_tokens: 2048,
      system: "You are a conversation summarizer. Respond ONLY with the summary in the exact format requested.",
      messages: [{
        role: "user",
        content: `Summarize this conversation:\n\nFormat:\n## Goal\n## Progress\n## Key Decisions\n## Next Steps\n## Critical Context\n\n---\n${serialized.slice(0, 50000)}`,
      }],
    });

    const summaryText = summaryResponse.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    if (emit) emit({ type: "compaction" });

    return {
      compacted: true,
      newHistory: [
        { role: "user", content: `[CONVERSATION SUMMARY]\n\n${summaryText}\n\n[Conversation continues below.]` },
        { role: "assistant", content: "Understood. I have the context. Let's continue." },
        ...recentMessages,
      ],
    };
  } catch (error) {
    console.error("[Compaction] Failed:", error.message);
    return { compacted: false };
  }
}

module.exports = {
  estimateTotalTokens,
  compactConversation,
};
