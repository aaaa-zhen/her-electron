const fs = require("fs");
const { BaseTool } = require("../base-tool");
const { safePath } = require("../helpers");

const THEMES = {
  dark: {
    bg: "1a1a2e", title: "FFFFFF", body: "CCCCCC",
    accent: "6EE7B7", subtitle: "9999AA", shapeFill: "25253D",
    headerFont: "Arial Black", bodyFont: "Arial",
  },
  light: {
    bg: "F8F8FC", title: "1A1A2E", body: "444455",
    accent: "10B981", subtitle: "777788", shapeFill: "EEEEF4",
    headerFont: "Arial Black", bodyFont: "Arial",
  },
  blue: {
    bg: "0F172A", title: "FFFFFF", body: "BBCCDD",
    accent: "60A5FA", subtitle: "8899BB", shapeFill: "1E293B",
    headerFont: "Arial Black", bodyFont: "Arial",
  },
  green: {
    bg: "0A1A15", title: "FFFFFF", body: "BBDDCC",
    accent: "34D399", subtitle: "88BB99", shapeFill: "152E22",
    headerFont: "Arial Black", bodyFont: "Arial",
  },
  coral: {
    bg: "FFF5F5", title: "2F3C7E", body: "4A4A6A",
    accent: "F96167", subtitle: "8888AA", shapeFill: "FFE8E8",
    headerFont: "Georgia", bodyFont: "Calibri",
  },
  midnight: {
    bg: "1E2761", title: "FFFFFF", body: "CADCFC",
    accent: "CADCFC", subtitle: "8899CC", shapeFill: "283480",
    headerFont: "Georgia", bodyFont: "Calibri",
  },
  terracotta: {
    bg: "FDF6F0", title: "B85042", body: "5A4A42",
    accent: "B85042", subtitle: "A7BEAE", shapeFill: "F5EDE6",
    headerFont: "Palatino", bodyFont: "Arial",
  },
  ocean: {
    bg: "065A82", title: "FFFFFF", body: "D0E8F2",
    accent: "02C39A", subtitle: "88BBCC", shapeFill: "0A7BAA",
    headerFont: "Trebuchet MS", bodyFont: "Calibri",
  },
};

class CreatePptxTool extends BaseTool {
  get name() { return "create_pptx"; }
  get timeout() { return 30000; }
  get description() { return "Create a polished PowerPoint presentation (.pptx). Themes: dark/light/blue/green/coral/midnight/terracotta/ocean. Layouts: title, content, two_column, quote, image, stat. Body text supports bullets (lines starting with '- '). Always generate at least 5 detailed slides. An ending slide is auto-added."; }
  get input_schema() {
    return {
      type: "object",
      properties: {
        filename: { type: "string", description: "Output filename, e.g. 'report.pptx'" },
        title: { type: "string", description: "Presentation title" },
        subtitle: { type: "string", description: "Subtitle on cover slide" },
        theme: { type: "string", enum: ["dark", "light", "blue", "green", "coral", "midnight", "terracotta", "ocean"], description: "Color theme. Default: dark" },
        ending_text: { type: "string", description: "Text for ending slide. Default: 'Thank You'" },
        slides: {
          type: "array",
          description: "Array of slides",
          items: {
            type: "object",
            properties: {
              layout: { type: "string", enum: ["title", "content", "two_column", "quote", "image", "stat"] },
              title: { type: "string" }, body: { type: "string" },
              left: { type: "string" }, right: { type: "string" },
              quote: { type: "string" }, author: { type: "string" },
              image: { type: "string", description: "Image filename in shared directory" },
              image_side: { type: "string", enum: ["left", "right"], description: "Image position for image layout. Default: right" },
              stat_value: { type: "string", description: "Big number/stat for stat layout, e.g. '98%'" },
              stat_label: { type: "string", description: "Label below the stat" },
              notes: { type: "string" },
            },
          },
        },
      },
      required: ["filename", "title", "slides"],
    };
  }

