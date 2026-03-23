const EventEmitter = require("events");
const { net } = require("electron");
const { createClient } = require("./anthropic-client");
const { DEFAULT_MODEL, INPUT_COST_PER_TOKEN, OUTPUT_COST_PER_TOKEN } = require("../shared/constants");
const { compactConversation, estimateTotalTokens, condenseDag, migrateInlineSummary, assembleContext } = require("./compaction");
const { extractTurnMemories, extractAIMemories } = require("./memory-extractor");
const { extractProfileObservations } = require("./profile-extractor");
const { inferTurn } = require("./turn-inference");
const { getSystemPrompt } = require("./system-prompt");
const { createTools } = require("../tools/index");

// Split-out utilities
const { clipText, toPlainText, hasRenderableAssistantText, sanitizeForJson, getMessageText, formatPhaseDetail, formatScheduleNote } = require("./text-utils");
const { TOOL_LABELS, MAX_TOOL_ROUNDS, MAX_NEWS_TOOL_CALLS, summarizeToolBlocks, isNewsTool, buildSyntheticToolReply } = require("./tool-utils");
const { sortTodosForPrompt, buildTodayCommitments, syncTimelineEvents } = require("./timeline-utils");
const { detectMode, findRecentTransientStateCue, normalizeRelationshipProfile, buildRelationshipMemoryEntries, summarizeArtifact, summarizeTask } = require("./session-helpers");

class ChatSession extends EventEmitter {
  constructor({ paths, stores, createAnthropicClient, scheduleService, environmentMonitor, awarenessService }) {
    super();
    this.paths = paths;
    this.stores = stores;
    this.createAnthropicClient = createAnthropicClient;
    this.scheduleService = scheduleService;
    this.environmentMonitor = environmentMonitor || null;
    this.awarenessService = awarenessService || null;
    this.conversationHistory = stores.conversationStore.get();
    this.dagStore = stores.summaryDagStore || null;
    this.currentAbort = null;
    this.cancelled = false;
    this.activeProcesses = [];
    this.sessionUsage = { input_tokens: 0, output_tokens: 0, total_cost: 0 };
    this.currentTurnContext = null;
    this._turnFiles = []; // files emitted during current turn

    // Migrate old inline [CONVERSATION SUMMARY] to DAG if needed
    if (this.dagStore) {
      this.conversationHistory = migrateInlineSummary(this.conversationHistory, this.dagStore);
    }

    this.tools = createTools({
      paths,
      stores,
      scheduleService,
      createAnthropicClient,
      emit: (event) => {
        if (event.type === "file") this._turnFiles.push(event);
        this.emit("event", event);
      },
    });

    if (!scheduleService.processScheduleOutput) {
      scheduleService.processScheduleOutput = this.tools.processScheduleOutput;
    }

    this.handleScheduleResult = (event) => this.emit("event", event);
    this.scheduleService.on("result", this.handleScheduleResult);
    this._repairToolResults();
    this.stores.conversationStore.save(this.conversationHistory);
    this.syncScheduleMemory();
    this._frozenMemory = this._buildMemorySnapshot();
  }

  _buildMemorySnapshot() {
    const memoryStore = this.stores.memoryStore;
    const profileStore = this.stores.profileStore;
    return {
      recentTasks: memoryStore.getTaskHistory(4),
      recentArtifacts: memoryStore.getArtifacts(3),
      identitySnapshot: memoryStore.getIdentitySnapshot(3),
      preferredNameInfo: memoryStore.getPreferredNameInfo ? memoryStore.getPreferredNameInfo() : null,
      profileSummary: profileStore ? profileStore.getPromptSummary(0.25) : "",
      understandingScore: profileStore ? profileStore.getUnderstandingScore() : 0,
    };
  }

  refreshFrozenMemory() {
    this._frozenMemory = this._buildMemorySnapshot();
  }

  destroy() {
    this.scheduleService.off("result", this.handleScheduleResult);
  }

  /**
   * Repair tool results in conversation history.
   * Handles both OpenAI format (tool_calls / role:tool) and legacy Anthropic format.
   */
  _repairToolResults() {
    const history = this.conversationHistory;
    let removedOrphans = 0;

    // --- Handle OpenAI format: assistant with tool_calls followed by role:tool messages ---
    for (let i = 0; i < history.length; i++) {
      const msg = history[i];
      if (msg.role !== "assistant" || !msg.tool_calls || msg.tool_calls.length === 0) continue;

      const expectedIds = new Set(msg.tool_calls.map((tc) => tc.id));
      const foundIds = new Set();

      // Look ahead for tool result messages
      let j = i + 1;
      while (j < history.length && history[j].role === "tool") {
        if (history[j].tool_call_id) foundIds.add(history[j].tool_call_id);
        j++;
      }

      // Patch missing tool results
      const missing = [...expectedIds].filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        const tc_map = new Map(msg.tool_calls.map((tc) => [tc.id, tc]));
        const patchMessages = missing.map((id) => ({
          role: "tool",
          tool_call_id: id,
          name: tc_map.get(id) ? tc_map.get(id).function.name : "unknown",
          content: "Operation was interrupted.",
        }));
        // Insert after the last tool message (or after assistant)
        history.splice(j, 0, ...patchMessages);
        console.log(`[Chat] Repaired ${missing.length} missing tool result(s)`);
      }
    }

    // --- Handle legacy Anthropic format for backward compat ---
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      if (msg.role !== "user" || !Array.isArray(msg.content)) continue;

      const toolResultBlocks = msg.content.filter((b) => b.type === "tool_result");
      if (toolResultBlocks.length === 0) continue;

