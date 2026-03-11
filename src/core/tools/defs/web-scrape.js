const fs = require("fs");
const path = require("path");
const { BaseTool } = require("../base-tool");
const { safePath } = require("../helpers");

class WebScrapeTool extends BaseTool {
  get name() { return "web_scrape"; }
  get timeout() { return 30000; }
  get description() {
    return [
      "Scrape a web page and return its content. Supported operations:",
      "- read: Fetch page content as clean text (strips HTML tags)",
      "- screenshot: Take a screenshot of the page (saves as PNG)",
      "- html: Fetch raw HTML source",
    ].join("\n");
  }

  get input_schema() {
    return {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to scrape" },
        operation: {
          type: "string",
          enum: ["read", "screenshot", "html"],
          description: "What to do with the page (default: read)",
        },
        output: { type: "string", description: "Output filename for screenshot or html" },
      },
      required: ["url"],
    };
  }

  async execute(input, ctx) {
    const { BrowserWindow } = require("electron");
    const url = input.url;
    const operation = input.operation || "read";

    if (!/^https?:\/\//i.test(url)) return { content: "URL must start with http:// or https://", is_error: true };

    ctx.emitCommand("web_scrape", "抓取网页", url);

    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });

    try {
      await win.loadURL(url);
      // Wait for page to settle
      await new Promise((r) => setTimeout(r, 2000));

      if (operation === "screenshot") {
        const filename = input.output || "screenshot.png";
        const outputPath = safePath(ctx.paths.sharedDir, filename);
        if (!outputPath) { win.destroy(); return { content: "Invalid output path", is_error: true }; }

        const image = await win.webContents.capturePage();
        fs.writeFileSync(outputPath, image.toPNG());
        win.destroy();

        ctx.rememberArtifact(filename, `网页截图: ${url}`, ["web", "screenshot"], { kind: "image", origin: "web_scrape", sourceUrl: url });
        return `Screenshot saved: ${filename}`;
      }

      if (operation === "html") {
        const html = await win.webContents.executeJavaScript("document.documentElement.outerHTML");
        win.destroy();

        if (input.output) {
          const outputPath = safePath(ctx.paths.sharedDir, input.output);
          if (outputPath) {
            fs.writeFileSync(outputPath, html);
            ctx.rememberArtifact(input.output, `网页 HTML: ${url}`, ["web", "html"], { kind: "file", origin: "web_scrape" });
            return `HTML saved: ${input.output} (${(html.length / 1024).toFixed(1)} KB)`;
          }
        }
        return html.slice(0, 10000) + (html.length > 10000 ? "\n\n...(truncated)" : "");
      }

      // Default: read — extract clean text
      const text = await win.webContents.executeJavaScript(`
        (function() {
          // Remove script, style, nav, footer, header
          const remove = document.querySelectorAll('script, style, nav, footer, header, iframe, noscript, svg');
          remove.forEach(el => el.remove());

          // Get main content or body
          const main = document.querySelector('main, article, [role="main"], .content, #content');
          const target = main || document.body;

          // Get text and clean up
          return target.innerText.replace(/\\n{3,}/g, '\\n\\n').trim();
        })()
      `);
      win.destroy();

      const title = await this._getTitle(url, ctx);
      const result = title ? `# ${title}\n\n${text}` : text;
      return result.slice(0, 12000) + (result.length > 12000 ? "\n\n...(truncated)" : "");
    } catch (err) {
      win.destroy();
      return { content: `Failed to load page: ${err.message}`, is_error: true };
    }
  }

  async _getTitle(url, ctx) {
    try {
      const { execAsync } = require("../process-utils");
      const html = await execAsync(`curl -sL -m 5 "${url}" | head -c 5000`, { timeout: 8000, cwd: ctx.paths.sharedDir });
      const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      return match ? match[1].trim() : "";
    } catch {
      return "";
    }
  }
}

module.exports = WebScrapeTool;