  async execute(input, ctx) {
    const PptxGenJS = require("pptxgenjs");
    const { filename, slides, title, subtitle, theme: themeName = "dark", ending_text = "Thank You" } = input;
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
      color: theme.title, align: "center", fontFace: theme.headerFont,
    });
    if (subtitle) {
      cover.addShape(pptx.ShapeType.rect, { x: 4, y: 3.55, w: 2, h: 0.04, fill: { color: theme.accent } });
      cover.addText(subtitle, {
        x: 1.5, y: 3.8, w: 7, h: 0.8, fontSize: 20,
        color: theme.subtitle, align: "center", fontFace: theme.bodyFont,
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
          color: theme.title, align: "center", fontFace: theme.headerFont,
        });
        if (s.body) {
          sl.addText(s.body, {
            x: 1.5, y: 3.8, w: 7, h: 0.8, fontSize: 20,
            color: theme.subtitle, align: "center", fontFace: theme.bodyFont,
          });
        }
      } else if (layout === "quote") {
        sl.addText("\u201C", {
          x: 1, y: 1.5, w: 1, h: 1, fontSize: 72, bold: true,
          color: theme.accent, fontFace: theme.headerFont,
        });
        sl.addText(s.quote || s.body || "", {
          x: 1.5, y: 2.5, w: 7, h: 3, fontSize: 24,
          color: theme.title, fontFace: theme.bodyFont,
        });
        if (s.author) {
          sl.addText(`\u2014 ${s.author}`, {
            x: 1.5, y: 5.2, w: 7, h: 0.5, fontSize: 16,
            color: theme.accent, fontFace: theme.bodyFont,
          });
        }
      } else if (layout === "stat") {
        // Big stat callout layout
        addSlideChrome(sl, pptx, theme, slideNum, s.title);
        sl.addShape(pptx.ShapeType.roundRect, { x: 2.5, y: 2.0, w: 5, h: 3.5, fill: { color: theme.shapeFill }, rectRadius: 0.15 });
        sl.addText(s.stat_value || "0", {
          x: 2.5, y: 2.2, w: 5, h: 2.0, fontSize: 64, bold: true,
          color: theme.accent, align: "center", fontFace: theme.headerFont,
        });
        sl.addText(s.stat_label || s.body || "", {
          x: 2.5, y: 4.0, w: 5, h: 1.2, fontSize: 18,
          color: theme.body, align: "center", fontFace: theme.bodyFont,
        });
      } else if (layout === "image") {
        // Image + text layout
        addSlideChrome(sl, pptx, theme, slideNum, s.title);
        const imgPath = s.image ? safePath(ctx.paths.sharedDir, s.image) : null;
        const side = s.image_side || "right";
        const textX = side === "right" ? 0.8 : 5.3;
        const imgX = side === "right" ? 5.3 : 0.6;

        if (imgPath && fs.existsSync(imgPath)) {
          sl.addImage({ path: imgPath, x: imgX, y: 1.6, w: 4.2, h: 5.0, sizing: { type: "contain", w: 4.2, h: 5.0 } });
        } else {
          sl.addShape(pptx.ShapeType.roundRect, { x: imgX, y: 1.6, w: 4.2, h: 5.0, fill: { color: theme.shapeFill }, rectRadius: 0.15 });
          sl.addText(s.image ? `[${s.image}]` : "[Image]", {
            x: imgX, y: 3.5, w: 4.2, h: 1, fontSize: 14,
            color: theme.subtitle, align: "center", fontFace: theme.bodyFont,
          });
        }
        if (s.body) {
          sl.addText(formatBullets(s.body), {
            x: textX, y: 1.9, w: 4.0, h: 4.4, fontSize: 16,
            color: theme.body, fontFace: theme.bodyFont, valign: "top",
            lineSpacingMultiple: 1.5,
          });
        }
      } else if (layout === "two_column") {
        addSlideChrome(sl, pptx, theme, slideNum, s.title);
        sl.addShape(pptx.ShapeType.roundRect, { x: 0.6, y: 1.6, w: 4.1, h: 5, fill: { color: theme.shapeFill }, rectRadius: 0.15 });
        sl.addShape(pptx.ShapeType.roundRect, { x: 5.1, y: 1.6, w: 4.1, h: 5, fill: { color: theme.shapeFill }, rectRadius: 0.15 });
        if (s.left) {
          sl.addText(formatBullets(s.left), {
            x: 0.9, y: 1.9, w: 3.5, h: 4.4, fontSize: 16,
            color: theme.body, fontFace: theme.bodyFont, valign: "top",
            lineSpacingMultiple: 1.5,
          });
        }
        if (s.right) {
          sl.addText(formatBullets(s.right), {
            x: 5.4, y: 1.9, w: 3.5, h: 4.4, fontSize: 16,
            color: theme.body, fontFace: theme.bodyFont, valign: "top",
            lineSpacingMultiple: 1.5,
          });
        }
      } else {
        // content layout (default)
        addSlideChrome(sl, pptx, theme, slideNum, s.title);
        if (s.body) {
          sl.addText(formatBullets(s.body), {
            x: 0.8, y: 1.5, w: 8.4, h: 5, fontSize: 18,
            color: theme.body, fontFace: theme.bodyFont, valign: "top",
            lineSpacingMultiple: 1.6,
          });
        }
      }

      if (s.notes) sl.addNotes(s.notes);
      slideNum++;
    }

    // Ending slide
    const endSlide = pptx.addSlide();
    endSlide.background = { color: theme.bg };
    endSlide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: "100%", h: 0.06, fill: { color: theme.accent } });
    endSlide.addText(ending_text, {
      x: 1, y: 2.5, w: 8, h: 1.5, fontSize: 44, bold: true,
      color: theme.title, align: "center", fontFace: theme.headerFont,
    });

    await pptx.writeFile({ fileName: outPath });
    if (fs.existsSync(outPath)) {
      ctx.emitFile(filename, outPath);
      return `PPT created: ${filename} (${slides.length + 2} slides incl. cover & ending)`;
    }
    return { content: "Failed to create PPT", is_error: true };
  }
}

function addSlideChrome(sl, pptx, theme, slideNum, titleText) {
  sl.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.06, h: "100%", fill: { color: theme.accent } });
  sl.addText(`${String(slideNum).padStart(2, "0")}`, {
    x: 0.3, y: 0.3, w: 0.6, h: 0.4, fontSize: 11, bold: true,
    color: theme.accent, fontFace: theme.bodyFont,
  });
  if (titleText) {
    sl.addText(titleText, {
      x: 0.8, y: 0.4, w: 8.4, h: 0.8, fontSize: 28, bold: true,
      color: theme.title, fontFace: theme.headerFont,
    });
    sl.addShape(pptx.ShapeType.rect, { x: 0.8, y: 1.15, w: 1.2, h: 0.03, fill: { color: theme.accent } });
  }
}

function formatBullets(text) {
  return text.split("\n").map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return "";
    if (/^[-*\u2022]\s/.test(trimmed)) return `  \u2022  ${trimmed.replace(/^[-*\u2022]\s*/, "")}`;
    return trimmed;
  }).filter(Boolean).join("\n");
}

module.exports = CreatePptxTool;