      const prev = history[i - 1];
      const validToolIds = new Set(
        prev && prev.role === "assistant" && Array.isArray(prev.content)
          ? prev.content.filter((b) => b.type === "tool_use" && b.id).map((b) => b.id)
          : []
      );

      const nextContent = msg.content.filter((block) => {
        if (block.type !== "tool_result") return true;
        return block.tool_use_id && validToolIds.has(block.tool_use_id);
      });

      if (nextContent.length !== msg.content.length) {
        removedOrphans += msg.content.length - nextContent.length;
        if (nextContent.length === 0) {
          history.splice(i, 1);
        } else {
          msg.content = nextContent;
        }
      }
    }

    for (let i = 0; i < history.length; i++) {
      const msg = history[i];
      if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
      const toolUseBlocks = msg.content.filter((b) => b.type === "tool_use");
      if (toolUseBlocks.length === 0) continue;

      const next = history[i + 1];
      const existingResultIds = new Set();
      if (next && next.role === "user" && Array.isArray(next.content)) {
        for (const b of next.content) {
          if (b.type === "tool_result" && b.tool_use_id) existingResultIds.add(b.tool_use_id);
        }
      }

      const missing = toolUseBlocks.filter((b) => !existingResultIds.has(b.id));
      if (missing.length === 0) continue;

      const patchResults = missing.map((b) => ({
        type: "tool_result",
        tool_use_id: b.id,
        content: "Operation was interrupted.",
        is_error: true,
      }));

      if (next && next.role === "user" && Array.isArray(next.content)) {
        next.content = [...next.content, ...patchResults];
      } else {
        history.splice(i + 1, 0, { role: "user", content: patchResults });
      }
      console.log(`[Chat] Repaired ${missing.length} missing tool_result(s) (legacy)`);
    }

    if (removedOrphans > 0) {
      console.log(`[Chat] Removed ${removedOrphans} orphan tool_result block(s)`);
    }
  }

  getBootstrap() {
    const settings = this.stores.settingsStore.get();
    return {
      user: { username: "user", role: "admin" },
      status: { mac: false, win: false, clients: [] },
      messages: this.getRestoredMessages(),
      presence: this.getPresence(),
      model: settings.model || DEFAULT_MODEL,
      usage: this.sessionUsage,
      onboarding: {
        needsSetup: false,
        needsApiKey: !settings.apiKey,
        profile: settings.relationshipProfile || null,
      },
    };
  }

  emitPresence() {
    this.emit("event", { type: "presence", presence: this.getPresence() });
  }

  getPresence() {
    const settings = this.stores.settingsStore.get();
    const relationshipProfile = settings.relationshipProfile || null;
    const needsRelationshipSetup = !settings.relationshipSetupCompleted;
    const identity = this.stores.memoryStore.getIdentitySnapshot(3);
    const preferredName = this.stores.memoryStore.getPreferredNameInfo
      ? this.stores.memoryStore.getPreferredNameInfo()
      : null;
    const relationship = this.stores.memoryStore.getRelationshipNotes(3);
    const openLoops = this.stores.memoryStore.getOpenLoops(3);
    const taskHistory = this.stores.memoryStore.getTaskHistory(4);
    const artifacts = this.stores.memoryStore.getArtifacts(4);
    const activeSchedules = this.scheduleService.getActiveTasks(3);
    const recentTopics = this.getRecentTopics(3);

    const primaryLoop = openLoops[0];
    const primaryTopic = recentTopics[0];
    const relationshipLead = relationship[0];
    const identityLead = identity[0];
    const taskLead = taskHistory[0];
    const artifactLead = artifacts[0];
    const scheduleLead = activeSchedules[0];

    let greeting = "我在这。想聊聊，还是让我帮你推进一件事？";
    let status = "不是只等你下命令，而是接着你的状态继续。";

    if (primaryLoop) {
      const loopText = clipText(primaryLoop.value || primaryLoop.key, 48);
      greeting = `你上次停在"${loopText}"。要继续吗？`;
      status = "我把你最近没收尾的事记着了。";
    } else if (relationshipProfile) {
      greeting = `我会按"${relationshipProfile.tone}"的方式陪你。`;
      status = relationshipProfile.currentFocus
        ? `你最近最想推进的是"${clipText(relationshipProfile.currentFocus, 52)}"。`
        : "我会沿着你设定的关系方式继续陪你。";
    } else if (relationshipLead) {
      const note = clipText(relationshipLead.value || relationshipLead.key, 52);
      greeting = `我记得你最近一直在想"${note}"。`;
      status = "如果你想继续理顺它，我可以接着往下。";
    } else if (taskLead) {
      const note = clipText(taskLead.value || taskLead.key, 54);
      greeting = `我今天已经替你推进了这件事：${note}`;
      status = "我会把已完成任务、下载物和后续动作挂在同一条时间线上。";
    } else if (artifactLead) {
      const note = clipText((artifactLead.meta && artifactLead.meta.filename) || artifactLead.key, 42);
      greeting = `我这边还留着你最近的物料：${note}`;
      status = "图片、视频、文件不只是临时传一下，而是能被我继续引用。";
    } else if (scheduleLead) {
      const note = clipText(scheduleLead.description, 48);
      greeting = `我还挂着"${note}"这个定时任务。`;
      status = "清空对话不会影响它继续跑。";
    } else if (primaryTopic) {
      greeting = `你最近最常提的是"${primaryTopic.title}"。今天想继续推进吗？`;
      status = "我可以继续陪你想，也可以直接动手。";
    }

    const memoryNotes = [...identity, ...relationship]
      .slice(0, 4)
      .map((memory) => clipText(memory.value || memory.key, 56))
      .concat(taskHistory.slice(0, 2).map((memory) => clipText(`已完成：${memory.value || memory.key}`, 56)))
      .concat(activeSchedules.map((task) => clipText(`定时任务：${formatScheduleNote(task)}`, 56)))
      .filter(Boolean)
      .slice(0, 4);

    if (relationshipProfile) {
      const profileNotes = [
        `你希望我：${relationshipProfile.tone}`,
        `关系感觉更像：${relationshipProfile.relationshipMode}`,
        `主动程度：${relationshipProfile.proactivity}`,
        `最近主线：${relationshipProfile.currentFocus}`,
      ].map((note) => clipText(note, 56));
      memoryNotes.unshift(...profileNotes);
    }

    const loopCards = openLoops.slice(0, 3).map((memory) => ({
      title: clipText(memory.key || memory.value, 28),
      detail: clipText(memory.value || memory.key, 64),
      prompt: `继续这个：${memory.value || memory.key}`,
    }));
    const taskCards = taskHistory.slice(0, 3).map((memory) => summarizeTask(memory));
    const artifactCards = artifacts.slice(0, 3).map((memory) => summarizeArtifact(memory));

    const suggestions = [];
    if (primaryTopic) {
      suggestions.push({
        label: "帮我推进",
        prompt: `围绕"${primaryTopic.title}"帮我推进下一步`,
        description: "把最近反复提到的事往前推",
      });
    }
    if (taskLead) {
      suggestions.push({
        label: "回顾今天",
        prompt: "回顾一下你今天已经替我完成了什么，并告诉我下一步",
        description: "把今天做完的事和后续接起来",
      });
    }
    if (artifactLead) {
      const filename = artifactLead.meta && artifactLead.meta.filename ? artifactLead.meta.filename : artifactLead.key;
      suggestions.push({
        label: "找回文件",
        prompt: `把最近那个文件 ${filename} 发给我，并说明它属于哪件事`,
        description: "直接找回最近处理过的数字物料",
      });
    }
    if (scheduleLead) {
      suggestions.push({
        label: "设置提醒",
        prompt: "帮我设置一个提醒",
        description: "定时提醒我该做的事",
      });
    }
    suggestions.push(
      { label: "整理桌面", prompt: "帮我整理一下桌面，把文件归类到合适的目录", description: "自动归类桌面上的文件" },
      { label: "做表格", prompt: "帮我做一个 Excel 表格", description: "创建数据表、图表、公式等" },
      { label: "聊聊现在", prompt: "先不做任务，陪我聊聊我现在的状态", description: "偏陪伴和关系感的开场" }
    );

    const uniqueSuggestions = [];
    const seenPrompts = new Set();
    for (const suggestion of suggestions) {
      if (seenPrompts.has(suggestion.prompt)) continue;
      seenPrompts.add(suggestion.prompt);
      uniqueSuggestions.push(suggestion);
      if (uniqueSuggestions.length >= 4) break;
    }

    return {
      greeting,
      status,
      identityLine: preferredName && preferredName.primaryName
        ? clipText(
          preferredName.callName && preferredName.fullName
            ? `你叫 ${preferredName.fullName}，我更适合叫你 ${preferredName.callName}`
            : `我记得该怎么叫你：${preferredName.primaryName}`,
          64
        )
        : identityLead
          ? clipText(identityLead.value || identityLead.key, 64)
        : relationshipProfile
          ? clipText(`我会按 ${relationshipProfile.tone} + ${relationshipProfile.proactivity} 的方式陪你`, 64)
          : "",
      continuityLine: taskLead
        ? clipText(taskLead.value || taskLead.key, 80)
        : artifactLead
          ? clipText(artifactLead.value || artifactLead.key, 80)
          : "",
      memoryNotes,
      openLoops: loopCards,
      taskHistory: taskCards,
      artifacts: artifactCards,
      suggestedActions: uniqueSuggestions,
      capabilities: [
        "把你做过的事和产生的文件串成连续时间线",
        "记住下载物、图片和生成文件，之后能再发给你",
        "不是只回答一轮，而是持续接着同一批事情往下走",
      ],
      relationshipProfile,
      needsRelationshipSetup,
    };
  }

  saveRelationshipProfile(profile = {}) {
    const nextProfile = normalizeRelationshipProfile(profile);
    this.stores.settingsStore.update({
      relationshipProfile: nextProfile,
      relationshipSetupCompleted: true,
    });
    this.stores.memoryStore.saveEntries(buildRelationshipMemoryEntries(nextProfile));
    const presence = this.getPresence();
    this.emitPresence();
    return {
      profile: nextProfile,
      presence,
      onboarding: {
        needsSetup: false,
        needsApiKey: !this.stores.settingsStore.get().apiKey,
        profile: nextProfile,
      },
    };
  }

  syncScheduleMemory() {
    const summaries = this.scheduleService.getTaskSummaries(6);
    if (summaries.length === 0) {
      this.stores.memoryStore.deleteEntry("当前定时任务");
      return;
    }
    this.stores.memoryStore.saveEntry("当前定时任务", summaries.join("； "));
  }

  rememberVisualTurn({ messageText, images, response }) {
    if (!images || images.length === 0 || !response) return;

    const replyText = clipText(toPlainText(response.content), 220);
    const userText = clipText(messageText || "", 120);
    const imageLabel = images.length === 1 ? "1 张图片" : `${images.length} 张图片`;
    const filenames = images.map((image) => image.filename).filter(Boolean);
    const parts = [`用户发来 ${imageLabel}`];
    if (filenames.length > 0) parts.push(`文件名：${filenames.join(", ")}`);
    if (userText && !/^用户发送了(一张|\s*\d+\s*张)图片$/.test(userText)) parts.push(`说明：${userText}`);
    if (replyText) parts.push(`当时我的判断：${replyText}`);
    this.stores.memoryStore.saveEntry("最近图片上下文", parts.join("； "));
    if (filenames.length > 0) {
      this.stores.memoryStore.saveEntry(
        "最近图片文件",
        `共享目录中的最近图片：${filenames.join(", ")}`,
        { tags: ["image", "episode"], type: "episode" }
      );
    }
  }

  recordArtifact({ filename, kind = "file", origin = "system", detail = "" }) {
    if (!filename) return;
    const descriptions = {
      image: `共享目录里保存了一张图片 ${filename}`,
      video: `共享目录里保存了一个视频 ${filename}`,
      audio: `共享目录里保存了一个音频文件 ${filename}`,
      file: `共享目录里保存了一个文件 ${filename}`,
    };
    this.stores.memoryStore.saveEntry(`artifact:${filename}`, detail || descriptions[kind] || descriptions.file, {
      type: "artifact",
      tags: ["artifact", kind, origin],
      meta: { filename, kind, origin },
    });
    this.emitPresence();
  }

  _collectToolActions() {
    const actions = [];
    for (const msg of this.conversationHistory) {
      if (msg.role !== "assistant") continue;
      // OpenAI format: tool_calls array
      if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          const fn = tc.function || {};
          const name = fn.name || "unknown";
          const label = TOOL_LABELS[name] || name;
          let input = {};
          try { input = JSON.parse(fn.arguments || "{}"); } catch {}
          let detail = "";
          if (name === "write_file" || name === "edit_file") {
            detail = input.path || input.file_path || "";
          } else if (name === "bash") {
            detail = clipText(input.command || "", 80);
          } else if (name === "read_file" || name === "glob" || name === "grep") {
            detail = input.path || input.pattern || "";
          } else if (name === "download_media" || name === "convert_media") {
            detail = input.url || input.input || "";
          } else if (name === "search_web" || name === "search_news") {
            detail = input.query || "";
          } else if (name === "read_url") {
            detail = input.url || "";
          } else if (name === "schedule_task") {
            detail = input.description || "";
          } else if (name === "send_file") {
            detail = input.filename || input.path || "";
          } else if (name === "memory") {
            detail = input.key || "";
          }
          actions.push(detail ? `${label}: ${clipText(detail, 60)}` : label);
        }
        continue;
      }
      // Legacy Anthropic format
      if (!Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block.type !== "tool_use") continue;
        const label = TOOL_LABELS[block.name] || block.name;
        const input = block.input || {};
        let detail = "";
        if (block.name === "write_file" || block.name === "edit_file") {
          detail = input.path || input.file_path || "";
        } else if (block.name === "bash") {
          detail = clipText(input.command || "", 80);
        } else if (block.name === "read_file" || block.name === "glob" || block.name === "grep") {
          detail = input.path || input.pattern || "";
        } else if (block.name === "download_media" || block.name === "convert_media") {
          detail = input.url || input.input || "";
        } else if (block.name === "search_web" || block.name === "search_news") {
          detail = input.query || "";
        } else if (block.name === "read_url") {
          detail = input.url || "";
        } else if (block.name === "schedule_task") {
          detail = input.description || "";
        } else if (block.name === "send_file") {
          detail = input.filename || input.path || "";
        } else if (block.name === "memory") {
          detail = input.key || "";
        }
        actions.push(detail ? `${label}: ${clipText(detail, 60)}` : label);
      }
    }
    return actions;
  }

  autoRememberTurn({ userText, images, response }) {
    if (!response) return;

    const assistantText = toPlainText(response.content);
    const toolActions = this._collectToolActions();
    const entries = extractTurnMemories({
      userText,
      assistantText,
      toolActions,
      imagesCount: Array.isArray(images) ? images.length : 0,
      timestamp: new Date().toISOString(),
    });

    const filtered = entries.filter((entry) => !this.stores.memoryStore.hasSimilarEntry({
      key: entry.key,
      value: entry.value,
      type: entry.type,
      withinDays: entry.withinDays || 90,
    }));

    this.stores.memoryStore.saveEntries(filtered);

    // AI-powered deep memory extraction (async, non-blocking)
    extractAIMemories({
      userText,
      assistantText,
      createAnthropicClient: () => createClient(this.stores.settingsStore),
    }).then((aiEntries) => {
      if (aiEntries.length === 0) return;
      const aiFiltered = aiEntries.filter((entry) => !this.stores.memoryStore.hasSimilarEntry({
        key: entry.key,
        value: entry.value,
        type: entry.type,
        withinDays: entry.withinDays || 365,
      }));
      if (aiFiltered.length > 0) {
        console.log(`[MemoryAI] Saved ${aiFiltered.length} deep memories`);
        this.stores.memoryStore.saveEntries(aiFiltered);
      }
    }).catch((err) => console.error("[MemoryAI] Error:", err.message));

    // Progressive profile building
    try {
      const profileObs = extractProfileObservations({
        userText,
        assistantText,
        timestamp: new Date().toISOString(),
        messageCount: this.conversationHistory.filter((m) => m.role === "user").length,
      });
      if (profileObs.length > 0 && this.stores.profileStore) {
        this.stores.profileStore.observe(profileObs);
      }
    } catch (_) {}
  }

  getRecentTopics(limit = 3) {
    const userMessages = this.conversationHistory
      .filter((message) => message.role === "user")
      .map((message) => toPlainText(message.content))
      .map((text) => clipText(text, 80))
      .filter((text) =>
        text &&
        !text.startsWith("[system:") &&
        !text.startsWith("[CONVERSATION SUMMARY]") &&
        text !== "/clear"
      );

    return userMessages.slice(-limit).reverse().map((title) => ({ title }));
  }

  getRestoredMessages() {
    const restored = [];
    for (const message of this.conversationHistory) {
      if (message.role === "system") continue;
      if (message.role === "tool") continue;

      if (message.role === "user") {
        if (typeof message.content === "string") {
          if (message.content.startsWith("[system:") || message.content.startsWith("[CONVERSATION SUMMARY]")) continue;
          restored.push({ role: "user", text: message.content });
          continue;
        }
        if (Array.isArray(message.content)) {
          const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
          if (text.startsWith("[system:") || text.startsWith("[CONVERSATION SUMMARY]")) continue;
          if (text) {
            const hasImages = message.content.some((block) => block.type === "image_url" || block.type === "image");
            restored.push({ role: "user", text, hasImages });
          }
        }
        continue;
      }

      if (message.role === "assistant") {
        const content = message.content;
        const files = message.files || undefined;
        if (typeof content === "string") {
          if (content || files) restored.push({ role: "assistant", text: content || "", files });
        } else if (Array.isArray(content)) {
          const text = content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
          if (text || files) restored.push({ role: "assistant", text: text || "", files });
        }
      }
    }
    return restored;
  }

  emitUsage(response) {
    if (!response || !response.usage) return;
    this.sessionUsage.input_tokens += response.usage.prompt_tokens || 0;
    this.sessionUsage.output_tokens += response.usage.completion_tokens || 0;

    const inputCost = INPUT_COST_PER_TOKEN;
    const outputCost = OUTPUT_COST_PER_TOKEN;
    this.sessionUsage.total_cost =
      this.sessionUsage.input_tokens * inputCost +
      this.sessionUsage.output_tokens * outputCost;

    this.emit("event", {
      type: "usage",
      input_tokens: this.sessionUsage.input_tokens,
      output_tokens: this.sessionUsage.output_tokens,
      total_cost: this.sessionUsage.total_cost.toFixed(4),
    });
  }

  async sendMessage({ message, images, model, passiveContext = null }) {
    // If already processing, cancel current turn and queue this message
    if (this._busy) {
      this.cancel();
      this._pendingMessage = { message, images, model, passiveContext };
      return;
    }

    this._busy = true;
    this._pendingMessage = null;

    try {
      if (message && message.trim() === "/clear") {
        this.conversationHistory = [];
        this.sessionUsage = { input_tokens: 0, output_tokens: 0, total_cost: 0 };
        this.currentTurnContext = null;
        this._turnFiles = [];
        this._frozenMemory = this._buildMemorySnapshot();
        this.stores.conversationStore.clear();
        if (this.dagStore) this.dagStore.clear();
        this.emitPresence();
        this.emit("event", { type: "phase", clear: true });
        this.emit("event", { type: "clear" });
        return;
      }

      this.cancelled = false;
      this._turnFiles = [];
      const messageText = getMessageText(message, images);
      const recentStateCue = findRecentTransientStateCue(this.conversationHistory);
      const activeTodos = this.stores.todoStore ? sortTodosForPrompt(this.stores.todoStore.list()).slice(0, 6) : [];
      const todayCommitments = buildTodayCommitments(
        this.stores.todoStore,
        passiveContext && Array.isArray(passiveContext.calendar) ? passiveContext.calendar : [],
        8
      );
      syncTimelineEvents({ memoryStore: this.stores.memoryStore, todayCommitments });
      const relevantMemories = this.stores.memoryStore.getContextual(messageText, 6);

      const turnInference = inferTurn({
        userText: messageText,
        activeTodos,
        relevantMemories,
        recentStateCue,
        now: new Date(),
      });
      const mode = turnInference.mode || detectMode(messageText);
      this.currentTurnContext = {
        mode,
        relevantMemories,
        recentStateCue,
        turnInference,
        todayCommitments,
      };
      if (this.stores.stateStore) {
        this.stores.stateStore.updateCurrent({
          mode: turnInference.mode,
          intent: turnInference.intent,
          emotionalTone: turnInference.emotionalTone,
          energy: turnInference.energy,
          urgency: turnInference.urgency,
          focusThread: turnInference.focusThread,
          responseStyle: turnInference.responseStyle,
          shouldReferenceContext: turnInference.shouldReferenceContext,
          shouldUseTools: turnInference.shouldUseTools,
          shouldBeBrief: turnInference.shouldBeBrief,
          needs: turnInference.needs,
          confidence: turnInference.confidence,
          summary: turnInference.summary,
        }, turnInference.signals);
      }

      this.emit("event", {
        type: "phase",
        label: mode === "builder" ? "分析任务" : mode === "operator" ? "准备执行" : "理解需求",
        detail: formatPhaseDetail(messageText, relevantMemories.length),
      });

      // Build user message in OpenAI format
      let userContent;
      if (images && images.length > 0) {
        userContent = [
          ...images.map((image) => ({
            type: "image_url",
            image_url: { url: `data:${image.mediaType};base64,${image.base64}` },
          })),
          { type: "text", text: message || "Please analyze this image" },
        ];
      } else {
        userContent = message;
      }

      this.conversationHistory.push({ role: "user", content: userContent });
      this._repairToolResults();

      const compacted = await compactConversation({
        conversationHistory: this.conversationHistory,
        anthropic: createClient(this.stores.settingsStore),
        emit: (event) => this.emit("event", event),
        dagStore: this.dagStore,
      });
      if (compacted.compacted) {
        this.conversationHistory = compacted.newHistory;
        this._repairToolResults();
      }

      console.log(`[Tokens] ~${estimateTotalTokens(this.conversationHistory)} (${this.conversationHistory.length} msgs)`);
      this.emit("event", { type: "thinking" });

      this.currentAbort = new AbortController();
      let response = await this.streamResponse(this.currentAbort.signal, model);
      this.currentAbort = null;
      this.emitUsage(response);
      let toolRoundCount = 0;
      let newsToolCallCount = 0;
      let lastToolBlocks = [];
      let lastToolResults = [];

      while (response && response.finish_reason === "tool_calls" && !this.cancelled) {
        // Store assistant message with tool_calls
        const assistantMsg = { role: "assistant", content: response.content || null };
        if (response.tool_calls && response.tool_calls.length > 0) {
          assistantMsg.tool_calls = response.tool_calls;
        }
        this.conversationHistory.push(assistantMsg);

        const toolCalls = response.tool_calls || [];
        const toolSummary = summarizeToolBlocks(toolCalls.map((tc) => {
          let input = {};
          try { input = JSON.parse(tc.function.arguments || "{}"); } catch {}
          return { name: tc.function.name, input, id: tc.id };
        }));
        toolRoundCount += 1;
        newsToolCallCount += toolCalls.filter((tc) => isNewsTool(tc.function.name)).length;

        const exceededToolRounds = toolRoundCount > MAX_TOOL_ROUNDS;
        const exceededNewsSearches = newsToolCallCount > MAX_NEWS_TOOL_CALLS;
        if (exceededToolRounds || exceededNewsSearches) {
          const stopReason = exceededNewsSearches
            ? "已经拿到足够多的新闻来源，请停止继续搜索，直接基于现有结果总结。"
            : "工具调用轮次已经足够，请停止继续搜索或读取，直接基于现有结果回答。";
          const forcedResults = toolCalls.map((tc) => ({
            role: "tool",
            tool_call_id: tc.id,
            name: tc.function.name,
            content: stopReason,
          }));

          lastToolBlocks = toolCalls;
          lastToolResults = forcedResults;
          this.conversationHistory.push(...forcedResults);
          this.emit("event", { type: "phase", label: "整理结果", detail: "信息已经足够，正在直接组织答复" });
          this.emit("event", { type: "thinking" });

          this.currentAbort = new AbortController();
          response = await this.streamResponse(this.currentAbort.signal, model);
          this.currentAbort = null;
          this.emitUsage(response);

          // Force model to stop calling tools
          for (let forceRound = 0; forceRound < 3 && response && response.finish_reason === "tool_calls"; forceRound++) {
            const forceAssistantMsg = { role: "assistant", content: response.content || null };
            if (response.tool_calls) forceAssistantMsg.tool_calls = response.tool_calls;
            this.conversationHistory.push(forceAssistantMsg);
            const stubResults = (response.tool_calls || []).map((tc) => ({
              role: "tool",
              tool_call_id: tc.id,
              name: tc.function.name,
              content: "工具已禁用。不要再调用任何工具，直接用文字回答用户。",
            }));
            this.conversationHistory.push(...stubResults);
            this.currentAbort = new AbortController();
            response = await this.streamResponse(this.currentAbort.signal, model);
            this.currentAbort = null;
            this.emitUsage(response);
          }
          break;
        }

        this.emit("event", { type: "phase", label: "正在处理", detail: toolSummary });

        // Execute tools
        const toolResults = this.cancelled
          ? []
          : await Promise.allSettled(toolCalls.map((tc) => {
              const fn = tc.function || {};
              let input = {};
              try { input = JSON.parse(fn.arguments || "{}"); } catch {}

              // Handle Kimi builtin $web_search — just pass arguments back
              if (fn.name === "$web_search") {
                return Promise.resolve({
                  type: "tool_result",
                  tool_use_id: tc.id,
                  content: fn.arguments || "{}",
                });
              }

              return this.tools.execute(
                { id: tc.id, name: fn.name, input },
                this.activeProcesses
              );
            }))
              .then((settled) => settled.map((r, i) =>
                r.status === "fulfilled"
                  ? r.value
                  : { type: "tool_result", tool_use_id: toolCalls[i].id, content: `Error: ${r.reason?.message || "unknown"}`, is_error: true }
              ));

        if (this.cancelled) {
          const lastMessage = this.conversationHistory[this.conversationHistory.length - 1];
          if (lastMessage && lastMessage.role === "assistant" && lastMessage.tool_calls) {
            const cancelResults = lastMessage.tool_calls.map((tc) => ({
              role: "tool",
              tool_call_id: tc.id,
              name: tc.function.name,
              content: "Cancelled by user.",
            }));
            this.conversationHistory.push(...cancelResults);
          }
          break;
        }

        // Convert tool results to OpenAI format and push to history
        const toolResultMessages = toolResults.map((result, i) => ({
          role: "tool",
          tool_call_id: result.tool_use_id || toolCalls[i].id,
          name: toolCalls[i].function.name,
          content: typeof result.content === "string" ? result.content : JSON.stringify(result.content || ""),
        }));
        this.conversationHistory.push(...toolResultMessages);

        lastToolBlocks = toolCalls.map((tc) => {
          let input = {};
          try { input = JSON.parse(tc.function.arguments || "{}"); } catch {}
          return { name: tc.function.name, input, id: tc.id };
        });
        lastToolResults = toolResults;
        this.emit("event", { type: "phase", label: "整理结果", detail: `已完成${toolSummary}，正在组织答复` });
        this.emit("event", { type: "thinking" });

        // Safety: ensure every tool_call has a matching tool result in history
        const lastAssistant = this.conversationHistory.filter((m) => m.role === "assistant" && m.tool_calls).pop();
        if (lastAssistant && lastAssistant.tool_calls) {
          const expectedIds = new Set(lastAssistant.tool_calls.map((tc) => tc.id));
          const foundIds = new Set();
          for (let hi = this.conversationHistory.length - 1; hi >= 0; hi--) {
            const m = this.conversationHistory[hi];
            if (m.role === "tool" && m.tool_call_id) foundIds.add(m.tool_call_id);
            if (m === lastAssistant) break;
          }
          for (const id of expectedIds) {
            if (!foundIds.has(id)) {
              const tc = lastAssistant.tool_calls.find((t) => t.id === id);
              this.conversationHistory.push({
                role: "tool",
                tool_call_id: id,
                name: tc ? tc.function.name : "unknown",
                content: "Tool execution failed or was interrupted.",
              });
              console.log(`[Chat] Patched missing tool result for ${id}`);
            }
          }
        }

        this.currentAbort = new AbortController();
        response = await this.streamResponse(this.currentAbort.signal, model);
        this.currentAbort = null;
        this.emitUsage(response);
      }

      if (response && !this.cancelled && lastToolResults.length > 0 && !hasRenderableAssistantText(response.content)) {
        response = { ...response, content: buildSyntheticToolReply(lastToolBlocks, lastToolResults) };
      }

      if (response && !this.cancelled) {
        const assistantEntry = { role: "assistant", content: response.content };
        if (this._turnFiles.length > 0) {
          assistantEntry.files = this._turnFiles.map((f) => ({
            filename: f.filename, url: f.url, fileType: f.fileType, size: f.size,
          }));
        }
        this.conversationHistory.push(assistantEntry);
        const deferredResponse = response;
        const deferredText = messageText;
        const deferredImages = images;
        setImmediate(() => {
          try {
            this.autoRememberTurn({ userText: deferredText, images: deferredImages, response: deferredResponse });
            this.rememberVisualTurn({ messageText: deferredText, images: deferredImages, response: deferredResponse });
            this.syncScheduleMemory();
            this.emitPresence();
          } catch (err) {
            console.error("[Chat] Deferred post-turn error:", err.message);
          }
        });
      } else {
        this.syncScheduleMemory();
        this.emitPresence();
      }

      this.stores.conversationStore.save(this.conversationHistory);

      // Post-turn: condense DAG if too many uncondensed leaves
      if (this.dagStore && this.dagStore.getUncondensedLeafCount() >= 4) {
        condenseDag({ dagStore: this.dagStore, anthropic: createClient(this.stores.settingsStore) }).catch((err) => {
          console.error("[Chat] DAG condensation error:", err.message);
        });
      }
    } catch (error) {
      this.currentAbort = null;
      if (this.cancelled || error.name === "AbortError") return;
      console.error("[Chat] Error:", error);
      let messageText = error.message || "Something went wrong";
      if (error.status === 401) messageText = "API key invalid. Please check Settings.";
      else if (error.status === 429) messageText = "Rate limited. Please wait a moment.";
      console.error("[Chat] Full error:", messageText);
      this.emit("event", { type: "phase", clear: true });
      this.emit("event", { type: "error", text: messageText });
    } finally {
      this.currentTurnContext = null;
      this._busy = false;

      // Process queued message if user sent one while we were busy
      const pending = this._pendingMessage;
      if (pending) {
        this._pendingMessage = null;
        setImmediate(() => this.sendMessage(pending));
      }
    }
  }

  cancel() {
    this.cancelled = true;
    if (this.currentAbort) {
      this.currentAbort.abort();
      this.currentAbort = null;
    }
    this.activeProcesses.forEach((processRef) => {
      try { processRef.kill("SIGTERM"); } catch (error) {}
    });
    this.activeProcesses = [];
    this.emit("event", { type: "phase", clear: true });

    // Patch any orphan tool_calls so the next API call won't fail
    this._patchOrphanToolResults();
    this.stores.conversationStore.save(this.conversationHistory);
  }

  /** Ensure every assistant tool_call has a matching tool result in history */
  _patchOrphanToolResults() {
    const history = this.conversationHistory;
    for (let i = 0; i < history.length; i++) {
      const msg = history[i];
      if (msg.role !== "assistant" || !msg.tool_calls || msg.tool_calls.length === 0) continue;

      const expectedIds = new Set(msg.tool_calls.map((tc) => tc.id));
      const foundIds = new Set();
      let j = i + 1;
      while (j < history.length && history[j].role === "tool") {
        if (history[j].tool_call_id) foundIds.add(history[j].tool_call_id);
        j++;
      }

      const missing = [...expectedIds].filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        const tcMap = new Map(msg.tool_calls.map((tc) => [tc.id, tc]));
        const patches = missing.map((id) => ({
          role: "tool",
          tool_call_id: id,
          name: tcMap.get(id) ? tcMap.get(id).function.name : "unknown",
          content: "Operation was cancelled.",
        }));
        history.splice(j, 0, ...patches);
        console.log(`[Chat] Patched ${missing.length} orphan tool result(s) after cancel`);
      }
    }
  }

  async streamResponse(abortSignal, requestedModel, retries = 0) {
    const maxRetries = 3;
    try {
      return await this.streamResponseRaw(abortSignal, requestedModel);
    } catch (error) {
      if (error.name === "AbortError") return null;
      const msg = error.message || "";
      const statusMatch = msg.match(/^(\d+)/);
      const status = statusMatch ? Number.parseInt(statusMatch[1], 10) : 0;
      const isNetworkError = /NETWORK_CHANGED|ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed|network|socket hang up/i.test(msg);
      const isRetryableStatus = status === 503 || status === 429 || status === 500 || status === 502;
      if ((isRetryableStatus || isNetworkError) && retries < maxRetries) {
        const delay = (retries + 1) * 2000;
        console.log(`[API] Retry ${retries + 1}/${maxRetries} after ${delay}ms (${isNetworkError ? "network" : status})`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        this.emit("event", { type: "stream_end" });
        this.emit("event", { type: "thinking" });
        return this.streamResponse(abortSignal, requestedModel, retries + 1);
      }
      throw error;
    }
  }

  async streamResponseRaw(abortSignal, requestedModel) {
    const settings = this.stores.settingsStore.get();
    const selectedModel = requestedModel || settings.model || DEFAULT_MODEL;
    const frozen = this._frozenMemory || this._buildMemorySnapshot();
    const profileSummary = frozen.profileSummary;
    const understandingScore = frozen.understandingScore;
    const activeTodos = this.stores.todoStore ? sortTodosForPrompt(this.stores.todoStore.list()).slice(0, 6) : [];
    const environmentSnapshot = this.environmentMonitor ? this.environmentMonitor.getSnapshot() : null;
    const awarenessContext = this.awarenessService ? this.awarenessService.getContext() : "";
    const stateSummary = this.stores.stateStore ? this.stores.stateStore.getPromptSummary() : "";
    const systemPrompt = getSystemPrompt({
      memoryStore: this.stores.memoryStore,
      sharedDir: this.paths.sharedDir,
      relevantMemories: this.currentTurnContext ? this.currentTurnContext.relevantMemories : [],
      activeSchedules: this.scheduleService.getActiveTasks(6),
      activeTodos,
      mode: this.currentTurnContext ? this.currentTurnContext.mode : "general",
      relationshipProfile: settings.relationshipProfile || null,
      recentStateCue: this.currentTurnContext ? this.currentTurnContext.recentStateCue : "",
      profileSummary,
      understandingScore,
      environmentSnapshot,
      todayCommitments: this.currentTurnContext ? this.currentTurnContext.todayCommitments : [],
      currentTurnInference: this.currentTurnContext ? this.currentTurnContext.turnInference : null,
      currentStateSummary: stateSummary,
      awarenessContext,
      frozenMemory: frozen,
      availableTools: this.tools.tools,
    });

    if (this.tools.setModel) this.tools.setModel(selectedModel);
    const client = createClient(this.stores.settingsStore);

    // Build messages array with system prompt as first message
    // Filter out empty assistant messages and strip non-API fields (e.g. files)
    const messages = [
      { role: "system", content: systemPrompt },
      ...this.conversationHistory
        .filter((m) => {
          if (m.role === "assistant") {
            const hasContent = m.content && (typeof m.content === "string" ? m.content.trim() : true);
            const hasToolCalls = m.tool_calls && m.tool_calls.length > 0;
            return hasContent || hasToolCalls;
          }
          return true;
        })
        .map((m) => {
          if (m.files) { const { files, ...rest } = m; return rest; }
          return m;
        }),
    ];

    const payload = sanitizeForJson({
      model: selectedModel,
      max_tokens: 16384,
      tools: this.tools.getTools ? this.tools.getTools(selectedModel) : this.tools.tools,
      messages,
      stream: true,
      thinking: { type: "disabled" },
    });

    const controller = new AbortController();
    let aborted = false;
    if (abortSignal) {
      abortSignal.addEventListener("abort", () => {
        aborted = true;
        controller.abort();
      }, { once: true });
    }

    const stream = await client.chat.completions.create(payload, { signal: controller.signal });

    let currentText = "";
    let toolCalls = []; // array of { id, function: { name, arguments } }
    let finishReason = "stop";
    let usage = {};

    let textBuffer = "";
    let flushTimer = null;
    const flushText = () => {
      if (textBuffer && !aborted) {
        this.emit("event", { type: "stream", text: textBuffer });
        textBuffer = "";
      }
      flushTimer = null;
    };

    for await (const chunk of stream) {
      if (aborted) break;

      const choice = chunk.choices && chunk.choices[0];
      if (!choice) {
        // May be a usage-only chunk
        if (chunk.usage) usage = { ...usage, ...chunk.usage };
        continue;
      }

      const delta = choice.delta;
      if (!delta) {
        if (choice.finish_reason) finishReason = choice.finish_reason;
        continue;
      }

      // Text content
      if (delta.content) {
        currentText += delta.content;
        textBuffer += delta.content;
        if (textBuffer.length >= 12) {
          if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
          flushText();
        } else if (!flushTimer) {
          flushTimer = setTimeout(flushText, 30);
        }
      }

      // Tool calls (streamed incrementally)
      if (delta.tool_calls) {
        for (const tcDelta of delta.tool_calls) {
          const idx = tcDelta.index;
          // Ensure slot exists
          while (toolCalls.length <= idx) {
            toolCalls.push({ id: "", function: { name: "", arguments: "" } });
          }
          if (tcDelta.id) toolCalls[idx].id = tcDelta.id;
          if (tcDelta.function) {
            if (tcDelta.function.name) toolCalls[idx].function.name = tcDelta.function.name;
            if (tcDelta.function.arguments) toolCalls[idx].function.arguments += tcDelta.function.arguments;
          }
        }
      }

      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }

      if (chunk.usage) {
        usage = { ...usage, ...chunk.usage };
      }
    }

    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    flushText();

    if (!aborted) this.emit("event", { type: "stream_end" });

    // Content as plain string for OpenAI/Kimi API compatibility
    const content = currentText || "";

    const result = {
      content,
      finish_reason: finishReason,
      usage: {
        prompt_tokens: usage.prompt_tokens || 0,
        completion_tokens: usage.completion_tokens || 0,
      },
    };

    // Attach tool_calls if present
    if (toolCalls.length > 0 && finishReason === "tool_calls") {
      result.tool_calls = toolCalls;
    }

    return result;
  }

}

module.exports = { ChatSession };
