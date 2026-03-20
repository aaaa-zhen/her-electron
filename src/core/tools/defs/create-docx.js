const fs = require("fs");
const { BaseTool } = require("../base-tool");
const { safePath } = require("../helpers");

class CreateDocxTool extends BaseTool {
  get name() { return "create_docx"; }
  get timeout() { return 30000; }
  get description() { return "Create a polished Word document (.docx). Supports themes (default/formal/modern/minimal), real heading styles (TOC-compatible), paragraphs, bullet/numbered lists, tables, quotes, code blocks, images, hyperlinks, and page breaks. Always generate structured, well-organized content with proper headings and sections."; }
  get input_schema() {
    return {
      type: "object",
      properties: {
        filename: { type: "string", description: "Output filename, e.g. 'report.docx'" },
        title: { type: "string", description: "Document title" },
        subtitle: { type: "string", description: "Optional subtitle" },
        theme: { type: "string", enum: ["default", "formal", "modern", "minimal"] },
        toc: { type: "boolean", description: "Include table of contents. Default: false" },
        header_text: { type: "string" }, footer_text: { type: "string" },
        page_numbers: { type: "boolean", description: "Show page numbers in footer. Default: false" },
        sections: {
          type: "array", description: "Array of document sections",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["heading", "paragraph", "bullet_list", "numbered_list", "table", "quote", "code", "page_break", "image", "hyperlink"] },
              level: { type: "integer", description: "Heading level 1-3" },
              text: { type: "string" },
              items: { type: "array", items: { type: "string" } },
              headers: { type: "array", items: { type: "string" } },
              rows: { type: "array", items: { type: "array", items: { type: "string" } } },
              language: { type: "string" }, src: { type: "string" },
              url: { type: "string", description: "URL for hyperlink type" },
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
    const { filename, sections, title, subtitle, theme: themeName = "default", toc = false, header_text, footer_text, page_numbers = false } = input;
    const outPath = safePath(ctx.paths.sharedDir, filename);
    if (!outPath) return { content: "Invalid filename", is_error: true };

    ctx.emitCommand("create_docx", "创建 Word", filename);

    const THEMES = {
      default: { title: "1A1A2E", heading: "1A1A2E", body: "333333", accent: "10B981", tableHeader: "10B981", font: "Arial" },
      formal:  { title: "1A1A1A", heading: "1A1A1A", body: "333333", accent: "2C3E50", tableHeader: "2C3E50", font: "Times New Roman" },
      modern:  { title: "0F172A", heading: "0F172A", body: "374151", accent: "60A5FA", tableHeader: "1E293B", font: "Arial" },
      minimal: { title: "111111", heading: "111111", body: "444444", accent: "555555", tableHeader: "333333", font: "Arial" },
    };
    const theme = THEMES[themeName] || THEMES.default;

    // Real heading styles with outlineLevel for TOC support
    const styles = {
      default: { document: { run: { font: theme.font, size: 22 } } },
      paragraphStyles: [
        {
          id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
          run: { size: 36, bold: true, font: theme.font, color: theme.heading },
          paragraph: { spacing: { before: 360, after: 200 }, outlineLevel: 0 },
        },
        {
          id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
          run: { size: 30, bold: true, font: theme.font, color: theme.heading },
          paragraph: { spacing: { before: 280, after: 160 }, outlineLevel: 1 },
        },
        {
          id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
          run: { size: 26, bold: true, font: theme.font, color: theme.heading },
          paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 2 },
        },
      ],
    };

    const numbering = {
      config: [
        {
          reference: "bullets",
          levels: [{
            level: 0, format: docx.LevelFormat.BULLET, text: "\u2022",
            alignment: docx.AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720, hanging: 360 } } },
          }],
        },
        {
          reference: "numbers",
          levels: [{
            level: 0, format: docx.LevelFormat.DECIMAL, text: "%1.",
            alignment: docx.AlignmentType.START,
            style: { paragraph: { indent: { left: 720, hanging: 360 } } },
          }],
        },
      ],
    };

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

    // Table of Contents
    if (toc) {
      children.push(new docx.TableOfContents("目录", {
        hyperlink: true,
        headingStyleRange: "1-3",
      }));
      children.push(new docx.Paragraph({ children: [new docx.PageBreak()] }));
    }

    // Content width in DXA: US Letter (12240) - 1" margins (2 * 1440) = 9360
    const CONTENT_WIDTH = 9360;
    const border = { style: docx.BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
    const cellBorders = { top: border, bottom: border, left: border, right: border };

    // Sections
    for (const sec of sections) {
      const t = sec.type || "paragraph";

      if (t === "heading") {
        const level = Math.min(sec.level || 1, 3);
        const headingMap = { 1: docx.HeadingLevel.HEADING_1, 2: docx.HeadingLevel.HEADING_2, 3: docx.HeadingLevel.HEADING_3 };
        children.push(new docx.Paragraph({
          heading: headingMap[level],
          children: [new docx.TextRun({ text: sec.text || "" })],
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
            numbering: { reference: "bullets", level: 0 },
            spacing: { after: 60, line: 400 },
            children: [new docx.TextRun({ text: String(item), size: 22, font: theme.font, color: theme.body })],
          }));
        }
      } else if (t === "numbered_list") {
        for (const item of (sec.items || [])) {
          children.push(new docx.Paragraph({
            numbering: { reference: "numbers", level: 0 },
            spacing: { after: 60, line: 400 },
            children: [new docx.TextRun({ text: String(item), size: 22, font: theme.font, color: theme.body })],
          }));
        }
      } else if (t === "table") {
        const headers = sec.headers || [];
        const rows = sec.rows || [];
        const colCount = headers.length || (rows[0] || []).length || 1;
        const colWidth = Math.floor(CONTENT_WIDTH / colCount);
        const columnWidths = Array(colCount).fill(colWidth);
        const tableRows = [];
        if (headers.length) {
          tableRows.push(new docx.TableRow({
            tableHeader: true,
            children: headers.map((h) => new docx.TableCell({
              borders: cellBorders,
              width: { size: colWidth, type: docx.WidthType.DXA },
              shading: { fill: theme.tableHeader, type: docx.ShadingType.CLEAR },
              margins: { top: 80, bottom: 80, left: 120, right: 120 },
              children: [new docx.Paragraph({
                alignment: docx.AlignmentType.CENTER,
                children: [new docx.TextRun({ text: String(h), bold: true, size: 20, font: theme.font, color: "FFFFFF" })],
              })],
              verticalAlign: docx.VerticalAlign.CENTER,
            })),
          }));
        }
        for (let ri = 0; ri < rows.length; ri++) {
          tableRows.push(new docx.TableRow({
            children: Array.from({ length: colCount }, (_, ci) => new docx.TableCell({
              borders: cellBorders,
              width: { size: colWidth, type: docx.WidthType.DXA },
              shading: ri % 2 === 1 ? { fill: "F5F5F5", type: docx.ShadingType.CLEAR } : undefined,
              margins: { top: 60, bottom: 60, left: 120, right: 120 },
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
            width: { size: CONTENT_WIDTH, type: docx.WidthType.DXA },
            columnWidths,
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
        const codeLines = (sec.text || "").split("\n");
        const codeRuns = [];
        codeLines.forEach((line, i) => {
          if (i > 0) codeRuns.push(new docx.TextRun({ break: 1 }));
          codeRuns.push(new docx.TextRun({ text: line, size: 19, font: "Courier New", color: "333333" }));
        });
        children.push(new docx.Paragraph({
          indent: { left: 200, right: 200 },
          spacing: { before: 160, after: 160 },
          shading: { fill: "F5F5F5", type: docx.ShadingType.CLEAR },
          children: codeRuns,
        }));
      } else if (t === "page_break") {
        children.push(new docx.Paragraph({ children: [new docx.PageBreak()] }));
      } else if (t === "hyperlink") {
        children.push(new docx.Paragraph({
          children: [new docx.ExternalHyperlink({
            children: [new docx.TextRun({ text: sec.text || sec.url || "", style: "Hyperlink" })],
            link: sec.url || "",
          })],
        }));
      } else if (t === "image") {
        const imgPath = safePath(ctx.paths.sharedDir, sec.src || "") || (sec.src || "");
        if (fs.existsSync(imgPath)) {
          const imgData = fs.readFileSync(imgPath);
          const widthPx = Math.round((sec.width_inches || 5) * 96);
          const ext = imgPath.toLowerCase();
          children.push(new docx.Paragraph({
            alignment: docx.AlignmentType.CENTER,
            children: [new docx.ImageRun({
              data: imgData,
              transformation: { width: widthPx, height: Math.round(widthPx * 0.75) },
              type: ext.endsWith(".png") ? "png" : ext.endsWith(".gif") ? "gif" : "jpg",
            })],
          }));
        } else {
          children.push(new docx.Paragraph({
            children: [new docx.TextRun({ text: `[Image not found: ${sec.src}]`, size: 22, color: "999999" })],
          }));
        }
      }
    }

    // Footer with optional page numbers
    let footerChildren;
    if (footer_text && page_numbers) {
      footerChildren = [new docx.Paragraph({
        alignment: docx.AlignmentType.CENTER,
        children: [
          new docx.TextRun({ text: footer_text + "  —  ", size: 16, font: theme.font, color: "999999" }),
          new docx.TextRun({ children: [docx.PageNumber.CURRENT], size: 16, font: theme.font, color: "999999" }),
        ],
      })];
    } else if (page_numbers) {
      footerChildren = [new docx.Paragraph({
        alignment: docx.AlignmentType.CENTER,
        children: [new docx.TextRun({ children: [docx.PageNumber.CURRENT], size: 16, font: theme.font, color: "999999" })],
      })];
    } else if (footer_text) {
      footerChildren = [new docx.Paragraph({
        alignment: docx.AlignmentType.CENTER,
        children: [new docx.TextRun({ text: footer_text, size: 16, font: theme.font, color: "999999" })],
      })];
    }

    const docSections = [{
      properties: {
        page: {
          size: { width: 12240, height: 15840 },
          margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 },
        },
      },
      headers: header_text ? {
        default: new docx.Header({
          children: [new docx.Paragraph({
            alignment: docx.AlignmentType.RIGHT,
            children: [new docx.TextRun({ text: header_text, size: 16, font: theme.font, color: "999999" })],
          })],
        }),
      } : undefined,
      footers: footerChildren ? {
        default: new docx.Footer({ children: footerChildren }),
      } : undefined,
      children,
    }];

    const doc = new docx.Document({ styles, sections: docSections, numbering });
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
