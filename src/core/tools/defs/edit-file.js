const fs = require("fs");
const path = require("path");
const { BaseTool } = require("../base-tool");

class EditFileTool extends BaseTool {
  get name() { return "edit_file"; }
  get description() { return "Edit a file by replacing exact string matches. Always read_file first."; }
  get input_schema() {
    return {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute file path" },
        old_string: { type: "string", description: "Exact string to find (must be unique)" },
        new_string: { type: "string", description: "Replacement string" },
      },
      required: ["path", "old_string", "new_string"],
    };
  }

  async execute(input, ctx) {
    const filePath = input.path;
    ctx.emitCommand(`edit_file: ${filePath}`, "修改文件", path.basename(filePath) || filePath);
    const content = fs.readFileSync(filePath, "utf-8");
    const count = content.split(input.old_string).length - 1;
    if (count === 0) return { content: "old_string not found. Read file first.", is_error: true };
    if (count > 1) return { content: `old_string found ${count} times — must be unique.`, is_error: true };
    fs.writeFileSync(filePath, content.replace(input.old_string, input.new_string), "utf-8");
    ctx.emit({ type: "command_output", output: `Edit applied to ${filePath}` });
    return `Edit applied to ${filePath}`;
  }
}

module.exports = EditFileTool;
