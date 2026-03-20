const { SUMMARY_MODEL } = require("../shared/constants");

const CONTEXT_WINDOW = 40000;
const RESERVE_TOKENS = 8192;
const KEEP_RECENT_TOKENS = 12000;
const CONDENSE_THRESHOLD = 4; // condense when 4+ uncondensed leaves exist

function estimateTextTokens(text) {
  if (!text) return 0;
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const restCount = text.length - cjkCount;
  return Math.ceil(cjkCount * 1.5 + restCount / 4);
}

function estimateTokens(message) {
  if (!message) return 0;
  let tokens = 0;
  const { content } = message;
  if (typeof content === "string") tokens += estimateTextTokens(content);
  else if (Array.isArray(content)) {
    tokens += content.reduce((sum, block) => {
      if (block.type === "text") return sum + estimateTextTokens(block.text || "");
      if (block.type === "image_url") return sum + 1000;
      return sum + 10;
    }, 0);
  }
  // OpenAI tool_calls on assistant messages
  if (message.tool_calls && Array.isArray(message.tool_calls)) {
    tokens += message.tool_calls.reduce((sum, tc) => {
      return sum + estimateTextTokens(tc.function ? (tc.function.arguments || "") : "") + 20;
    }, 0);
  }
  // OpenAI tool result messages
  if (message.role === "tool" && typeof content === "string") {
    tokens += 10;
  }
  return tokens || 10;
}

function estimateTotalTokens(messages) {
  return messages.reduce((sum, message) => sum + estimateTokens(message), 0);
}

/** Serialize messages into a readable text block for summarisation */
function serializeMessages(messages) {
  return messages.map((message) => {
    if (message.role === "tool") {
      const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
      return `Tool Result: ${text.slice(0, 200)}`;
    }
    if (message.role === "system") return `System: ${typeof message.content === "string" ? message.content.slice(0, 300) : ""}`;
    const role = message.role === "user" ? "User" : "Assistant";
    const parts = [];
    if (typeof message.content === "string") {
      parts.push(message.content);
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === "text") parts.push(block.text);
      }
    }
    if (message.tool_calls && Array.isArray(message.tool_calls)) {
      for (const tc of message.tool_calls) {
        const fn = tc.function || {};
        parts.push(`[Tool: ${fn.name}(${(fn.arguments || "").slice(0, 200)})]`);
      }
    }
    return `${role}: ${parts.filter(Boolean).join("\n")}`;
  }).join("\n\n");
}

/** Call LLM to produce a summary */
async function callSummarize(client, text, prompt) {
  const summaryResponse = await client.chat.completions.create({
    model: SUMMARY_MODEL,
    max_tokens: 2048,
    messages: [
      { role: "system", content: "You are a conversation summarizer. Respond ONLY with the summary in the exact format requested." },
      { role: "user", content: `${prompt}\n\n---\n${text.slice(0, 50000)}` },
    ],
  });
  return (summaryResponse.choices[0].message.content || "").trim();
}

/**
 * Find the cut index that keeps KEEP_RECENT_TOKENS worth of recent messages,
 * while not splitting tool_use/tool_result pairs.
 */
function findCutIndex(conversationHistory) {
  let recentTokens = 0;
  let cutIndex = conversationHistory.length;
  for (let index = conversationHistory.length - 1; index >= 0; index -= 1) {
    recentTokens += estimateTokens(conversationHistory[index]);
    if (recentTokens >= KEEP_RECENT_TOKENS) {
      cutIndex = index;
      break;
    }
  }

  // Ensure cut doesn't split a tool_calls / tool result sequence.
  while (cutIndex > 0 && cutIndex < conversationHistory.length) {
    const message = conversationHistory[cutIndex];
    // Don't split on a tool result message
    if (message.role === "tool") {
      cutIndex -= 1;
      continue;
    }
    // Legacy Anthropic format: user message with tool_result blocks
    if (message.role === "user" && Array.isArray(message.content) && message.content.some((block) => block.type === "tool_result")) {
      cutIndex -= 1;
      continue;
    }
    break;
  }

  return cutIndex;
}

/**
 * Detect and migrate old inline [CONVERSATION SUMMARY] format to DAG.
 * Returns the cleaned conversation history (without inline summary messages).
 */
function migrateInlineSummary(conversationHistory, dagStore) {
  if (!dagStore || conversationHistory.length < 2) return conversationHistory;

  const first = conversationHistory[0];
  if (first.role === "user" && typeof first.content === "string" && first.content.startsWith("[CONVERSATION SUMMARY]")) {
    const summaryText = first.content.replace("[CONVERSATION SUMMARY]", "").replace("[Conversation continues below.]", "").trim();
    const tokenEstimate = estimateTextTokens(summaryText);
    dagStore.addLeaf(summaryText, tokenEstimate);
    console.log("[Compaction] Migrated inline summary to DAG leaf");
    // Remove the summary pair (user summary + assistant ack)
    return conversationHistory.slice(2);
  }
  return conversationHistory;
}

