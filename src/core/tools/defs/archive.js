const fs = require("fs");
const path = require("path");
const { BaseTool } = require("../base-tool");
const { safePath, getFileType, formatSize } = require("../helpers");

class ArchiveTool extends BaseTool {
  get name() { return "archive"; }
  get timeout() { return 120000; }
  get description() {
    return [
      "Compress or extract archive files. Supported operations:",
      "- compress: Create a zip archive from files (specify files array and output)",
      "- extract: Extract a zip archive (specify input and optional output directory name)",
      "- list: List contents of a zip archive",
    ].join("\n");
  }

  get input_schema() {
    return {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["compress", "extract", "list"],
          description: "Archive operation",
        },
        input: { type: "string", description: "Input archive filename (for extract, list)" },
        output: { type: "string", description: "Output filename or directory name" },
        files: { type: "array", items: { type: "string" }, description: "Files to compress (for compress)" },
      },
      required: ["operation"],
    };
  }

  async execute(input, ctx) {
    try {
      switch (input.operation) {
        case "compress": return await this._compress(input, ctx);
        case "extract": return await this._extract(input, ctx);
        case "list": return await this._list(input, ctx);
        default: return { content: `Unknown operation: ${input.operation}`, is_error: true };
      }
    } catch (err) {
      return { content: `Archive operation failed: ${err.message}`, is_error: true };
    }
  }

  async _compress(input, ctx) {
    const archiver = require("archiver");
    if (!input.files || input.files.length === 0) return { content: "files array required", is_error: true };
    if (!input.output) return { content: "output filename required", is_error: true };

    const outputPath = safePath(ctx.paths.sharedDir, input.output);
    if (!outputPath) return { content: "Invalid output path", is_error: true };

    ctx.emitCommand("archive", "压缩文件", `${input.files.length} files → ${input.output}`);

    return new Promise((resolve) => {
      const output = fs.createWriteStream(outputPath);
      const archive = archiver("zip", { zlib: { level: 9 } });

      output.on("close", () => {
        const size = formatSize(archive.pointer());
        ctx.rememberArtifact(input.output, `压缩了 ${input.files.length} 个文件`, ["archive", "zip"], { kind: "file", origin: "archive" });
        resolve(`Compressed ${input.files.length} files → ${input.output} (${size})`);
      });

      archive.on("error", (err) => resolve({ content: `Compression failed: ${err.message}`, is_error: true }));

      archive.pipe(output);

      for (const file of input.files) {
        const filePath = safePath(ctx.paths.sharedDir, file);
        if (filePath && fs.existsSync(filePath)) {
          archive.file(filePath, { name: file });
        }
      }

      archive.finalize();
    });
  }

  async _extract(input, ctx) {
    const unzipper = require("unzipper");
    if (!input.input) return { content: "input filename required", is_error: true };

    const inputPath = safePath(ctx.paths.sharedDir, input.input);
    if (!inputPath || !fs.existsSync(inputPath)) return { content: `File not found: ${input.input}`, is_error: true };

    const outDir = input.output || path.basename(input.input, path.extname(input.input));
    const outputPath = safePath(ctx.paths.sharedDir, outDir);
    if (!outputPath) return { content: "Invalid output path", is_error: true };

    if (!fs.existsSync(outputPath)) fs.mkdirSync(outputPath, { recursive: true });

    ctx.emitCommand("archive", "解压文件", `${input.input} → ${outDir}/`);

    const directory = await unzipper.Open.file(inputPath);
    let count = 0;
    for (const entry of directory.files) {
      if (entry.type === "Directory") continue;
      const entryPath = safePath(outputPath, entry.path);
      if (!entryPath) continue;
      const dir = path.dirname(entryPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const content = await entry.buffer();
      fs.writeFileSync(entryPath, content);
      count++;
    }

    ctx.rememberTask(`task:extract:${input.input}`, `解压了 ${input.input}，共 ${count} 个文件`, ["archive"]);
    return `Extracted ${count} files → ${outDir}/`;
  }

  async _list(input, ctx) {
    const unzipper = require("unzipper");
    if (!input.input) return { content: "input filename required", is_error: true };

    const inputPath = safePath(ctx.paths.sharedDir, input.input);
    if (!inputPath || !fs.existsSync(inputPath)) return { content: `File not found: ${input.input}`, is_error: true };

    const directory = await unzipper.Open.file(inputPath);
    const entries = directory.files
      .filter((e) => e.type !== "Directory")
      .map((e) => `${e.path} (${formatSize(e.uncompressedSize)})`);

    return `Archive: ${input.input}\n${entries.length} files:\n${entries.join("\n")}`;
  }
}

module.exports = ArchiveTool;
