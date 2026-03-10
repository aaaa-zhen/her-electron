const fs = require("fs");
const { BaseTool } = require("../base-tool");
const { safePath, getFileType, formatSize, toFileUrl } = require("../helpers");

class SendFileTool extends BaseTool {
  get name() { return "send_file"; }
  get description() { return "Send a file to the user in chat."; }
  get input_schema() {
    return {
      type: "object",
      properties: {
        filename: { type: "string", description: "Filename in the shared directory" },
      },
      required: ["filename"],
    };
  }

  async execute(input, ctx) {
    const filename = input.filename;
    const filePath = safePath(ctx.paths.sharedDir, filename);
    if (!filePath) return { content: "Invalid filename", is_error: true };
    if (!fs.existsSync(filePath)) return { content: `"${filename}" not found.`, is_error: true };
    ctx.emitFile(filename, filePath);
    ctx.rememberTask(`task:send-file:${filename}`, `已把文件 ${filename} 发给用户。`, ["file_send"]);
    ctx.rememberArtifact(filename, `这个文件已经发给过用户：${filename}`, ["shared_file"], { kind: getFileType(filename), origin: "send_file" });
    return `File "${filename}" sent.`;
  }
}

module.exports = SendFileTool;
