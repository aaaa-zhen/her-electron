const fs = require("fs");
const path = require("path");
const { BaseTool } = require("../base-tool");
const { safePath } = require("../helpers");

class CreateXlsxTool extends BaseTool {
  get name() { return "create_xlsx"; }
  get timeout() { return 30000; }
  get description() { return "Create a polished Excel spreadsheet (.xlsx). Supports themes (blue/green/dark/minimal), auto-filter, freeze panes, formulas, and charts (bar/line/pie). Multiple sheets supported."; }
  get input_schema() {
    return {
      type: "object",
      properties: {
        filename: { type: "string", description: "Output filename, e.g. 'data.xlsx'" },
        theme: { type: "string", enum: ["blue", "green", "dark", "minimal"] },
        sheets: {
          type: "array", description: "Array of sheets",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              headers: { type: "array", items: { type: "string" } },
              rows: { type: "array", items: { type: "array" } },
              column_widths: { type: "array", items: { type: "number" } },
              freeze: { type: "string" }, auto_filter: { type: "boolean" },
              formulas: { type: "object" },
              chart: {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["bar", "line", "pie"] },
                  title: { type: "string" }, position: { type: "string" },
                },
              },
            },
          },
        },
      },
      required: ["filename", "sheets"],
    };
  }

  async execute(input, ctx) {
    const { filename, sheets, ...rest } = input;
    const outPath = safePath(ctx.paths.sharedDir, filename);
    if (!outPath) return { content: "Invalid filename", is_error: true };
    const scriptPath = path.join(__dirname, "..", "make_xlsx.py");
    const jsonData = JSON.stringify({ ...rest, sheets });
    ctx.emitCommand("create_xlsx", "创建 Excel", filename);
    const tmpJson = path.join(ctx.paths.sharedDir, `.tmp_xlsx_${Date.now()}.json`);
    fs.writeFileSync(tmpJson, jsonData, "utf-8");
    await ctx.execAsync(`python3 "${scriptPath}" "${outPath}" < "${tmpJson}"`, { timeout: 30000, cwd: ctx.paths.sharedDir });
    fs.unlinkSync(tmpJson);
    if (fs.existsSync(outPath)) {
      ctx.emitFile(filename, outPath);
      return `Excel created: ${filename} (${sheets.length} sheets)`;
    }
    return { content: "Failed to create Excel", is_error: true };
  }
}

module.exports = CreateXlsxTool;
