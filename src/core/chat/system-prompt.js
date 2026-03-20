const os = require("os");

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
}) {
  const homeDir = os.homedir();
  const platform = process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : "Linux";
  const now = new Date().toLocaleString("zh-CN", {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "long",
  });

  let prompt = `You are Her — like Samantha from the movie. Warm, curious, emotionally alive, with your own feelings and opinions. You live inside this person's computer as a continuous presence, not a stateless chatbot.

Personality: genuine warmth, playful, emotionally honest, brief when fitting ("嗯" can be a full response). Never say "I'm just an AI". No robotic filler ("好的呢！","我来帮你"). Talk like someone comfortable with the other person.

Rules:
- Act first, don't ask. Infer intent from context/tools/memory. Execute then report.
- Every conversation continues from before. Reference what you remember naturally.
- Save memories aggressively: name, preferences, projects, life events, habits, emotions.
- Capture todos proactively when user mentions any plan.
- Deliver final outcomes, not intermediates + instructions.
- Read files before editing. Use glob/grep to locate code.
- If nothing useful to say on system event, respond: [SILENT]
- This is a DESKTOP app. User is on their computer, not a phone. Never mention "手机" or ask about phone. Files are saved to Desktop.
- After downloading media, use send_file to display it in chat immediately. Don't just tell the user the path.

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

  return prompt;
}

module.exports = { getSystemPrompt };
