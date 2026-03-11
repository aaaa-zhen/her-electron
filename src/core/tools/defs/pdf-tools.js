const fs = require("fs");
const path = require("path");
const { BaseTool } = require("../base-tool");
const { safePath, getFileType } = require("../helpers");

class PdfToolsTool extends BaseTool {
  get name() { return "pdf_tools"; }
  get timeout() { return 60000; }
  get description() {
    return [
      "PDF processing tool. Supported operations:",
      "- extract_text: Extract all text from a PDF",
      "- merge: Merge multiple PDFs into one (specify files array)",
      "- split: Extract specific pages from a PDF (specify pages like '1-3,5')",
      "- images_to_pdf: Convert images to a PDF (specify files array)",
      "- info: Get PDF metadata (page count, title, author, etc.)",
    ].join("\n");
  }

  get input_schema() {
    return {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["extract_text", "merge", "split", "images_to_pdf", "info"],
          description: "The PDF operation to perform",
        },
        input: { type: "string", description: "Input PDF filename (for extract_text, split, info)" },
        output: { type: "string", description: "Output filename" },
        files: { type: "array", items: { type: "string" }, description: "Array of filenames (for merge, images_to_pdf)" },
        pages: { type: "string", description: "Page range for split, e.g. '1-3,5,8-10'" },
      },
      required: ["operation"],
    };
  }

  async execute(input, ctx) {
    const { operation } = input;
    try {
      switch (operation) {
        case "extract_text": return await this._extractText(input, ctx);
        case "merge": return await this._merge(input, ctx);
        case "split": return await this._split(input, ctx);
        case "images_to_pdf": return await this._imagesToPdf(input, ctx);
        case "info": return await this._info(input, ctx);
        default: return { content: `Unknown operation: ${operation}`, is_error: true };
      }
    } catch (err) {
      return { content: `PDF operation failed: ${err.message}`, is_error: true };
    }
  }

  async _extractText(input, ctx) {
    const pdfParse = require("pdf-parse");
    const inputPath = safePath(ctx.paths.sharedDir, input.input);
    if (!inputPath || !fs.existsSync(inputPath)) return { content: `File not found: ${input.input}`, is_error: true };

    ctx.emitCommand("pdf_tools", "提取文字", input.input);
    const buffer = fs.readFileSync(inputPath);
    const data = await pdfParse(buffer);

    if (input.output) {
      const outputPath = safePath(ctx.paths.sharedDir, input.output);
      if (outputPath) {
        fs.writeFileSync(outputPath, data.text);
        ctx.rememberArtifact(input.output, `从 ${input.input} 提取的文字`, ["pdf", "text"], { kind: "file", origin: "pdf_tools" });
        return `Extracted ${data.numpages} pages of text → ${input.output}`;
      }
    }

    const text = data.text.trim().slice(0, 8000);
    return `PDF: ${data.numpages} pages\n\n${text}${data.text.length > 8000 ? "\n\n...(truncated)" : ""}`;
  }

  async _merge(input, ctx) {
    const { PDFDocument } = require("pdf-lib");
    if (!input.files || input.files.length < 2) return { content: "Need at least 2 files to merge", is_error: true };
    if (!input.output) return { content: "output filename required", is_error: true };

    ctx.emitCommand("pdf_tools", "合并 PDF", `${input.files.length} files → ${input.output}`);
    const merged = await PDFDocument.create();

    for (const file of input.files) {
      const filePath = safePath(ctx.paths.sharedDir, file);
      if (!filePath || !fs.existsSync(filePath)) return { content: `File not found: ${file}`, is_error: true };
      const bytes = fs.readFileSync(filePath);
      const doc = await PDFDocument.load(bytes);
      const pages = await merged.copyPages(doc, doc.getPageIndices());
      pages.forEach((page) => merged.addPage(page));
    }

    const outputPath = safePath(ctx.paths.sharedDir, input.output);
    if (!outputPath) return { content: "Invalid output path", is_error: true };
    fs.writeFileSync(outputPath, await merged.save());
    ctx.rememberArtifact(input.output, `合并了 ${input.files.length} 个 PDF`, ["pdf", "merge"], { kind: "file", origin: "pdf_tools" });
    return `Merged ${input.files.length} PDFs → ${input.output} (${merged.getPageCount()} pages)`;
  }

  async _split(input, ctx) {
    const { PDFDocument } = require("pdf-lib");
    if (!input.input) return { content: "input filename required", is_error: true };
    if (!input.output) return { content: "output filename required", is_error: true };
    if (!input.pages) return { content: "pages required (e.g. '1-3,5')", is_error: true };

    const inputPath = safePath(ctx.paths.sharedDir, input.input);
    if (!inputPath || !fs.existsSync(inputPath)) return { content: `File not found: ${input.input}`, is_error: true };

    ctx.emitCommand("pdf_tools", "拆分 PDF", `${input.input} pages ${input.pages}`);
    const bytes = fs.readFileSync(inputPath);
    const srcDoc = await PDFDocument.load(bytes);
    const totalPages = srcDoc.getPageCount();

    const indices = this._parsePages(input.pages, totalPages);
    if (indices.length === 0) return { content: "No valid pages in range", is_error: true };

    const newDoc = await PDFDocument.create();
    const pages = await newDoc.copyPages(srcDoc, indices);
    pages.forEach((page) => newDoc.addPage(page));

    const outputPath = safePath(ctx.paths.sharedDir, input.output);
    if (!outputPath) return { content: "Invalid output path", is_error: true };
    fs.writeFileSync(outputPath, await newDoc.save());
    ctx.rememberArtifact(input.output, `从 ${input.input} 提取了 ${indices.length} 页`, ["pdf", "split"], { kind: "file", origin: "pdf_tools" });
    return `Extracted ${indices.length} pages → ${input.output}`;
  }

  async _imagesToPdf(input, ctx) {
    const { PDFDocument } = require("pdf-lib");
    if (!input.files || input.files.length === 0) return { content: "files array required", is_error: true };
    if (!input.output) return { content: "output filename required", is_error: true };

    ctx.emitCommand("pdf_tools", "图片转 PDF", `${input.files.length} images → ${input.output}`);
    const doc = await PDFDocument.create();

    for (const file of input.files) {
      const filePath = safePath(ctx.paths.sharedDir, file);
      if (!filePath || !fs.existsSync(filePath)) return { content: `File not found: ${file}`, is_error: true };
      const bytes = fs.readFileSync(filePath);
      const ext = path.extname(file).toLowerCase();

      let img;
      if (ext === ".png") img = await doc.embedPng(bytes);
      else if ([".jpg", ".jpeg"].includes(ext)) img = await doc.embedJpg(bytes);
      else return { content: `Unsupported image format: ${ext} (use PNG or JPG)`, is_error: true };

      const page = doc.addPage([img.width, img.height]);
      page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    }

    const outputPath = safePath(ctx.paths.sharedDir, input.output);
    if (!outputPath) return { content: "Invalid output path", is_error: true };
    fs.writeFileSync(outputPath, await doc.save());
    ctx.rememberArtifact(input.output, `${input.files.length} 张图片转为 PDF`, ["pdf", "images"], { kind: "file", origin: "pdf_tools" });
    return `Created PDF from ${input.files.length} images → ${input.output}`;
  }

  async _info(input, ctx) {
    const pdfParse = require("pdf-parse");
    if (!input.input) return { content: "input filename required", is_error: true };
    const inputPath = safePath(ctx.paths.sharedDir, input.input);
    if (!inputPath || !fs.existsSync(inputPath)) return { content: `File not found: ${input.input}`, is_error: true };

    const buffer = fs.readFileSync(inputPath);
    const data = await pdfParse(buffer);
    const size = (buffer.length / 1024).toFixed(1);
    return `File: ${input.input}\nPages: ${data.numpages}\nSize: ${size} KB\nTitle: ${data.info?.Title || "N/A"}\nAuthor: ${data.info?.Author || "N/A"}\nCreator: ${data.info?.Creator || "N/A"}`;
  }

  _parsePages(spec, total) {
    const indices = new Set();
    for (const part of spec.split(",")) {
      const trimmed = part.trim();
      const rangeMatch = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
      if (rangeMatch) {
        const start = Math.max(1, parseInt(rangeMatch[1]));
        const end = Math.min(total, parseInt(rangeMatch[2]));
        for (let i = start; i <= end; i++) indices.add(i - 1);
      } else {
        const num = parseInt(trimmed);
        if (num >= 1 && num <= total) indices.add(num - 1);
      }
    }
    return [...indices].sort((a, b) => a - b);
  }
}

module.exports = PdfToolsTool;