/**
 * Assemble context for the API: DAG root summaries + recent messages.
 */
function assembleContext(dagStore, recentMessages) {
  if (!dagStore || dagStore.isEmpty()) return recentMessages;

  const rootSummaries = dagStore.getRootSummaries();
  const combinedSummary = rootSummaries.join("\n\n---\n\n");

  return [
    { role: "user", content: `[CONVERSATION CONTEXT]\n\n${combinedSummary}\n\n[Conversation continues below.]` },
    { role: "assistant", content: "Understood. I have the full context. Let's continue." },
    ...recentMessages,
  ];
}

/**
 * DAG-aware compaction. Creates a leaf summary from old messages and stores it in the DAG.
 * Falls back to inline summary if no dagStore is provided.
 */
async function compactConversation({ conversationHistory, anthropic, emit, dagStore }) {
  const totalTokens = estimateTotalTokens(conversationHistory);
  const threshold = CONTEXT_WINDOW - RESERVE_TOKENS;
  if (totalTokens <= threshold) return { compacted: false };

  console.log(`[Compaction] Triggered: ~${totalTokens} tokens`);

  const cutIndex = findCutIndex(conversationHistory);
  if (cutIndex < 2) return { compacted: false };

  // Skip inline summary messages when cutting (they're already in DAG)
  let startIndex = 0;
  if (conversationHistory[0] && conversationHistory[0].role === "user" &&
      typeof conversationHistory[0].content === "string" &&
      (conversationHistory[0].content.startsWith("[CONVERSATION CONTEXT]") ||
       conversationHistory[0].content.startsWith("[CONVERSATION SUMMARY]"))) {
    startIndex = 2; // skip context pair
  }

  const oldMessages = conversationHistory.slice(startIndex, cutIndex);
  const recentMessages = conversationHistory.slice(cutIndex);

  if (oldMessages.length < 2) return { compacted: false };

  const serialized = serializeMessages(oldMessages);

  try {
    const summaryText = await callSummarize(
      anthropic,
      serialized,
      "Summarize this conversation:\n\nFormat:\n## Goal\n## Progress\n## Key Decisions\n## Next Steps\n## Critical Context"
    );

    const tokenEstimate = estimateTextTokens(summaryText);

    if (emit) emit({ type: "compaction" });

    if (dagStore) {
      dagStore.addLeaf(summaryText, tokenEstimate);
      console.log(`[Compaction] Added DAG leaf (~${tokenEstimate} tokens), ${dagStore.getUncondensedLeafCount()} uncondensed leaves`);

      return {
        compacted: true,
        newHistory: assembleContext(dagStore, recentMessages),
      };
    }

    // Fallback: inline summary (no DAG store)
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

/**
 * Condense DAG: when too many uncondensed leaves accumulate, merge them into a higher-level summary.
 * This runs post-turn, asynchronously.
 */
async function condenseDag({ dagStore, anthropic }) {
  if (!dagStore) return;

  const uncondensedCount = dagStore.getUncondensedLeafCount();
  if (uncondensedCount < CONDENSE_THRESHOLD) return;

  const leafIds = dagStore.getUncondensedLeafIds();
  const dag = dagStore.read();
  const leafSummaries = leafIds.map((id) => dag.nodes[id].summary);
  const combined = leafSummaries.join("\n\n---\n\n");

  console.log(`[Compaction] Condensing ${leafIds.length} leaf summaries into higher-level node`);

  try {
    const condensed = await callSummarize(
      anthropic,
      combined,
      "These are multiple conversation summaries from different time periods. Condense them into a single comprehensive summary that preserves all important context:\n\nFormat:\n## Key Facts & Decisions\n## Ongoing Work\n## User Preferences & Patterns\n## Critical Context"
    );

    const tokenEstimate = estimateTextTokens(condensed);
    dagStore.condense(leafIds, condensed, tokenEstimate);
    console.log(`[Compaction] Condensed ${leafIds.length} leaves → depth-1 node (~${tokenEstimate} tokens)`);
  } catch (error) {
    console.error("[Compaction] Condensation failed:", error.message);
  }
}

module.exports = {
  estimateTotalTokens,
  estimateTextTokens,
  compactConversation,
  condenseDag,
  migrateInlineSummary,
  assembleContext,
};
