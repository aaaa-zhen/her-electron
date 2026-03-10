const fs = require("fs");
const path = require("path");
const { BaseTool } = require("../base-tool");

class WriteFileTool extends BaseTool {
  get name() { return "write_file"; }
  get description() { return "Create or overwrite a file."; }
  get input_schema() {
    return {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute file path" },
        content: { type: "string", description: "File content" },
      },
      required: ["path", "content"],
    };
  }

  async execute(input, ctx) {
    const filePath = input.path;
    ctx.emitCommand(`write_file: ${filePath}`, "写入文件", path.basename(filePath) || filePath);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, input.content, "utf-8");
    const result = `Written: ${filePath} (${input.content.split("\n").length} lines)`;
    ctx.emit({ type: "command_output", output: result });
    return result;
  }
}

module.exports = WriteFileTool;
