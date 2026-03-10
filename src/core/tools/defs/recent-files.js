const { BaseTool } = require("../base-tool");

class RecentFilesTool extends BaseTool {
  get name() { return "recent_files"; }
  get description() { return "List recently modified files on this Mac. Shows what the user has been working on."; }
  get input_schema() {
    return {
      type: "object",
      properties: {
        days: { type: "number", description: "How many days back to look (default: 1)" },
        limit: { type: "number", description: "Max files to return (default: 20)" },
        folder: { type: "string", description: "Specific folder to search in (default: home directory)" },
      },
    };
  }

  async execute(input, ctx) {
    const days = Math.min(input.days || 1, 7);
    const limit = Math.min(input.limit || 20, 50);
    const folder = input.folder || process.env.HOME || "/Users";
    ctx.emitCommand("recent_files", "查看最近文件", `${days}天内`);
    const cmd = `mdfind 'kMDItemFSContentChangeDate >= $time.today(-${days})' -onlyin "${folder}" 2>/dev/null | grep -v '/Library/' | grep -v '/\\.' | grep -v 'node_modules' | grep -v '__pycache__' | head -${limit}`;
    const raw = await ctx.execAsync(cmd, { timeout: 10000 });
    const files = raw.trim().split("\n").filter(Boolean);
    if (files.length === 0) return "No recently modified files found.";
    return `Recently modified files (last ${days} day${days > 1 ? "s" : ""}):\n${files.join("\n")}`;
  }
}

module.exports = RecentFilesTool;
