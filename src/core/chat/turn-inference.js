function compactText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clipText(value, limit = 120) {
  const text = compactText(value);
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function dueSoonLevel(activeTodos = [], now = Date.now()) {
  let best = "low";
  for (const todo of activeTodos) {
    if (!todo || !todo.dueDate) continue;
    const dueAt = new Date(todo.dueDate).getTime();
    if (Number.isNaN(dueAt)) continue;
    const diff = dueAt - now;
    if (diff <= 15 * 60 * 1000 && diff >= -15 * 60 * 1000) return "high";
    if (diff <= 60 * 60 * 1000 && diff >= -30 * 60 * 1000) best = "medium";
  }
  return best;
}

function inferIntent(text, browserContext) {
  if (browserContext && /(现在呢|我在看什么|我现在在看什么|现在我在看什么|这是什么视频|这是什么内容|这是什么页面|我在看youtube什么|我在看什么)/i.test(text)) {
    return "ask_current_context";
  }
  if (/(你记得|你知道|现在呢|这样呢|这就很|你不是|你还记得|你都了解啥|知道了吗)/.test(text)) {
    return "testing_me";
  }
  if (/(帮我|给我|下载|发给我|做一下|写一下|改一下|修一下|安排|设置|提醒|添加|删掉|完成)/.test(text)) {
    return "ask_for_action";
  }
  if (/(我一会|接下来|然后呢|之后呢|今天|待会|上完|安排|要干嘛|该干嘛)/.test(text)) {
    return "planning";
  }
  if (/(你觉得|怎么看|是不是|行不行|好不好|呆|差异化|如何|怎么样)/.test(text)) {
    return "ask_for_judgement";
  }
  if (/(烦|焦虑|难受|累|崩|难过|失眠|孤独|陪我|想聊聊)/.test(text)) {
    return "emotional_support";
  }
  return "ask_fact";
}

function inferEmotionalTone(text) {
  if (/(垃圾|呆|蠢|离谱|烦|焦虑|难受|崩|不对|问题|卡顿|太差|受不了)/.test(text)) return "frustrated";
  if (/(哈哈|好玩|有意思|笑死|可爱|喜欢)/.test(text)) return "playful";
  if (/(困|睡|累|晚安|休息)/.test(text)) return "tired";
  return "neutral";
}

function inferEnergy(text, recentStateCue, hour) {
  if (/(困|睡|累|休息|晚安)/.test(text) || /睡觉|休息/.test(recentStateCue || "")) return "low";
  if (hour >= 0 && hour < 6) return "low";
  if (hour >= 6 && hour < 10) return "medium";
  return "medium";
}

function inferNeeds(intent, emotionalTone, browserContext) {
  if (intent === "ask_current_context") return ["proof_of_understanding", "specificity"];
  if (intent === "testing_me") return ["proof_of_understanding", "judgement"];
  if (intent === "ask_for_action") return ["execution"];
  if (intent === "planning") return ["clarity", "sequencing"];
  if (intent === "ask_for_judgement") return ["judgement"];
  if (intent === "emotional_support") return ["attunement", "validation"];
  if (browserContext && emotionalTone === "neutral") return ["specificity"];
  return ["answer"];
}

function inferResponseStyle(intent, emotionalTone, urgency) {
  if (intent === "ask_current_context" || intent === "testing_me") return "direct_specific";
  if (intent === "ask_for_action") return "action_oriented";
  if (intent === "planning") return urgency === "high" ? "brief_planning" : "structured";
  if (intent === "ask_for_judgement") return "decisive";
  if (intent === "emotional_support") return "warm_validating";
  if (emotionalTone === "frustrated") return "direct_specific";
  return "balanced";
}

function inferFocusThread({ activeTodos, currentBrowserContext, relevantMemories }) {
  if (currentBrowserContext && currentBrowserContext.title) {
    return clipText(`current:${currentBrowserContext.domainLabel || currentBrowserContext.kind || "browser"}:${currentBrowserContext.title}`, 120);
  }
  if (Array.isArray(activeTodos) && activeTodos.length > 0) {
    return clipText(`todo:${activeTodos[0].title}`, 120);
  }
  if (Array.isArray(relevantMemories) && relevantMemories.length > 0) {
    return clipText(relevantMemories[0].key || relevantMemories[0].value || "", 120);
  }
  return "";
}

function inferTurn({
  userText,
  currentBrowserContext = null,
  activeTodos = [],
  relevantMemories = [],
  recentStateCue = "",
  now = new Date(),
}) {
  const text = compactText(userText);
  const urgency = dueSoonLevel(activeTodos, now.getTime());
  const intent = inferIntent(text, currentBrowserContext);
  const emotionalTone = inferEmotionalTone(text);
  const energy = inferEnergy(text, recentStateCue, now.getHours());
  const focusThread = inferFocusThread({ activeTodos, currentBrowserContext, relevantMemories });
  const needs = inferNeeds(intent, emotionalTone, currentBrowserContext);
  const responseStyle = inferResponseStyle(intent, emotionalTone, urgency);
  const shouldReferenceContext = Boolean(
    currentBrowserContext && (intent === "ask_current_context" || intent === "testing_me" || /现在呢|这个|当前|正在看/.test(text))
  );
  const shouldUseTools = intent === "ask_for_action";
  const shouldBeBrief = shouldReferenceContext || urgency === "high" || intent === "testing_me";
  const mode = intent === "emotional_support"
    ? "companion"
    : intent === "ask_for_action"
      ? "operator"
      : /代码|渲染|app|项目|优化|bug|实现|重构|写吧|修/.test(text)
        ? "builder"
        : "general";

  const summary = clipText(
    [
      intent === "ask_current_context" ? "用户在确认 Her 是否真的知道当前正在看的内容" : "",
      intent === "testing_me" ? "用户在测试 Her 的理解和连续性" : "",
      urgency === "high" ? "用户近期有紧邻安排，回答应该更直接" : "",
      emotionalTone === "frustrated" ? "用户对当前表现不满，更需要直接证明理解" : "",
      currentBrowserContext && intent === "ask_current_context" ? `当前焦点是 ${currentBrowserContext.domainLabel || currentBrowserContext.kind || "browser"} 页面` : "",
    ].filter(Boolean).join("；"),
    160
  );

  return {
    intent,
    mode,
    emotionalTone,
    energy,
    urgency,
    focusThread,
    responseStyle,
    shouldReferenceContext,
    shouldUseTools,
    shouldBeBrief,
    needs,
    confidence: shouldReferenceContext || intent === "testing_me" ? 0.82 : 0.68,
    summary,
    signals: [
      shouldReferenceContext && currentBrowserContext ? {
        source: "browser",
        signal: `frontmost ${currentBrowserContext.domainLabel || currentBrowserContext.kind || "page"} context is relevant`,
        weight: 0.78,
      } : null,
      urgency !== "low" ? {
        source: "todo",
        signal: `upcoming commitments imply urgency=${urgency}`,
        weight: urgency === "high" ? 0.76 : 0.54,
      } : null,
      intent === "testing_me" ? {
        source: "conversation",
        signal: "user is testing understanding/continuity",
        weight: 0.81,
      } : null,
    ].filter(Boolean),
  };
}

module.exports = { inferTurn };
