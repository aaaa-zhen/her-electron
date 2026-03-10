const os = require("os");
const { BaseTool } = require("../base-tool");

class GlobTool extends BaseTool {
  get name() { return "glob"; }
  get description() { return "Find files matching a glob pattern."; }
  get input_schema() {
    return {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern, e.g. '**/*.js'" },
        path: { type: "string", description: "Base directory. Default: home dir" },
      },
      required: ["pattern"],
    };
  }

  async execute(input, ctx) {
    const searchDir = input.path || os.homedir();
    const namePattern = input.pattern.includes("/") ? input.pattern.split("/").pop() : input.pattern;
    ctx.emitCommand(`glob: ${input.pattern} in ${searchDir}`, "搜索文件", input.pattern);
    const command = `find "${searchDir}" -name "${namePattern}" -type f 2>/dev/null | head -100`;
    const output = await ctx.execAsync(command, { cwd: ctx.paths.sharedDir });
    const result = output.trim() || "No files found.";
    ctx.emit({ type: "command_output", output: result.slice(0, 5000) });
    return result.slice(0, 10000);
  }
}

module.exports = GlobTool;
