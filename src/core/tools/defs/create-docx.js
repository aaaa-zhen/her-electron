const fs = require("fs");
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
    const docx = require("docx");
    const { filename, sections, title, subtitle, theme: themeName = "default", header_text, footer_text } = input;
    const outPath = safePath(ctx.paths.sharedDir, filename);
    if (!outPath) return { content: "Invalid filename", is_error: true };

    ctx.emitCommand("create_docx", "创建 Word", filename);

    const THEMES = {
      default: { title: "1A1A2E", heading: "1A1A2E", body: "333333", accent: "10B981", tableHeader: "10B981", font: "Helvetica Neue" },
      formal:  { title: "1A1A1A", heading: "1A1A1A", body: "333333", accent: "2C3E50", tableHeader: "2C3E50", font: "Times New Roman" },
      modern:  { title: "0F172A", heading: "0F172A", body: "374151", accent: "60A5FA", tableHeader: "1E293B", font: "Helvetica Neue" },
      minimal: { title: "111111", heading: "111111", body: "444444", accent: "555555", tableHeader: "333333", font: "Helvetica Neue" },
    };
    const theme = THEMES[themeName] || THEMES.default;

    const children = [];

    // Title
    if (title) {
      children.push(new docx.Paragraph({
        alignment: docx.AlignmentType.CENTER,
        spacing: { after: 80 },
        children: [new docx.TextRun({ text: title, bold: true, size: 52, font: theme.font, color: theme.title })],
      }));
    }

    // Subtitle
    if (subtitle) {
      children.push(new docx.Paragraph({
        alignment: docx.AlignmentType.CENTER,
        spacing: { after: 400 },
        children: [new docx.TextRun({ text: subtitle, italics: true, size: 28, font: theme.font, color: "888888" })],
      }));
    }

    // Sections
    for (const sec of sections) {
      const t = sec.type || "paragraph";

      if (t === "heading") {
        const level = Math.min(sec.level || 1, 3);
        const sizes = { 1: 44, 2: 32, 3: 26 };
        children.push(new docx.Paragraph({
          spacing: { before: level === 1 ? 360 : 240, after: 160 },
          children: [new docx.TextRun({
            text: sec.text || "", bold: true, size: sizes[level],
            font: theme.font, color: theme.heading,
          })],
        }));
      } else if (t === "paragraph") {
        const lines = (sec.text || "").split("\n").filter((l) => l.trim());
        const align = sec.alignment === "center" ? docx.AlignmentType.CENTER
          : sec.alignment === "right" ? docx.AlignmentType.RIGHT : docx.AlignmentType.LEFT;
        for (const line of lines) {
          children.push(new docx.Paragraph({
            alignment: align,
            spacing: { after: 120, line: 400 },
            children: [new docx.TextRun({
              text: line, size: 22, font: theme.font, color: theme.body,
              bold: sec.bold || false, italics: sec.italic || false,
            })],
          }));
        }
      } else if (t === "bullet_list") {
        for (const item of (sec.items || [])) {
          children.push(new docx.Paragraph({
            bullet: { level: 0 },
            spacing: { after: 60, line: 400 },
            children: [new docx.TextRun({ text: String(item), size: 22, font: theme.font, color: theme.body })],
          }));
        }
      } else if (t === "numbered_list") {
        for (const item of (sec.items || [])) {
          children.push(new docx.Paragraph({
            numbering: { reference: "default-numbering", level: 0 },
            spacing: { after: 60, line: 400 },
            children: [new docx.TextRun({ text: String(item), size: 22, font: theme.font, color: theme.body })],
          }));
        }
      } else if (t === "table") {
        const headers = sec.headers || [];
        const rows = sec.rows || [];
        const tableRows = [];
        if (headers.length) {
          tableRows.push(new docx.TableRow({
            tableHeader: true,
            children: headers.map((h) => new docx.TableCell({
              shading: { fill: theme.tableHeader },
              children: [new docx.Paragraph({
                alignment: docx.AlignmentType.CENTER,
                children: [new docx.TextRun({ text: String(h), bold: true, size: 20, font: theme.font, color: "FFFFFF" })],
              })],
              verticalAlign: docx.VerticalAlign.CENTER,
            })),
          }));
        }
        for (let ri = 0; ri < rows.length; ri++) {
          const colCount = headers.length || (rows[0] || []).length;
          tableRows.push(new docx.TableRow({
            children: Array.from({ length: colCount }, (_, ci) => new docx.TableCell({
              shading: ri % 2 === 1 ? { fill: "F5F5F5" } : undefined,
              children: [new docx.Paragraph({
                children: [new docx.TextRun({ text: String((rows[ri] || [])[ci] || ""), size: 20, font: theme.font, color: theme.body })],
              })],
              verticalAlign: docx.VerticalAlign.CENTER,
            })),
          }));
        }
        if (tableRows.length) {
          children.push(new docx.Table({
            rows: tableRows,
            width: { size: 100, type: docx.WidthType.PERCENTAGE },
          }));
          children.push(new docx.Paragraph({ spacing: { after: 200 }, children: [] }));
        }
      } else if (t === "quote") {
        children.push(new docx.Paragraph({
          indent: { left: 600 },
          spacing: { before: 160, after: 160, line: 400 },
          border: { left: { style: docx.BorderStyle.SINGLE, size: 6, space: 8, color: theme.accent } },
          children: [new docx.TextRun({ text: sec.text || "", italics: true, size: 22, font: theme.font, color: theme.body })],
        }));
      } else if (t === "code") {
        children.push(new docx.Paragraph({
          indent: { left: 200, right: 200 },
          spacing: { before: 160, after: 160 },
          shading: { fill: "F5F5F5" },
          children: [new docx.TextRun({ text: sec.text || "", size: 19, font: "Menlo", color: "333333" })],
        }));
      } else if (t === "page_break") {
        children.push(new docx.Paragraph({ children: [new docx.PageBreak()] }));
      } else if (t === "image") {
        const imgPath = sec.src || "";
        if (fs.existsSync(imgPath)) {
          const imgData = fs.readFileSync(imgPath);
          const widthPx = Math.round((sec.width_inches || 5) * 96);
          children.push(new docx.Paragraph({
            alignment: docx.AlignmentType.CENTER,
            children: [new docx.ImageRun({
              data: imgData, transformation: { width: widthPx, height: Math.round(widthPx * 0.75) },
              type: imgPath.endsWith(".png") ? "png" : "jpg",
            })],
          }));
        } else {
          children.push(new docx.Paragraph({
            children: [new docx.TextRun({ text: `[Image not found: ${imgPath}]`, size: 22, color: "999999" })],
          }));
        }
      }
    }

    const docSections = [{
      properties: {
        page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } },
      },
      headers: header_text ? {
        default: new docx.Header({
          children: [new docx.Paragraph({
            alignment: docx.AlignmentType.RIGHT,
            children: [new docx.TextRun({ text: header_text, size: 16, font: theme.font, color: "999999" })],
          })],
        }),
      } : undefined,
      footers: footer_text ? {
        default: new docx.Footer({
          children: [new docx.Paragraph({
            alignment: docx.AlignmentType.CENTER,
            children: [new docx.TextRun({ text: footer_text, size: 16, font: theme.font, color: "999999" })],
          })],
        }),
      } : undefined,
      children,
    }];

    const numbering = {
      config: [{
        reference: "default-numbering",
        levels: [{
          level: 0, format: docx.LevelFormat.DECIMAL,
          text: "%1.", alignment: docx.AlignmentType.START,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } },
        }],
      }],
    };

    const doc = new docx.Document({ sections: docSections, numbering });
    const buffer = await docx.Packer.toBuffer(doc);
    fs.writeFileSync(outPath, buffer);

    if (fs.existsSync(outPath)) {
      ctx.emitFile(filename, outPath);
      return `Word document created: ${filename} (${sections.length} sections)`;
    }
    return { content: "Failed to create Word document", is_error: true };
  }
}

module.exports = CreateDocxTool;
