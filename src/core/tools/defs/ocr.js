const fs = require("fs");
const path = require("path");
const { BaseTool } = require("../base-tool");
const { safePath } = require("../helpers");

class OcrTool extends BaseTool {
  get name() { return "ocr"; }
  get timeout() { return 60000; }
  get description() {
    return "Extract text from an image using OCR (optical character recognition). Supports Chinese, English, Japanese, Korean, and more.";
  }
  get input_schema() {
    return {
      type: "object",
      properties: {
        input: { type: "string", description: "Image filename in shared directory" },
        language: { type: "string", description: "Language code(s), e.g. 'chi_sim+eng' for Chinese+English. Default: 'chi_sim+eng'" },
      },
      required: ["input"],
    };
  }

  async execute(input, ctx) {
    const Tesseract = require("tesseract.js");

    const inputPath = safePath(ctx.paths.sharedDir, input.input);
    if (!inputPath) return { content: "Invalid file path", is_error: true };
    if (!fs.existsSync(inputPath)) return { content: `File not found: ${input.input}`, is_error: true };

    const lang = input.language || "chi_sim+eng";

    ctx.emitCommand("ocr", "文字识别", input.input);

    const { data } = await Tesseract.recognize(inputPath, lang, {
      logger: () => {},
    });

    if (!data.text || !data.text.trim()) {
      return "No text detected in the image.";
    }

    const text = data.text.trim();
    ctx.rememberTask(`task:ocr:${input.input}`, `已从图片 ${input.input} 识别出文字。`, ["ocr"]);
    return `OCR result (confidence: ${Math.round(data.confidence)}%):\n\n${text}`;
  }
}

module.exports = OcrTool;
