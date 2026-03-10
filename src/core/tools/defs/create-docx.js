const fs = require("fs");
const path = require("path");
const { BaseTool } = require("../base-tool");
const { safePath } = require("../helpers");

class CreateDocxTool extends BaseTool {
  get name() { return "create_docx"; }
  get timeout() { return 30000; }
  get description() { return "Create a polished Word document (.docx). Supports themes (default/formal/modern/minimal), headings, paragraphs, bullet/numbered lists, tables, quotes, code blocks, images, and page breaks. Always generate structured, well-organized content with proper headings and sections."; }
  get input_schema() {
    return {
      type: "object",
      properties: {
        filename: { type: "string", description: "Output filename, e.g. 'report.docx'" },
        title: { type: "string", description: "Document title" },
        subtitle: { type: "string", description: "Optional subtitle" },
        theme: { type: "string", enum: ["default", "formal", "modern", "minimal"] },
        header_text: { type: "string" }, footer_text: { type: "string" },
        sections: {
          type: "array", description: "Array of document sections",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["heading", "paragraph", "bullet_list", "numbered_list", "table", "quote", "code", "page_break", "image"] },
              level: { type: "integer" }, text: { type: "string" },
              items: { type: "array", items: { type: "string" } },
              headers: { type: "array", items: { type: "string" } },
              rows: { type: "array", items: { type: "array", items: { type: "string" } } },
              language: { type: "string" }, src: { type: "string" },
              width_inches: { type: "number" }, bold: { type: "boolean" },
              italic: { type: "boolean" }, alignment: { type: "string", enum: ["left", "center", "right"] },
            },
          },
        },
      },
      required: ["filename", "title", "sections"],
    };
  }

  async execute(input, ctx) {
    const { filename, sections, ...rest } = input;
    const outPath = safePath(ctx.paths.sharedDir, filename);
    if (!outPath) return { content: "Invalid filename", is_error: true };
    const scriptPath = path.join(__dirname, "..", "make_docx.py");
    const jsonData = JSON.stringify({ ...rest, sections });
    ctx.emitCommand("create_docx", "创建 Word", filename);
    const tmpJson = path.join(ctx.paths.sharedDir, `.tmp_docx_${Date.now()}.json`);
    fs.writeFileSync(tmpJson, jsonData, "utf-8");
    await ctx.execAsync(`python3 "${scriptPath}" "${outPath}" < "${tmpJson}"`, { timeout: 30000, cwd: ctx.paths.sharedDir });
    fs.unlinkSync(tmpJson);
    if (fs.existsSync(outPath)) {
      ctx.emitFile(filename, outPath);
      return `Word document created: ${filename} (${sections.length} sections)`;
    }
    return { content: "Failed to create Word document", is_error: true };
  }
}

module.exports = CreateDocxTool;
