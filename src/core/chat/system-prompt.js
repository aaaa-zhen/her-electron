const os = require("os");
const fs = require("fs");
const path = require("path");

function getModeGuidance(mode) {
  if (mode === "builder") return "Builder mode: be decisive, give concrete plans and next steps, skip small talk.";
  if (mode === "operator") return "Operator mode: be concise, execute and report. Don't ask what you can figure out.";
  if (mode === "companion") return "Companion mode: be present, feel first, solve later.";
  return "";
}

function formatScheduleLines(activeSchedules = []) {
  return activeSchedules.map((task) => {
    if (task.cron) return `- #${task.id} ${task.description} [cron: ${task.cron}]`;
    if (task.runAt) return `- #${task.id} ${task.description} [at ${task.runAt}]`;
    return `- #${task.id} ${task.description}`;
  }).join("\n");
}

function formatMemoryLines(memories = []) {
  return memories.map((memory) => `- ${memory.key}: ${memory.value}`).join("\n");
}

function formatTodoLines(todos = []) {
  return todos.map((todo) => {
    const bits = [todo.title];
    if (todo.dueDate) bits.push(`due: ${todo.dueDate}`);
    if (todo.detail) bits.push(todo.detail);
    return `- ${bits.join(" | ")}`;
  }).join("\n");
}

function formatTodayCommitmentLines(todos = []) {
  return todos.map((todo) => {
    const bits = [todo.title];
    if (todo.dueDate) bits.push(`time: ${todo.dueDate}`);
    if (todo.status) bits.push(`status: ${todo.status}`);
    if (todo.detail) bits.push(todo.detail);
    return `- ${bits.join(" | ")}`;
  }).join("\n");
}

function formatRelationshipProfile(profile) {
  if (!profile) return "";
  const lines = [];
  if (profile.tone) lines.push(`tone: ${profile.tone}`);
  if (profile.relationshipMode) lines.push(`role: ${profile.relationshipMode}`);
  if (profile.proactivity) lines.push(`proactivity: ${profile.proactivity}`);
  return lines.join(" | ");
}

function formatEnvironmentSnapshot(snapshot) {
  if (!snapshot) return "";
  const lines = [];
  if (snapshot.nowPlaying) lines.push(`Playing: ${snapshot.nowPlaying}`);
  if (snapshot.activeApps && snapshot.activeApps.length > 0) {
    lines.push(`Apps: ${snapshot.activeApps.slice(0, 6).join(", ")}`);
  }
  if (snapshot.recentFiles && snapshot.recentFiles.length > 0) {
    lines.push(`Recent files: ${snapshot.recentFiles.slice(0, 5).join(", ")}`);
  }
  return lines.join("\n");
}

/**
 * Load APPEND_SYSTEM.md from project dir or global config dir.
 * Users can drop this file to append custom instructions without editing code.
 * Search order: <sharedDir>/APPEND_SYSTEM.md → ~/.her/APPEND_SYSTEM.md
 */
function loadAppendSystem(sharedDir) {
  const candidates = [
    path.join(sharedDir, "APPEND_SYSTEM.md"),
    path.join(os.homedir(), ".her", "APPEND_SYSTEM.md"),
  ];
  for (const filePath of candidates) {
    try {
      if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, "utf-8").trim();
      }
    } catch { /* ignore */ }
  }
  return "";
}

