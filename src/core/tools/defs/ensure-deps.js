const { BaseTool } = require("../base-tool");

class EnsureDepsTool extends BaseTool {
  get name() { return "ensure_deps"; }
  get timeout() { return 300000; }
  get description() {
    return [
      "Check and install external system dependencies. Automatically detects the package manager (brew on macOS).",
      "Supported deps: python3, ffmpeg, yt-dlp, imagemagick, pandoc, tesseract",
      "Use this tool before running commands that need external tools if you're unsure they're installed.",
    ].join("\n");
  }

  get input_schema() {
    return {
      type: "object",
      properties: {
        deps: {
          type: "array",
          items: { type: "string" },
          description: "List of dependencies to check/install, e.g. ['ffmpeg', 'python3', 'yt-dlp']",
        },
        check_only: { type: "boolean", description: "If true, only check without installing (default: false)" },
      },
      required: ["deps"],
    };
  }

  async execute(input, ctx) {
    const results = [];
    const toInstall = [];

    for (const dep of input.deps) {
      const installed = await this._isInstalled(dep, ctx);
      if (installed) {
        results.push(`✓ ${dep} — installed`);
      } else {
        results.push(`✗ ${dep} — not found`);
        toInstall.push(dep);
      }
    }

    if (toInstall.length === 0) {
      return results.join("\n");
    }

    if (input.check_only) {
      return results.join("\n") + `\n\nMissing: ${toInstall.join(", ")}`;
    }

    // Check if brew is available (macOS)
    const hasBrew = await this._isInstalled("brew", ctx);
    if (!hasBrew) {
      return results.join("\n") + "\n\nCannot auto-install: Homebrew not found. Please install Homebrew first: https://brew.sh";
    }

    ctx.emitCommand("ensure_deps", "安装依赖", toInstall.join(", "));

    for (const dep of toInstall) {
      const brewName = this._brewName(dep);
      try {
        const cmd = dep === "yt-dlp" ? "brew install yt-dlp" : `brew install ${brewName}`;
        await ctx.execAsync(cmd, { timeout: 240000, cwd: ctx.paths.sharedDir });
        results.push(`  → ${dep} installed successfully`);
      } catch (err) {
        results.push(`  → ${dep} install failed: ${err.message}`);
      }
    }

    return results.join("\n");
  }

  async _isInstalled(name, ctx) {
    try {
      await ctx.execAsync(`which ${name}`, { timeout: 5000, cwd: ctx.paths.sharedDir });
      return true;
    } catch {
      return false;
    }
  }

  _brewName(dep) {
    const map = {
      python3: "python@3",
      ffmpeg: "ffmpeg",
      "yt-dlp": "yt-dlp",
      imagemagick: "imagemagick",
      pandoc: "pandoc",
      tesseract: "tesseract",
    };
    return map[dep] || dep;
  }
}

module.exports = EnsureDepsTool;
