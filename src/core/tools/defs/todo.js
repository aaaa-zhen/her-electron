const { BaseTool } = require("../base-tool");

class TodoTool extends BaseTool {
  get name() { return "todo"; }
  get description() {
    return "Manage user's todo/task list shown on the home screen. PROACTIVELY add items whenever the user mentions ANY plan, intention, or commitment — even casual ones like '上完课去睡觉', '下午要开会', '晚上想跑步'. Don't wait for the user to ask you to add it. If the user says they plan to do something, add it immediately as a todo so it shows on their home screen. IMPORTANT: Always convert relative dates (e.g. '明天', 'next Monday', '上完课后') to absolute ISO 8601 timestamps based on the current time. Set expires_at to a reasonable time after the event ends (usually event time + 1 hour) so expired items auto-hide.";
  }
  get input_schema() {
    return {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "complete", "remove", "list"], description: "Action to perform" },
        title: { type: "string", description: "Todo title (for add/complete/remove)" },
        detail: { type: "string", description: "Extra detail (for add)" },
        due_date: { type: "string", description: "ISO 8601 absolute timestamp for when this is due, e.g. '2026-03-08T06:00:00+08:00'. MUST be absolute, never relative like '明天'. (for add)" },
        expires_at: { type: "string", description: "ISO 8601 absolute timestamp for when this todo should auto-hide, e.g. '2026-03-08T07:00:00+08:00'. Usually due_date + 1 hour. (for add)" },
      },
      required: ["action"],
    };
  }

  async execute(input, ctx) {
    const { action, title, detail, due_date, expires_at } = input;
    const todoStore = ctx.stores.todoStore;

    if (action === "add" && title) {
      todoStore.add(title, detail || "", due_date || "", expires_at || "");
      ctx.emit({ type: "todo_updated" });
      return `Todo added: "${title}"${due_date ? ` (${due_date})` : ""}`;
    }
    if (action === "complete" && title) {
      const item = todoStore.complete(title);
      if (!item) return { content: `Todo "${title}" not found.`, is_error: true };
      ctx.emit({ type: "todo_updated" });
      return `Todo "${item.title}" completed.`;
    }
    if (action === "remove" && title) {
      const item = todoStore.remove(title);
      if (!item) return { content: `Todo "${title}" not found.`, is_error: true };
      ctx.emit({ type: "todo_updated" });
      return `Todo "${item.title}" removed.`;
    }
    if (action === "list") {
      const todos = todoStore.list();
      if (todos.length === 0) return "No pending todos.";
      return todos.map((t, i) => `${i + 1}. ${t.title}${t.dueDate ? ` (${t.dueDate})` : ""}${t.detail ? ` — ${t.detail}` : ""}`).join("\n");
    }
    return { content: "Missing title.", is_error: true };
  }
}

module.exports = TodoTool;
