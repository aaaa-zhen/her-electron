const fs = require("fs");
const { BaseTool } = require("../base-tool");
const { safePath } = require("../helpers");

const THEMES = {
  dark: {
    bg: "1a1a2e", title: "FFFFFF", body: "CCCCCC",
    accent: "6EE7B7", subtitle: "9999AA", shapeFill: "25253D",
  },
  light: {
    bg: "F8F8FC", title: "1A1A2E", body: "444455",
    accent: "10B981", subtitle: "777788", shapeFill: "EEEEF4",
  },
  blue: {
    bg: "0F172A", title: "FFFFFF", body: "BBCCDD",
    accent: "60A5FA", subtitle: "8899BB", shapeFill: "1E293B",
  },
  green: {
    bg: "0A1A15", title: "FFFFFF", body: "BBDDCC",
    accent: "34D399", subtitle: "88BB99", shapeFill: "152E22",
  },
};

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
    const PptxGenJS = require("pptxgenjs");
    const { filename, slides, title, subtitle, theme: themeName = "dark" } = input;
    const outPath = safePath(ctx.paths.sharedDir, filename);
    if (!outPath) return { content: "Invalid filename", is_error: true };

    ctx.emitCommand("create_pptx", "创建 PPT", filename);
    const theme = THEMES[themeName] || THEMES.dark;
    const pptx = new PptxGenJS();
    pptx.layout = "LAYOUT_WIDE";

    // Cover slide
    const cover = pptx.addSlide();
    cover.background = { color: theme.bg };
    cover.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: "100%", h: 0.06, fill: { color: theme.accent } });
    cover.addText(title || "Untitled", {
      x: 1, y: 2.2, w: 8, h: 1.5, fontSize: 40, bold: true,
      color: theme.title, align: "center", fontFace: "Helvetica Neue",
    });
    if (subtitle) {
      cover.addShape(pptx.ShapeType.rect, { x: 4, y: 3.55, w: 2, h: 0.04, fill: { color: theme.accent } });
      cover.addText(subtitle, {
        x: 1.5, y: 3.8, w: 7, h: 0.8, fontSize: 20,
        color: theme.subtitle, align: "center", fontFace: "Helvetica Neue",
      });
    }

    let slideNum = 1;
    for (const s of slides) {
      const layout = s.layout || "content";
      const sl = pptx.addSlide();
      sl.background = { color: theme.bg };

      if (layout === "title") {
        sl.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: "100%", h: 0.06, fill: { color: theme.accent } });
        sl.addText(s.title || "", {
          x: 1, y: 2.2, w: 8, h: 1.5, fontSize: 40, bold: true,
          color: theme.title, align: "center", fontFace: "Helvetica Neue",
        });
        if (s.body) {
          sl.addText(s.body, {
            x: 1.5, y: 3.8, w: 7, h: 0.8, fontSize: 20,
            color: theme.subtitle, align: "center", fontFace: "Helvetica Neue",
          });
        }
      } else if (layout === "quote") {
        sl.addText("\u201C", {
          x: 1, y: 1.5, w: 1, h: 1, fontSize: 72, bold: true,
          color: theme.accent, fontFace: "Helvetica Neue",
        });
        sl.addText(s.quote || s.body || "", {
          x: 1.5, y: 2.5, w: 7, h: 3, fontSize: 24,
          color: theme.title, fontFace: "Helvetica Neue",
        });
        if (s.author) {
          sl.addText(`\u2014 ${s.author}`, {
            x: 1.5, y: 5.2, w: 7, h: 0.5, fontSize: 16,
            color: theme.accent, fontFace: "Helvetica Neue",
          });
        }
      } else if (layout === "two_column") {
        sl.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.06, h: "100%", fill: { color: theme.accent } });
        sl.addText(`${String(slideNum).padStart(2, "0")}`, {
          x: 0.3, y: 0.3, w: 0.6, h: 0.4, fontSize: 11, bold: true,
          color: theme.accent, fontFace: "Helvetica Neue",
        });
        if (s.title) {
          sl.addText(s.title, {
            x: 0.8, y: 0.4, w: 8.4, h: 0.8, fontSize: 28, bold: true,
            color: theme.title, fontFace: "Helvetica Neue",
          });
          sl.addShape(pptx.ShapeType.rect, { x: 0.8, y: 1.15, w: 1.2, h: 0.03, fill: { color: theme.accent } });
        }
        sl.addShape(pptx.ShapeType.roundRect, { x: 0.6, y: 1.6, w: 4.1, h: 5, fill: { color: theme.shapeFill }, line: { color: theme.shapeFill } });
        sl.addShape(pptx.ShapeType.roundRect, { x: 5.1, y: 1.6, w: 4.1, h: 5, fill: { color: theme.shapeFill }, line: { color: theme.shapeFill } });
        if (s.left) {
          sl.addText(formatBullets(s.left), {
            x: 0.9, y: 1.9, w: 3.5, h: 4.4, fontSize: 16,
            color: theme.body, fontFace: "Helvetica Neue", valign: "top",
          });
        }
        if (s.right) {
          sl.addText(formatBullets(s.right), {
            x: 5.4, y: 1.9, w: 3.5, h: 4.4, fontSize: 16,
            color: theme.body, fontFace: "Helvetica Neue", valign: "top",
          });
        }
      } else {
        // content layout
        sl.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.06, h: "100%", fill: { color: theme.accent } });
        sl.addText(`${String(slideNum).padStart(2, "0")}`, {
          x: 0.3, y: 0.3, w: 0.6, h: 0.4, fontSize: 11, bold: true,
          color: theme.accent, fontFace: "Helvetica Neue",
        });
        if (s.title) {
          sl.addText(s.title, {
            x: 0.8, y: 0.4, w: 8.4, h: 0.8, fontSize: 28, bold: true,
            color: theme.title, fontFace: "Helvetica Neue",
          });
          sl.addShape(pptx.ShapeType.rect, { x: 0.8, y: 1.15, w: 1.2, h: 0.03, fill: { color: theme.accent } });
        }
        if (s.body) {
          sl.addText(formatBullets(s.body), {
            x: 0.8, y: 1.5, w: 8.4, h: 5, fontSize: 18,
            color: theme.body, fontFace: "Helvetica Neue", valign: "top",
            lineSpacingMultiple: 1.6,
          });
        }
      }

      if (s.notes) sl.addNotes(s.notes);
      slideNum++;
    }

    await pptx.writeFile({ fileName: outPath });
    if (fs.existsSync(outPath)) {
      ctx.emitFile(filename, outPath);
      return `PPT created: ${filename} (${slides.length} slides)`;
    }
    return { content: "Failed to create PPT", is_error: true };
  }
}

function formatBullets(text) {
  return text.split("\n").map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return "";
    if (/^[-*•]\s/.test(trimmed)) return `  •  ${trimmed.replace(/^[-*•]\s*/, "")}`;
    return trimmed;
  }).filter(Boolean).join("\n");
}

module.exports = CreatePptxTool;
