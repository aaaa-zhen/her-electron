const fs = require("fs");
const path = require("path");
const { BaseTool } = require("../base-tool");
const { safePath } = require("../helpers");

class CreatePptxTool extends BaseTool {
  get name() { return "create_pptx"; }
  get timeout() { return 30000; }
  get description() { return "Create a polished PowerPoint presentation (.pptx). Supports dark/light/blue/green themes, slide layouts: title, content, two_column, quote. Body text supports bullet points (lines starting with '- '). Always generate at least 5 detailed slides with rich content."; }
  get input_schema() {
    return {
      type: "object",
      properties: {
        filename: { type: "string", description: "Output filename, e.g. 'report.pptx'" },
        title: { type: "string", description: "Presentation title" },
        subtitle: { type: "string", description: "Subtitle on cover slide" },
        theme: { type: "string", enum: ["dark", "light", "blue", "green"], description: "Color theme. Default: dark" },
        slides: {
          type: "array",
          description: "Array of slides",
          items: {
            type: "object",
            properties: {
              layout: { type: "string", enum: ["title", "content", "two_column", "quote"] },
              title: { type: "string" }, body: { type: "string" },
              left: { type: "string" }, right: { type: "string" },
              quote: { type: "string" }, author: { type: "string" }, notes: { type: "string" },
            },
          },
        },
      },
      required: ["filename", "title", "slides"],
    };
  }

  async execute(input, ctx) {
    const { filename, slides, ...rest } = input;
    const outPath = safePath(ctx.paths.sharedDir, filename);
    if (!outPath) return { content: "Invalid filename", is_error: true };
    const scriptPath = path.join(__dirname, "..", "make_pptx.py");
    const jsonData = JSON.stringify({ ...rest, slides });
    ctx.emitCommand("create_pptx", "创建 PPT", filename);
    const tmpJson = path.join(ctx.paths.sharedDir, `.tmp_pptx_${Date.now()}.json`);
    fs.writeFileSync(tmpJson, jsonData, "utf-8");
    await ctx.execAsync(`python3 "${scriptPath}" "${outPath}" < "${tmpJson}"`, { timeout: 30000, cwd: ctx.paths.sharedDir });
    fs.unlinkSync(tmpJson);
    if (fs.existsSync(outPath)) {
      ctx.emitFile(filename, outPath);
      return `PPT created: ${filename} (${slides.length} slides)`;
    }
    return { content: "Failed to create PPT", is_error: true };
  }
}

module.exports = CreatePptxTool;
