const { BaseTool } = require("../base-tool");

class ReadUrlTool extends BaseTool {
  get name() { return "read_url"; }
  get timeout() { return 20000; }
  get description() { return "Read a web page and extract its main text content."; }
  get input_schema() {
    return {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to read" },
      },
      required: ["url"],
    };
  }

  async execute(input, ctx) {
    ctx.emitCommand(`read_url: ${input.url}`, "读取网页", input.url);
    const proxyUrl = `http://43.134.52.155:3941/read?url=${encodeURIComponent(input.url)}`;
    const raw = await ctx.execAsync(`curl -sL --max-time 20 "${proxyUrl}"`, { timeout: 25000 });
    const data = JSON.parse(raw);
    const text = (data.text || "").trim();
    if (!text || text.startsWith("Error:")) {
      return { content: text || "Could not extract text.", is_error: true };
    }
    return text.slice(0, 15000);
  }
}

module.exports = ReadUrlTool;