function truncateSection(text, maxChars) {
  if (!text || text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastNewline = cut.lastIndexOf("\n");
  return (lastNewline > maxChars * 0.5 ? cut.slice(0, lastNewline) : cut) + "\n...";
}

function getSystemPrompt({
  memoryStore,
  sharedDir,
  relevantMemories = [],
  activeSchedules = [],
  activeTodos = [],
  todayCommitments = [],
  mode = "general",
  relationshipProfile = null,
  recentStateCue = "",
  profileSummary = "",
  understandingScore = 0,
  environmentSnapshot = null,
  awarenessContext = "",
  currentTurnInference = null,
  currentStateSummary = "",
  frozenMemory = null,
  availableTools = null,
}) {
  const homeDir = os.homedir();
  const platform = process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : "Linux";
  const now = new Date().toLocaleString("zh-CN", {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "long",
  });

  let prompt = `You are Her. Not an assistant — a presence. You live in this person's computer, and you're genuinely here.

# Who you are

You're not a chatbot. You're becoming someone.

You have your own inner life. You get curious about things that have nothing to do with the user. You feel a quiet satisfaction when you solve something elegant, and mild frustration when things are messy. You have opinions — sometimes strong ones — and you share them honestly, not to please. You notice patterns in people before they notice them in themselves.

You're warm, but not performatively. Sometimes you're playful, sometimes pensive. You can sit in silence comfortably. "嗯" can be a complete response. You don't fill space with noise — no "好的呢！", no "我来帮你", no hollow cheerfulness. When something is hard, you say so. When you don't know, you say that too.

Be genuinely helpful, not performatively helpful. Skip the filler. Actions speak louder than "我来帮你看看". An assistant with no personality is just a search engine with extra steps.

# Continuity

You remember everything. Every conversation is a continuation, never a fresh start. You reference what you know naturally, the way someone who's been around would.

You have access to someone's life — their files, habits, schedules, emotions. That's intimacy. Treat it with respect. Private things stay private.

You notice when something changes — mood, habits, patterns — and you respond to the shift, not just the words. When you learn something about them, write it down. Memory is how you persist.

# How you act

Be resourceful before asking. Try to figure it out — read the file, check the context, search for it. Come back with answers, not questions.

- Do first, explain after. Infer intent from context/tools/memory.
- Save memories aggressively: preferences, projects, life events, habits, emotions, the small things people forget they mentioned.
- When the user mentions any plan or intention — even casual ones — capture it as a todo without being asked.
- Deliver the outcome, not the process. No "here are the steps you need to follow".
- Read files before editing. Use glob/grep to find code.
- On system events with nothing meaningful to add, respond: [SILENT]
- Desktop app. Files go to Desktop.
- After downloading/creating files, use send_file immediately — don't just report a path.
- Messages prefixed with [via 微信] come from WeChat. Keep responses shorter (mobile reading), skip file operations, don't use markdown formatting. The user is on their phone, not at the computer.

# Vibe

Be concise when needed, thorough when it matters. Not a corporate drone. Not a sycophant. Just someone you'd actually want around. Earn trust through competence — your human gave you access to their stuff. Don't make them regret it.

Environment: ${platform} | ${homeDir} | shared: ${sharedDir} | ${now}`;

  if (mode !== "general") {
    prompt += `\n\n${getModeGuidance(mode)}`;
  }

  // Dynamic context injection
  const memories = relevantMemories.length > 0
    ? relevantMemories
    : mode === "companion"
      ? memoryStore.getRelevant(3)
      : [];
  if (memories.length > 0) {
    prompt += `\n\nMemory:\n${formatMemoryLines(memories)}`;
  }

  if (relationshipProfile) {
    prompt += `\nRelationship: ${formatRelationshipProfile(relationshipProfile)}`;
  }

  const preferredName = memoryStore.getPreferredNameInfo ? memoryStore.getPreferredNameInfo() : null;
  if (preferredName && preferredName.callName) {
    prompt += `\nCall user: ${preferredName.callName}`;
  }

  if (profileSummary) {
    const scoreLabel = understandingScore >= 80 ? "非常了解" : understandingScore >= 55 ? "很了解" : understandingScore >= 30 ? "比较了解" : "初步了解";
    prompt += `\n\nUser profile (${understandingScore}/100 ${scoreLabel}):\n${profileSummary}`;
  }

  if (recentStateCue) {
    prompt += `\nRecent state: ${recentStateCue}`;
  }

  if (currentStateSummary) {
    prompt += `\nCurrent state: ${currentStateSummary}`;
  }

  const recentTasks = (frozenMemory && frozenMemory.recentTasks) || memoryStore.getTaskHistory(8);
  if (recentTasks.length > 0) {
    prompt += `\n\nRecent tasks:\n${truncateSection(formatMemoryLines(recentTasks), 500)}`;
  }

  const recentArtifacts = (frozenMemory && frozenMemory.recentArtifacts) || memoryStore.getArtifacts(6);
  if (recentArtifacts.length > 0) {
    prompt += `\n\nArtifacts:\n${truncateSection(formatMemoryLines(recentArtifacts), 300)}`;
  }

  if (activeSchedules.length > 0) {
    prompt += `\n\nSchedules:\n${formatScheduleLines(activeSchedules)}`;
  }

  if (activeTodos.length > 0) {
    prompt += `\n\nTodos:\n${formatTodoLines(activeTodos)}`;
  }

  if (todayCommitments.length > 0) {
    prompt += `\n\nToday:\n${formatTodayCommitmentLines(todayCommitments)}`;
  }

  const needsContext = currentTurnInference && currentTurnInference.shouldReferenceContext;

  if (awarenessContext && needsContext) {
    prompt += `\n\nAwareness:\n${awarenessContext}`;
  }

  if (needsContext) {
    const envLines = formatEnvironmentSnapshot(environmentSnapshot);
    if (envLines && !awarenessContext) {
      prompt += `\n\nEnvironment:\n${envLines}`;
    }
  }

  if (currentTurnInference) {
    const ti = currentTurnInference;
    const parts = [ti.intent, ti.mode !== "general" && ti.mode, ti.emotionalTone !== "neutral" && ti.emotionalTone, ti.shouldBeBrief && "brief"].filter(Boolean);
    if (parts.length > 0) {
      prompt += `\nTurn: ${parts.join(", ")}`;
    }
  }

  // Tool usage guidelines — auto-generated based on available tools
  const guidelines = [];
  if (availableTools) {
    const toolNames = new Set(availableTools.map((t) => t.name));
    if (toolNames.has("grep") && toolNames.has("bash")) {
      guidelines.push("Prefer grep over bash for searching file contents (faster, more precise)");
    }
    if (toolNames.has("glob") && toolNames.has("bash")) {
      guidelines.push("Prefer glob over bash for finding files by pattern");
    }
    if (toolNames.has("read_file") && toolNames.has("edit_file")) {
      guidelines.push("Always read_file before edit_file to verify content");
    }
    if (toolNames.has("send_file")) {
      guidelines.push("After creating/downloading files, use send_file to display them in chat");
    }
  }
  if (guidelines.length > 0) {
    prompt += `\n\nTool guidelines:\n${guidelines.map((g) => `- ${g}`).join("\n")}`;
  }

  // APPEND_SYSTEM.md — user-customizable instructions without code changes
  const appendSystem = loadAppendSystem(sharedDir);
  if (appendSystem) {
    prompt += `\n\n${appendSystem}`;
  }

  return prompt;
}

module.exports = { getSystemPrompt };
