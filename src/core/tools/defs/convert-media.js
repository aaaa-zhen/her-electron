const fs = require("fs");
const path = require("path");
const { BaseTool } = require("../base-tool");
const { safePath, getFileType } = require("../helpers");

class ConvertMediaTool extends BaseTool {
  get name() { return "convert_media"; }
  get timeout() { return 600000; }
  get description() { return "Convert or process media files using ffmpeg."; }
  get input_schema() {
    return {
      type: "object",
      properties: {
        input: { type: "string", description: "Input filename (in shared directory)" },
        output: { type: "string", description: "Output filename" },
        options: { type: "string", description: "ffmpeg options between input and output" },
      },
      required: ["input", "output"],
    };
  }

  async execute(input, ctx) {
    const { input: inputFile, output: outputFile, options = "" } = input;
    const inputPath = safePath(ctx.paths.sharedDir, inputFile);
    const outputPath = safePath(ctx.paths.sharedDir, outputFile);
    if (!inputPath || !outputPath) return { content: "Invalid file path", is_error: true };
    if (!fs.existsSync(inputPath)) return { content: "Input file not found", is_error: true };

    const command = `ffmpeg -y -i "${inputPath}" ${options} "${outputPath}"`;
    ctx.emitCommand(command, "处理媒体", `${inputFile} -> ${outputFile}`);
    const promise = ctx.execAsync(command, { timeout: 600000, cwd: ctx.paths.sharedDir });
    if (promise.child) ctx.activeProcesses.push(promise.child);
    const output = await promise;
    if (promise.child) ctx.activeProcesses.splice(ctx.activeProcesses.indexOf(promise.child), 1);

    if (fs.existsSync(outputPath)) {
      ctx.emitFile(outputFile, outputPath);
      ctx.rememberTask(`task:convert-media:${outputFile}`, `已把媒体文件 ${inputFile} 转换为 ${outputFile}。`, ["media", "convert"]);
      ctx.rememberArtifact(outputFile, `这是我处理后生成的媒体文件 ${outputFile}，由 ${inputFile} 转换而来。`, ["media", "convert"], { kind: getFileType(outputFile), origin: "convert_media", sourceFile: inputFile });
      return `Converted: ${outputFile}`;
    }
    return `ffmpeg output:\n${output.slice(0, 3000)}`;
  }
}

module.exports = ConvertMediaTool;
