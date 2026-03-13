const fs = require("fs");
const path = require("path");
const { BaseTool } = require("../base-tool");
const { safePath, getFileType } = require("../helpers");

class EditImageTool extends BaseTool {
  get name() { return "edit_image"; }
  get timeout() { return 120000; }
  get description() {
    return [
      "Edit or process an image file. Supported operations:",
      "- remove_bg: Remove background (requires imagemagick, uses rembg via Python)",
      "- resize: Resize image (specify width and/or height)",
      "- crop: Crop image (specify left, top, width, height in crop_options)",
      "- rotate: Rotate image (specify angle in degrees)",
      "- flip: Flip horizontally",
      "- flop: Flip vertically",
      "- grayscale: Convert to grayscale",
      "- blur: Apply blur (specify blur_sigma, default 3)",
      "- format: Convert format (specify output filename with desired extension)",
      "- composite: Overlay another image on top (specify overlay_file and optional gravity)",
    ].join("\n");
  }

  get input_schema() {
    return {
      type: "object",
      properties: {
        input: { type: "string", description: "Input filename (in shared directory)" },
        output: { type: "string", description: "Output filename (in shared directory)" },
        operation: {
          type: "string",
          enum: ["remove_bg", "resize", "crop", "rotate", "flip", "flop", "grayscale", "blur", "format", "composite"],
          description: "The image processing operation to perform",
        },
        width: { type: "integer", description: "Target width (for resize)" },
        height: { type: "integer", description: "Target height (for resize)" },
        angle: { type: "number", description: "Rotation angle in degrees (for rotate)" },
        blur_sigma: { type: "number", description: "Blur intensity (for blur, default 3)" },
        crop_options: {
          type: "object",
          description: "Crop region: { left, top, width, height }",
          properties: {
            left: { type: "integer" },
            top: { type: "integer" },
            width: { type: "integer" },
            height: { type: "integer" },
          },
        },
        overlay_file: { type: "string", description: "Overlay image filename (for composite)" },
        gravity: { type: "string", description: "Gravity for composite (e.g. 'center', 'northwest')" },
      },
      required: ["input", "output", "operation"],
    };
  }

  async execute(input, ctx) {
    const sharp = require("sharp");

    const { input: inputFile, output: outputFile, operation } = input;
    const inputPath = safePath(ctx.paths.sharedDir, inputFile);
    const outputPath = safePath(ctx.paths.sharedDir, outputFile);
    if (!inputPath || !outputPath) return { content: "Invalid file path", is_error: true };
    if (!fs.existsSync(inputPath)) return { content: `Input file not found: ${inputFile}`, is_error: true };

    try {
      if (operation === "remove_bg") {
        return await this._removeBg(inputPath, outputPath, outputFile, inputFile, ctx);
      }

      let pipeline = sharp(inputPath);

      switch (operation) {
        case "resize":
          pipeline = pipeline.resize(input.width || null, input.height || null, { fit: "inside" });
          break;
        case "crop":
          if (!input.crop_options) return { content: "crop_options required for crop operation", is_error: true };
          pipeline = pipeline.extract(input.crop_options);
          break;
        case "rotate":
          pipeline = pipeline.rotate(input.angle || 90);
          break;
        case "flip":
          pipeline = pipeline.flip();
          break;
        case "flop":
          pipeline = pipeline.flop();
          break;
        case "grayscale":
          pipeline = pipeline.grayscale();
          break;
        case "blur":
          pipeline = pipeline.blur(input.blur_sigma || 3);
          break;
        case "format":
          // sharp auto-detects output format from extension
          break;
        case "composite":
          if (!input.overlay_file) return { content: "overlay_file required for composite", is_error: true };
          const overlayPath = safePath(ctx.paths.sharedDir, input.overlay_file);
          if (!overlayPath || !fs.existsSync(overlayPath))
            return { content: `Overlay file not found: ${input.overlay_file}`, is_error: true };
          pipeline = pipeline.composite([{
            input: overlayPath,
            gravity: input.gravity || "center",
          }]);
          break;
      }

      await pipeline.toFile(outputPath);
      return this._emitResult(outputFile, outputPath, inputFile, operation, ctx);
    } catch (err) {
      return { content: `Image processing failed: ${err.message}`, is_error: true };
    }
  }

  async _removeBg(inputPath, outputPath, outputFile, inputFile, ctx) {
    // Use Python rembg as a lightweight alternative (pip install rembg)
    ctx.emitCommand("edit_image", "去除背景", `${inputFile} -> ${outputFile}`);
    try {
      await ctx.execAsync(`python3 -c "from rembg import remove; from PIL import Image; Image.open('${inputPath}').pipe(remove).save('${outputPath}')" 2>/dev/null || rembg i "${inputPath}" "${outputPath}"`, { timeout: 60000, cwd: path.dirname(outputPath) });
      if (!fs.existsSync(outputPath)) throw new Error("Output not created");
      return this._emitResult(outputFile, outputPath, inputFile, "remove_bg", ctx);
    } catch (err) {
      return { content: `Background removal failed. Please install rembg first: pip install rembg\nError: ${err.message}`, is_error: true };
    }
  }

  _emitResult(outputFile, outputPath, inputFile, operation, ctx) {
    const stats = fs.statSync(outputPath);
    // Don't emitFile here — AI will use send_file to deliver the result, avoiding duplicate cards
    ctx.rememberArtifact(outputFile,
      `图像处理结果: ${operation} (${inputFile} -> ${outputFile})`,
      ["image", operation],
      { kind: getFileType(outputFile), origin: "edit_image", sourceFile: inputFile },
    );
    return `Done: ${outputFile} (${(stats.size / 1024).toFixed(1)} KB)`;
  }
}

module.exports = EditImageTool;
