const { BaseTool } = require("../base-tool");

class BashTool extends BaseTool {
  get name() { return "bash"; }
  get timeout() { return 120000; }
  get description() { return `Execute a bash command on this computer. Working directory: {{sharedDir}}`; }
  get input_schema() {
    return {
      type: "object",
      properties: {
        command: { type: "string", description: "The bash command to execute" },
        cwd: { type: "string", description: "Working directory for the command" },
      },
      required: ["command"],
    };
  }

  definition(ctx) {
    const def = super.definition();
    const sharedDir = ctx && ctx.paths ? ctx.paths.sharedDir : "~/shared";
    def.description = def.description.replace("{{sharedDir}}", sharedDir);
    return def;
  }

  async execute(input, ctx) {
    ctx.emitCommand(input.command, ctx.describeShellCommand(input.command), input.command);
    const promise = ctx.execAsync(input.command, { cwd: input.cwd || ctx.paths.sharedDir });
    if (promise.child) ctx.activeProcesses.push(promise.child);
    const output = await promise;
    if (promise.child) ctx.activeProcesses.splice(ctx.activeProcesses.indexOf(promise.child), 1);
    if (output.trim()) ctx.emit({ type: "command_output", output: output.slice(0, 5000) });
    ctx.rememberShellTask(input.command, output);
    return output.slice(0, 10000);
  }
}

module.exports = BashTool;
