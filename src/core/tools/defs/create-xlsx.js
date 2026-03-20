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
  get description() { return "Create a polished Excel spreadsheet (.xlsx). Supports themes (blue/green/dark/minimal), auto-filter, freeze panes, formulas (use Excel formulas like '=SUM(B2:B9)' not hardcoded values), and charts (bar/line/pie/column). Multiple sheets supported."; }
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
              formulas: { type: "object", description: "Map of cell ref to formula, e.g. {\"B10\": \"=SUM(B2:B9)\"}" },
              chart: {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["bar", "line", "pie", "column"], description: "Chart type" },
                  title: { type: "string", description: "Chart title" },
                  position: { type: "string", description: "Top-left cell for chart placement, e.g. 'E2'" },
                  data_range: { type: "string", description: "Data range for chart, e.g. 'A1:C10'. If omitted, uses all data." },
                  category_col: { type: "integer", description: "0-based column index for category labels. Default: 0" },
                  value_cols: { type: "array", items: { type: "integer" }, description: "0-based column indices for value series. Default: all numeric columns" },
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
            // Preserve formulas
            if (v.startsWith("=")) return { formula: v.slice(1) };
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

      // Auto filter — handle >26 columns correctly
      if (sd.auto_filter !== false && headers.length) {
        const lastColLetter = colIndexToLetter(headers.length - 1);
        ws.autoFilter = { from: "A1", to: `${lastColLetter}${rows.length + 1}` };
      }

      // Chart
      if (sd.chart) {
        addChart(ws, sd, theme);
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

function colIndexToLetter(index) {
  let letter = "";
  let n = index;
  while (n >= 0) {
    letter = String.fromCharCode(65 + (n % 26)) + letter;
    n = Math.floor(n / 26) - 1;
  }
  return letter;
}

function addChart(ws, sd, theme) {
  const chart = sd.chart;
  const headers = sd.headers || [];
  const rows = sd.rows || [];
  if (rows.length === 0 || headers.length < 2) return;

  const categoryCol = chart.category_col || 0;
  let valueCols = chart.value_cols;
  if (!valueCols || valueCols.length === 0) {
    // Auto-detect numeric columns
    valueCols = [];
    for (let ci = 0; ci < headers.length; ci++) {
      if (ci === categoryCol) continue;
      const hasNumeric = rows.some((r) => {
        const v = r[ci];
        return typeof v === "number" || (typeof v === "string" && !isNaN(Number(v)) && v.trim() !== "");
      });
      if (hasNumeric) valueCols.push(ci);
    }
  }
  if (valueCols.length === 0) return;

  // ExcelJS chart support
  const chartTypeMap = { bar: "bar", column: "bar", line: "line", pie: "pie" };
  const excelType = chartTypeMap[chart.type] || "bar";

  // Parse position
  const pos = chart.position || colIndexToLetter(headers.length + 1) + "2";

  const series = valueCols.map((ci) => ({
    name: headers[ci] || `Series ${ci}`,
    categories: rows.map((r) => String(r[categoryCol] || "")),
    values: rows.map((r) => {
      const v = r[ci];
      if (typeof v === "number") return v;
      if (typeof v === "string") { const n = Number(v); return isNaN(n) ? 0 : n; }
      return 0;
    }),
  }));

  try {
    ws.addChart(excelType, {
      title: chart.title || "",
      series,
      position: { from: { col: letterToColIndex(pos.replace(/[0-9]/g, "")), row: parseInt(pos.replace(/[A-Z]/gi, ""), 10) - 1 } },
      width: 600,
      height: 400,
      ...(chart.type === "column" ? { grouping: "clustered" } : {}),
      ...(chart.type === "bar" ? { grouping: "clustered", barDir: "bar" } : {}),
    });
  } catch (err) {
    // ExcelJS chart API may vary by version — log but don't fail the whole file
    console.error("[XLSX Chart] Failed to add chart:", err.message);
  }
}

function letterToColIndex(letter) {
  return letter.split("").reduce((acc, c) => acc * 26 + c.toUpperCase().charCodeAt(0) - 64, 0) - 1;
}

module.exports = CreateXlsxTool;
