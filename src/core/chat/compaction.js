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
  if (!message || !message.content) return 0;
  const { content } = message;
  if (typeof content === "string") return estimateTextTokens(content);
  if (Array.isArray(content)) {
    return content.reduce((sum, block) => {
      if (block.type === "text") return sum + estimateTextTokens(block.text || "");
      if (block.type === "image") return sum + 1000;
      if (block.type === "tool_use") return sum + estimateTextTokens(JSON.stringify(block.input || {})) + 20;
      if (block.type === "tool_result") {
        const contentText = typeof block.content === "string" ? block.content : JSON.stringify(block.content || "");
        return sum + estimateTextTokens(contentText) + 10;
      }
      return sum + 10;
    }, 0);
  }
  return 10;
}

function estimateTotalTokens(messages) {
  return messages.reduce((sum, message) => sum + estimateTokens(message), 0);
}

/** Serialize messages into a readable text block for summarisation */
function serializeMessages(messages) {
  return messages.map((message) => {
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
}

/** Call LLM to produce a summary */
async function callSummarize(anthropic, text, prompt) {
  const summaryResponse = await anthropic.messages.create({
    model: SUMMARY_MODEL,
    max_tokens: 2048,
    system: "You are a conversation summarizer. Respond ONLY with the summary in the exact format requested.",
    messages: [{ role: "user", content: `${prompt}\n\n---\n${text.slice(0, 50000)}` }],
  });
  return summaryResponse.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
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

  // Ensure cut doesn't split a tool_use / tool_result pair.
  while (cutIndex > 0 && cutIndex < conversationHistory.length) {
    const message = conversationHistory[cutIndex];
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
