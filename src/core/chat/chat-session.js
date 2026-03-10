const EventEmitter = require("events");
const { net } = require("electron");
const { createAnthropicClient } = require("./anthropic-client");
const { DEFAULT_MODEL, INPUT_COST_PER_TOKEN, OUTPUT_COST_PER_TOKEN } = require("../shared/constants");
const { compactConversation, estimateTotalTokens } = require("./compaction");
const { extractTurnMemories, extractAIMemories } = require("./memory-extractor");
const { extractProfileObservations } = require("./profile-extractor");
const { inferTurn } = require("./turn-inference");
const { getSystemPrompt } = require("./system-prompt");
const { createTools } = require("../tools/index");

// Split-out utilities
const { clipText, toPlainText, hasRenderableAssistantText, sanitizeForJson, getMessageText, formatPhaseDetail, formatScheduleNote } = require("./text-utils");
const { TOOL_LABELS, MAX_TOOL_ROUNDS, MAX_NEWS_TOOL_CALLS, summarizeToolBlocks, isNewsTool, buildSyntheticToolReply } = require("./tool-utils");
const { sortTodosForPrompt, buildTodayCommitments, syncTimelineEvents } = require("./timeline-utils");
const { detectMode, findRecentTransientStateCue, normalizeBrowserContext, normalizeRelationshipProfile, buildRelationshipMemoryEntries, summarizeArtifact, summarizeTask } = require("./session-helpers");

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
    this.currentAbort = null;
    this.cancelled = false;
    this.activeProcesses = [];
    this.sessionUsage = { input_tokens: 0, output_tokens: 0, total_cost: 0 };
    this.currentTurnContext = null;

    this.tools = createTools({
      paths,
      stores,
      scheduleService,
      createAnthropicClient,
      emit: (event) => this.emit("event", event),
    });

    if (!scheduleService.processScheduleOutput) {
      scheduleService.processScheduleOutput = this.tools.processScheduleOutput;
    }

    this.handleScheduleResult = (event) => this.emit("event", event);
    this.scheduleService.on("result", this.handleScheduleResult);
    this._repairToolResults();
    this.stores.conversationStore.save(this.conversationHistory);
    this.syncScheduleMemory();
  }

  destroy() {
    this.scheduleService.off("result", this.handleScheduleResult);
  }

  _repairToolResults() {
    const history = this.conversationHistory;
    let removedOrphans = 0;

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
      console.log(`[Chat] Repaired ${missing.length} missing tool_result(s)`);
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
        needsSetup: !settings.relationshipSetupCompleted,
        needsApiKey: false,
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
      { label: "帮我做点事", prompt: "帮我在电脑上推进一件具体的事", description: "直接进入执行模式" },
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
      onboarding: { needsSetup: false, profile: nextProfile },
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
      if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
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
      createAnthropicClient: () => createAnthropicClient(this.stores.settingsStore),
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
            const hasImages = message.content.some((block) => block.type === "image");
            restored.push({ role: "user", text, hasImages });
          }
        }
        continue;
      }

      if (message.role === "assistant") {
        const parts = Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }];
        const text = parts.filter((block) => block.type === "text").map((block) => block.text).join("\n");
        if (text) restored.push({ role: "assistant", text });
      }
    }
    return restored;
  }

  emitUsage(response) {
    if (!response || !response.usage) return;
    this.sessionUsage.input_tokens += response.usage.input_tokens || 0;
    this.sessionUsage.output_tokens += response.usage.output_tokens || 0;
    this.sessionUsage.total_cost =
      this.sessionUsage.input_tokens * INPUT_COST_PER_TOKEN +
      this.sessionUsage.output_tokens * OUTPUT_COST_PER_TOKEN;

    this.emit("event", {
      type: "usage",
      input_tokens: this.sessionUsage.input_tokens,
      output_tokens: this.sessionUsage.output_tokens,
      total_cost: this.sessionUsage.total_cost.toFixed(4),
    });
  }

  async sendMessage({ message, images, model, passiveContext = null }) {
    try {
      if (message && message.trim() === "/clear") {
        this.conversationHistory = [];
        this.sessionUsage = { input_tokens: 0, output_tokens: 0, total_cost: 0 };
        this.currentTurnContext = null;
        this.stores.conversationStore.clear();
        this.emitPresence();
        this.emit("event", { type: "phase", clear: true });
        this.emit("event", { type: "clear" });
        return;
      }

      this.cancelled = false;
      const messageText = getMessageText(message, images);
      const recentStateCue = findRecentTransientStateCue(this.conversationHistory);
      const currentBrowserContext = normalizeBrowserContext(passiveContext && passiveContext.currentPage);
      const activeTodos = this.stores.todoStore ? sortTodosForPrompt(this.stores.todoStore.list()).slice(0, 6) : [];
      const todayCommitments = buildTodayCommitments(
        this.stores.todoStore,
        passiveContext && Array.isArray(passiveContext.calendar) ? passiveContext.calendar : [],
        8
      );
      syncTimelineEvents({ memoryStore: this.stores.memoryStore, todayCommitments });
      let relevantMemories = this.stores.memoryStore.getContextual(messageText, 12);
      try {
        const semantic = await this.stores.memoryStore.getContextualSemantic(messageText, 12);
        if (semantic && semantic.length > 0) relevantMemories = semantic;
      } catch {}

      const turnInference = inferTurn({
        userText: messageText,
        currentBrowserContext,
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
        currentBrowserContext,
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

      const userContent = images && images.length > 0
        ? [
          ...images.map((image) => ({
            type: "image",
            source: { type: "base64", media_type: image.mediaType, data: image.base64 },
          })),
          { type: "text", text: message || "Please analyze this image" },
        ]
        : message;

      this.conversationHistory.push({ role: "user", content: userContent });
      this._repairToolResults();

      const compacted = await compactConversation({
        conversationHistory: this.conversationHistory,
        anthropic: this.createAnthropicClient(),
        emit: (event) => this.emit("event", event),
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

      while (response && response.stop_reason === "tool_use" && !this.cancelled) {
        this.conversationHistory.push({ role: "assistant", content: response.content });
        const toolBlocks = response.content.filter((block) => block.type === "tool_use");
        const toolSummary = summarizeToolBlocks(toolBlocks);
        toolRoundCount += 1;
        newsToolCallCount += toolBlocks.filter((block) => isNewsTool(block.name)).length;

        const exceededToolRounds = toolRoundCount > MAX_TOOL_ROUNDS;
        const exceededNewsSearches = newsToolCallCount > MAX_NEWS_TOOL_CALLS;
        if (exceededToolRounds || exceededNewsSearches) {
          const stopReason = exceededNewsSearches
            ? "已经拿到足够多的新闻来源，请停止继续搜索，直接基于现有结果总结。"
            : "工具调用轮次已经足够，请停止继续搜索或读取，直接基于现有结果回答。";
          const forcedResults = toolBlocks.map((block) => ({
            type: "tool_result",
            tool_use_id: block.id,
            content: stopReason,
            is_error: false,
          }));

          lastToolBlocks = toolBlocks;
          lastToolResults = forcedResults;
          this.conversationHistory.push({ role: "user", content: forcedResults });
          this.emit("event", { type: "phase", label: "整理结果", detail: "信息已经足够，正在直接组织答复" });
          this.emit("event", { type: "thinking" });

          this.currentAbort = new AbortController();
          response = await this.streamResponse(this.currentAbort.signal, model);
          this.currentAbort = null;
          this.emitUsage(response);

          // Force model to stop calling tools
          for (let forceRound = 0; forceRound < 3 && response && response.stop_reason === "tool_use"; forceRound++) {
            this.conversationHistory.push({ role: "assistant", content: response.content });
            const stubResults = response.content
              .filter((b) => b.type === "tool_use")
              .map((b) => ({ type: "tool_result", tool_use_id: b.id, content: "工具已禁用。不要再调用任何工具，直接用文字回答用户。", is_error: true }));
            this.conversationHistory.push({ role: "user", content: stubResults });
            this.currentAbort = new AbortController();
            response = await this.streamResponse(this.currentAbort.signal, model);
            this.currentAbort = null;
            this.emitUsage(response);
          }
          break;
        }

        this.emit("event", { type: "phase", label: "正在处理", detail: toolSummary });

        const toolResults = this.cancelled
          ? []
          : await Promise.allSettled(toolBlocks.map((block) => this.tools.execute(block, this.activeProcesses)))
              .then((settled) => settled.map((r, i) =>
                r.status === "fulfilled"
                  ? r.value
                  : { type: "tool_result", tool_use_id: toolBlocks[i].id, content: `Error: ${r.reason?.message || "unknown"}`, is_error: true }
              ));

        if (this.cancelled) {
          const lastMessage = this.conversationHistory[this.conversationHistory.length - 1];
          if (lastMessage && lastMessage.role === "assistant" && Array.isArray(lastMessage.content)) {
            const cancelResults = lastMessage.content
              .filter((block) => block.type === "tool_use")
              .map((block) => ({ type: "tool_result", tool_use_id: block.id, content: "Cancelled by user." }));
            if (cancelResults.length > 0) this.conversationHistory.push({ role: "user", content: cancelResults });
          }
          break;
        }

        this.conversationHistory.push({ role: "user", content: toolResults });
        lastToolBlocks = toolBlocks;
        lastToolResults = toolResults;
        this.emit("event", { type: "phase", label: "整理结果", detail: `已完成${toolSummary}，正在组织答复` });
        this.emit("event", { type: "thinking" });

        this.currentAbort = new AbortController();
        response = await this.streamResponse(this.currentAbort.signal, model);
        this.currentAbort = null;
        this.emitUsage(response);
      }

      if (response && !this.cancelled && lastToolResults.length > 0 && !hasRenderableAssistantText(response.content)) {
        response = { ...response, content: buildSyntheticToolReply(lastToolBlocks, lastToolResults) };
      }

      if (response && !this.cancelled) {
        this.conversationHistory.push({ role: "assistant", content: response.content });
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
    const profileSummary = this.stores.profileStore ? this.stores.profileStore.getPromptSummary(0.25) : "";
    const understandingScore = this.stores.profileStore ? this.stores.profileStore.getUnderstandingScore() : 0;
    const activeTodos = this.stores.todoStore ? sortTodosForPrompt(this.stores.todoStore.list()).slice(0, 6) : [];
    const environmentSnapshot = this.environmentMonitor ? this.environmentMonitor.getSnapshot() : null;
    const awarenessContext = this.awarenessService ? this.awarenessService.getContext() : "";
    const openTabs = this.awarenessService ? this.awarenessService.getOpenTabs() : [];
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
      currentBrowserContext: this.currentTurnContext ? this.currentTurnContext.currentBrowserContext : null,
      todayCommitments: this.currentTurnContext ? this.currentTurnContext.todayCommitments : [],
      currentTurnInference: this.currentTurnContext ? this.currentTurnContext.turnInference : null,
      currentStateSummary: stateSummary,
      awarenessContext,
      openTabs,
    });
    const selectedModel = requestedModel || settings.model || DEFAULT_MODEL;
    const anthropic = createAnthropicClient(this.stores.settingsStore);

    const allTools = [
      ...this.tools.tools,
      { type: "web_search_20250305", name: "web_search", max_uses: 5 },
    ];

    const payload = sanitizeForJson({
      model: selectedModel,
      max_tokens: 16384,
      system: systemPrompt,
      tools: allTools,
      messages: this.conversationHistory,
    });

    const controller = new AbortController();
    let aborted = false;
    if (abortSignal) {
      abortSignal.addEventListener("abort", () => {
        aborted = true;
        controller.abort();
      }, { once: true });
    }

    const stream = anthropic.messages.stream(payload, { signal: controller.signal });

    const contentBlocks = [];
    let currentText = "";
    let currentToolName = "";
    let currentToolId = "";
    let currentToolJson = "";
    let currentBlockType = null;
    let stopReason = "end_turn";
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

    for await (const event of stream) {
      if (aborted) break;

      if (event.type === "content_block_start") {
        const block = event.content_block;
        if (block.type === "text") {
          currentBlockType = "text";
          currentText = block.text || "";
        } else if (block.type === "tool_use") {
          currentBlockType = "tool_use";
          currentToolName = block.name;
          currentToolId = block.id;
          currentToolJson = "";
        } else if (block.type === "server_tool_use") {
          currentBlockType = "server_tool_use";
          currentToolName = block.name;
          currentToolId = block.id;
          currentToolJson = "";
        } else if (block.type === "web_search_tool_result") {
          currentBlockType = "web_search_result";
        }
      } else if (event.type === "content_block_delta") {
        const delta = event.delta;
        if (delta.type === "text_delta") {
          currentText += delta.text;
          textBuffer += delta.text;
          if (textBuffer.length >= 12) {
            if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
            flushText();
          } else if (!flushTimer) {
            flushTimer = setTimeout(flushText, 30);
          }
        } else if (delta.type === "input_json_delta") {
          currentToolJson += delta.partial_json;
        }
      } else if (event.type === "content_block_stop") {
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        flushText();
        if (currentBlockType === "text") {
          contentBlocks.push({ type: "text", text: currentText });
          currentText = "";
        } else if (currentBlockType === "tool_use") {
          let input = {};
          try { input = JSON.parse(currentToolJson); } catch {}
          contentBlocks.push({ type: "tool_use", id: currentToolId, name: currentToolName, input });
          currentToolName = "";
          currentToolId = "";
          currentToolJson = "";
        } else if (currentBlockType === "server_tool_use") {
          let input = {};
          try { input = JSON.parse(currentToolJson); } catch {}
          contentBlocks.push({ type: "server_tool_use", id: currentToolId, name: currentToolName, input });
          currentToolName = "";
          currentToolId = "";
          currentToolJson = "";
        } else if (currentBlockType === "web_search_result") {
          contentBlocks.push(event.content_block || { type: "web_search_tool_result" });
        }
        currentBlockType = null;
      } else if (event.type === "message_delta") {
        if (event.delta && event.delta.stop_reason) stopReason = event.delta.stop_reason;
        if (event.usage) usage = { ...usage, ...event.usage };
      } else if (event.type === "message_start" && event.message) {
        if (event.message.usage) usage = event.message.usage;
      }
    }

    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    flushText();

    if (!aborted) this.emit("event", { type: "stream_end" });

    const cleanedBlocks = contentBlocks.filter((b) =>
      b.type !== "server_tool_use" && b.type !== "web_search_tool_result"
    );

    return {
      content: cleanedBlocks.length > 0 ? cleanedBlocks : [{ type: "text", text: "" }],
      stop_reason: stopReason,
      usage: {
        input_tokens: usage.input_tokens || 0,
        output_tokens: usage.output_tokens || 0,
      },
    };
  }
}

module.exports = { ChatSession };
