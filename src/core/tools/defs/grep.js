const os = require("os");
const { BaseTool } = require("../base-tool");

class GrepTool extends BaseTool {
  get name() { return "grep"; }
  get description() { return "Search file contents using regex. Returns matching lines with file paths and line numbers."; }
  get input_schema() {
    return {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern" },
        path: { type: "string", description: "File or directory to search" },
        include: { type: "string", description: "File filter, e.g. '*.js'" },
      },
      required: ["pattern"],
    };
  }

  async execute(input, ctx) {
    const dir = input.path || os.homedir();
    const includeFlag = input.include ? `--include="${input.include}"` : "";
    ctx.emitCommand(`grep: "${input.pattern}" in ${dir}`, "搜索内容", input.pattern);
    const command = `grep -rn ${includeFlag} "${input.pattern}" "${dir}" 2>/dev/null | head -200`;
    const output = await ctx.execAsync(command, { cwd: ctx.paths.sharedDir });
    const result = output.trim() || "No matches found.";
    ctx.emit({ type: "command_output", output: result.slice(0, 5000) });
    return result.slice(0, 10000);
  }
}

module.exports = GrepTool;
