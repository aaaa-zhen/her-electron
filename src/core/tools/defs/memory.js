const { BaseTool } = require("../base-tool");

class MemoryTool extends BaseTool {
  get name() { return "memory"; }
  get description() { return "Save, delete, list, or search long-term memories."; }
  get input_schema() {
    return {
      type: "object",
      properties: {
        action: { type: "string", enum: ["save", "delete", "list", "search"] },
        key: { type: "string", description: "Memory key" },
        value: { type: "string", description: "Value to remember (for save)" },
        query: { type: "string", description: "Search keyword (for search)" },
      },
      required: ["action"],
    };
  }

  async execute(input, ctx) {
    const { action, key, value, query } = input;
    const memoryStore = ctx.stores.memoryStore;

    if (action === "save" && key && value) {
      memoryStore.saveEntry(key, value);
      ctx.emit({ type: "memory_saved", key, value });
      return `Memory saved: ${key} = ${value}`;
    }
    if (action === "delete" && key) {
      const before = memoryStore.list().length;
      memoryStore.deleteEntry(key);
      const after = memoryStore.list().length;
      return after < before ? `Deleted: ${key}` : `"${key}" not found.`;
    }
    if (action === "list") {
      const memories = memoryStore.list();
      if (memories.length === 0) return "No memories.";
      return memories
        .sort((a, b) => new Date(b.updated || b.saved || 0) - new Date(a.updated || a.saved || 0))
        .map((m) => `[${(m.tags || []).join(",")}] ${m.key}: ${m.value}`)
        .join("\n");
    }
    if (action === "search" && (query || key)) {
      const found = memoryStore.search(query || key);
      if (found.length === 0) return `No memories matching "${query || key}".`;
      return found.map((m) => `[${(m.tags || []).join(",")}] ${m.key}: ${m.value}`).join("\n");
    }
    return { content: "Invalid action. Use: save, delete, list, search.", is_error: true };
  }
}

module.exports = MemoryTool;
