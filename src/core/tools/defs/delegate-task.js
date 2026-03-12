const { BaseTool } = require("../base-tool");

const MAX_DEPTH = 2;
const MAX_CONCURRENT = 3;
const MAX_CHILD_ROUNDS = 8;
const BLOCKED_TOOLS = new Set(["delegate_task", "schedule_task"]);

let _activeDelegations = 0;

class DelegateTaskTool extends BaseTool {
  get name() { return "delegate_task"; }
  get timeout() { return 180000; }
  get description() {
    return [
      "Spawn a subagent to handle a focused task independently.",
      "The subagent gets its own conversation context and returns only a summary.",
      "Its intermediate tool calls never enter your context window.",
      "",
      "WHEN TO USE:",
      "- Reasoning-heavy subtasks (debugging, code review, research)",
      "- Tasks that would flood your context with intermediate data",
      "- Parallel independent workstreams",
      "",
      "WHEN NOT TO USE:",
      "- Single tool calls — just call the tool directly",
      "- Tasks needing user interaction",
      "",
      "The subagent has NO memory of your conversation.",
      "Pass all relevant info via the context field.",
    ].join("\n");
  }

  get input_schema() {
    return {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "What the subagent should accomplish. Be specific.",
        },
        context: {
          type: "string",
          description: "Background info: file paths, error messages, constraints.",
        },
        allowed_tools: {
          type: "array",
          items: { type: "string" },
          description: "Tool names the subagent can use. Default: all except delegate_task.",
        },
      },
      required: ["task"],
    };
  }

  async execute(input, ctx) {
    // Check depth
    const depth = (ctx._delegationDepth || 0);
    if (depth >= MAX_DEPTH) {
      return { content: `Delegation depth limit reached (${MAX_DEPTH}). Cannot spawn further subagents.`, is_error: true };
    }

    // Check concurrency
    if (_activeDelegations >= MAX_CONCURRENT) {
      return { content: `Max ${MAX_CONCURRENT} concurrent delegations. Wait for others to finish.`, is_error: true };
    }

    if (!ctx.createAnthropicClient) {
      return { content: "Delegation unavailable: no API client factory in context.", is_error: true };
    }

    const { task, context = "", allowed_tools } = input;
    const anthropic = ctx.createAnthropicClient();

    // Build child system prompt
    const systemPrompt = [
      "You are a focused subagent working on a specific delegated task.",
      `\nYOUR TASK:\n${task}`,
      context ? `\nCONTEXT:\n${context}` : "",
      "\nComplete this task using the tools available to you.",
      "When finished, provide a clear, concise summary of:",
      "- What you did",
      "- What you found or accomplished",
      "- Any files you created or modified",
      "- Any issues encountered",
      "\nBe thorough but concise.",
    ].filter(Boolean).join("\n");

    // Build restricted tool set
    const parentTools = ctx._allTools || [];
    const allowedSet = allowed_tools ? new Set(allowed_tools) : null;
    const childTools = parentTools.filter((t) => {
      const name = t.name;
      if (BLOCKED_TOOLS.has(name)) return false;
      if (allowedSet && !allowedSet.has(name)) return false;
      return true;
    });

    _activeDelegations++;
    ctx.emitCommand("delegate_task", "子任务委派", task.slice(0, 60));

    try {
      let messages = [{ role: "user", content: task }];
      let finalText = "";

      for (let round = 0; round < MAX_CHILD_ROUNDS; round++) {
        const response = await anthropic.messages.create({
          model: ctx._model || "claude-sonnet-4-20250514",
          max_tokens: 4096,
          system: systemPrompt,
          tools: childTools.length > 0 ? childTools : undefined,
          messages,
        });

        // Extract text
        const textBlocks = (response.content || []).filter((b) => b.type === "text");
        if (textBlocks.length > 0) {
          finalText = textBlocks.map((b) => b.text).join("\n");
        }

        if (response.stop_reason !== "tool_use") break;

        // Handle tool calls
        messages.push({ role: "assistant", content: response.content });
        const toolBlocks = response.content.filter((b) => b.type === "tool_use");
        const toolResults = [];

        for (const block of toolBlocks) {
          if (BLOCKED_TOOLS.has(block.name)) {
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: `Tool '${block.name}' is not available to subagents.`,
              is_error: true,
            });
            continue;
          }

          try {
            const result = await ctx._executeChildTool(block);
            toolResults.push(result);
          } catch (err) {
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: `Error: ${err.message}`,
              is_error: true,
            });
          }
        }

        messages.push({ role: "user", content: toolResults });
      }

      return finalText || "Subagent completed but produced no text output.";
    } catch (err) {
      return { content: `Delegation failed: ${err.message}`, is_error: true };
    } finally {
      _activeDelegations = Math.max(0, _activeDelegations - 1);
    }
  }
}

module.exports = DelegateTaskTool;
