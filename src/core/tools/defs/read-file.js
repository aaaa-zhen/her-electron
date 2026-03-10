const fs = require("fs");
const path = require("path");
const { BaseTool } = require("../base-tool");

class ReadFileTool extends BaseTool {
  get name() { return "read_file"; }
  get description() { return "Read file contents with line numbers."; }
  get input_schema() {
    return {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute file path" },
        offset: { type: "number", description: "Start line (1-based). Default: 1" },
        limit: { type: "number", description: "Max lines. Default: 500" },
      },
      required: ["path"],
    };
  }

  async execute(input, ctx) {
    const filePath = input.path;
    ctx.emitCommand(`read_file: ${filePath}`, "查看文件", path.basename(filePath) || filePath);
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const start = Math.max(0, (input.offset || 1) - 1);
    const end = Math.min(lines.length, start + (input.limit || 500));
    const numbered = lines.slice(start, end).map((line, index) => `${String(start + index + 1).padStart(6)}|${line}`).join("\n");
    if (numbered.trim()) ctx.emit({ type: "command_output", output: numbered.slice(0, 5000) });
    return `Lines ${start + 1}-${end} of ${lines.length}\n${numbered.slice(0, 15000)}`;
  }
}

module.exports = ReadFileTool;
