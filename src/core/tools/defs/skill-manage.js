const { BaseTool } = require("../base-tool");

class SkillManageTool extends BaseTool {
  get name() { return "skill_manage"; }
  get timeout() { return 10000; }
  get description() {
    return [
      "Manage reusable skills (procedural memory). Skills capture proven approaches for recurring tasks.",
      "Actions:",
      "- create: Create a new skill (provide id, title, tags, content)",
      "- update: Update an existing skill",
      "- delete: Delete a skill by id",
      "- list: List all saved skills",
      "- search: Search skills by keyword",
      "",
      "Create skills when:",
      "- A complex task succeeded (5+ tool calls)",
      "- You discovered a non-obvious workflow",
      "- The user corrected your approach and the fix worked",
      "- The user asks you to remember a procedure",
      "",
      "Good skills have: trigger conditions, numbered steps, pitfalls section, verification steps.",
    ].join("\n");
  }

  get input_schema() {
    return {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "update", "delete", "list", "search"],
          description: "The action to perform",
        },
        id: {
          type: "string",
          description: "Skill identifier (lowercase, hyphens, max 64 chars). Required for create/update/delete.",
        },
        title: {
          type: "string",
          description: "Human-readable skill title. Required for create/update.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags for categorization and retrieval",
        },
        content: {
          type: "string",
          description: "The skill procedure in markdown. Required for create/update.",
        },
        query: {
          type: "string",
          description: "Search query. Required for search action.",
        },
      },
      required: ["action"],
    };
  }

  async execute(input, ctx) {
    const skillStore = ctx.stores.skillStore;
    if (!skillStore) return { content: "Skill store not available.", is_error: true };

    const { action } = input;

    if (action === "list") {
      const skills = skillStore.list();
      if (skills.length === 0) return "No skills saved yet.";
      return skills.map((s) => `- ${s.id}: ${s.title} [${(s.tags || []).join(", ")}]`).join("\n");
    }

    if (action === "search") {
      if (!input.query) return { content: "query is required for search.", is_error: true };
      const results = skillStore.search(input.query);
      if (results.length === 0) return "No matching skills found.";
      return results.map((s) => `- ${s.id}: ${s.title}\n  ${s.content.slice(0, 100)}...`).join("\n\n");
    }

    if (action === "create" || action === "update") {
      if (!input.id) return { content: "id is required.", is_error: true };
      if (!input.title) return { content: "title is required.", is_error: true };
      if (!input.content) return { content: "content is required.", is_error: true };

      const result = skillStore.save(input.id, {
        title: input.title,
        tags: input.tags || [],
        content: input.content,
      });
      return result.success ? result.message : { content: result.error, is_error: true };
    }

    if (action === "delete") {
      if (!input.id) return { content: "id is required.", is_error: true };
      const result = skillStore.delete(input.id);
      return result.success ? result.message : { content: result.error, is_error: true };
    }

    return { content: `Unknown action: ${action}`, is_error: true };
  }
}

module.exports = SkillManageTool;
