const fs = require("fs");
const { BaseTool } = require("../base-tool");
const { safePath } = require("../helpers");

const THEMES = {
  blue:    { headerFill: "1E3A5F", headerFont: "FFFFFF", altFill: "EDF2F7", accent: "3B82F6", border: "CBD5E1" },
  green:   { headerFill: "065F46", headerFont: "FFFFFF", altFill: "ECFDF5", accent: "10B981", border: "A7F3D0" },
  dark:    { headerFill: "1F2937", headerFont: "F9FAFB", altFill: "F3F4F6", accent: "6EE7B7", border: "D1D5DB" },
  minimal: { headerFill: "F8FAFC", headerFont: "1E293B", altFill: "FFFFFF", accent: "64748B", border: "E2E8F0" },
};

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
    const ExcelJS = require("exceljs");
    const { filename, sheets, theme: themeName = "blue" } = input;
    const outPath = safePath(ctx.paths.sharedDir, filename);
    if (!outPath) return { content: "Invalid filename", is_error: true };

    ctx.emitCommand("create_xlsx", "创建 Excel", filename);
    const theme = THEMES[themeName] || THEMES.blue;
    const wb = new ExcelJS.Workbook();
    wb.creator = "Her";

    const thinBorder = {
      top: { style: "thin", color: { argb: `FF${theme.border}` } },
      left: { style: "thin", color: { argb: `FF${theme.border}` } },
      bottom: { style: "thin", color: { argb: `FF${theme.border}` } },
      right: { style: "thin", color: { argb: `FF${theme.border}` } },
    };

    for (let i = 0; i < sheets.length; i++) {
      const sd = sheets[i];
      const ws = wb.addWorksheet(sd.name || `Sheet${i + 1}`);
      const headers = sd.headers || [];
      const rows = sd.rows || [];

      // Headers
      if (headers.length) {
        const headerRow = ws.addRow(headers);
        headerRow.height = 30;
        headerRow.eachCell((cell) => {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${theme.headerFill}` } };
          cell.font = { name: "Arial", size: 11, bold: true, color: { argb: `FF${theme.headerFont}` } };
          cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
          cell.border = thinBorder;
        });
      }

      // Data rows
      rows.forEach((rowData, ri) => {
        const parsedRow = rowData.map((v) => {
          if (typeof v === "string") {
            const n = Number(v);
            if (!isNaN(n) && v.trim() !== "") return n;
          }
          return v;
        });
        const row = ws.addRow(parsedRow);
        row.height = 24;
        row.eachCell((cell) => {
          cell.font = { name: "Arial", size: 11, color: { argb: "FF374151" } };
          cell.alignment = { horizontal: typeof cell.value === "number" ? "center" : "left", vertical: "middle", wrapText: true };
          cell.border = thinBorder;
          if (ri % 2 === 1) {
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${theme.altFill}` } };
          }
        });
      });

      // Formulas
      if (sd.formulas) {
        for (const [ref, formula] of Object.entries(sd.formulas)) {
          const cell = ws.getCell(ref);
          cell.value = { formula: formula.replace(/^=/, "") };
          cell.font = { name: "Arial", size: 11, bold: true, color: { argb: `FF${theme.accent}` } };
          cell.alignment = { horizontal: "center", vertical: "middle" };
          cell.border = thinBorder;
        }
      }

      // Column widths
      if (sd.column_widths && sd.column_widths.length) {
        sd.column_widths.forEach((w, ci) => { ws.getColumn(ci + 1).width = w; });
      } else {
        for (let ci = 0; ci < headers.length; ci++) {
          let maxLen = headers[ci] ? headers[ci].length : 8;
          rows.forEach((r) => { if (r[ci] != null) maxLen = Math.max(maxLen, String(r[ci]).length); });
          ws.getColumn(ci + 1).width = Math.min(maxLen + 4, 40);
        }
      }

      // Freeze
      const freeze = sd.freeze || (headers.length ? "A2" : null);
      if (freeze) {
        const col = freeze.replace(/[0-9]/g, "");
        const row = parseInt(freeze.replace(/[A-Z]/gi, ""), 10);
        const colNum = col.split("").reduce((acc, c) => acc * 26 + c.toUpperCase().charCodeAt(0) - 64, 0);
        ws.views = [{ state: "frozen", xSplit: colNum - 1, ySplit: row - 1 }];
      }

      // Auto filter
      if (sd.auto_filter !== false && headers.length) {
        ws.autoFilter = { from: "A1", to: `${String.fromCharCode(64 + headers.length)}${rows.length + 1}` };
      }
    }

    await wb.xlsx.writeFile(outPath);
    if (fs.existsSync(outPath)) {
      ctx.emitFile(filename, outPath);
      return `Excel created: ${filename} (${sheets.length} sheets)`;
    }
    return { content: "Failed to create Excel", is_error: true };
  }
}

module.exports = CreateXlsxTool;
