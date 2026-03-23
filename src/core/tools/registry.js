const fs = require("fs");
const path = require("path");
const { safePath, getFileType, formatSize, toFileUrl } = require("./helpers");
const { execAsync } = require("./process-utils");

function decodeHtml(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function stripTags(value) {
  return decodeHtml(String(value || "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function extractTag(block, tagName) {
  const match = String(block || "").match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, "i"));
  return match ? decodeHtml(match[1]).trim() : "";
}

function extractSource(block) {
  const match = String(block || "").match(/<source[^>]*url="([^"]*)"[^>]*>([\s\S]*?)<\/source>/i);
  if (!match) return { name: "", url: "" };
  return {
    url: decodeHtml(match[1]).trim(),
    name: decodeHtml(match[2]).trim(),
  };
}

function formatNewsDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "";
  return date.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function createTools({ paths, stores, scheduleService, createAnthropicClient, emit }) {
  const memoryStore = stores.memoryStore;
  const todoStore = stores.todoStore;

  async function processScheduleOutput(taskData, rawOutput) {
    let output = rawOutput.slice(0, 5000);
    if (taskData.ai_prompt) {
      try {
        const anthropic = createAnthropicClient();
        const response = await anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 2048,
          messages: [{
            role: "user",
            content: `${taskData.ai_prompt}\n\n---\nRaw data:\n${rawOutput.slice(0, 8000)}`,
          }],
        });
        output = response.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
      } catch (error) {
        console.error("[Schedule AI] Error:", error.message);
      }
    }
    return output.slice(0, 5000);
  }

  if (!scheduleService.processScheduleOutput) {
    scheduleService.processScheduleOutput = processScheduleOutput;
  }

  const tools = [
    {
      name: "bash",
      description: `Execute a bash command on this computer. Working directory: ${paths.sharedDir}`,
      input_schema: {
        type: "object",
        properties: {
          command: { type: "string", description: "The bash command to execute" },
          cwd: { type: "string", description: "Working directory for the command" },
        },
        required: ["command"],
      },
    },
    {
      name: "read_file",
      description: "Read file contents with line numbers.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute file path" },
          offset: { type: "number", description: "Start line (1-based). Default: 1" },
          limit: { type: "number", description: "Max lines. Default: 500" },
        },
        required: ["path"],
      },
    },
    {
      name: "write_file",
      description: "Create or overwrite a file.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute file path" },
          content: { type: "string", description: "File content" },
        },
        required: ["path", "content"],
      },
    },
    {
      name: "edit_file",
      description: "Edit a file by replacing exact string matches. Always read_file first.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute file path" },
          old_string: { type: "string", description: "Exact string to find (must be unique)" },
          new_string: { type: "string", description: "Replacement string" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
    {
      name: "glob",
      description: "Find files matching a glob pattern.",
      input_schema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern, e.g. '**/*.js'" },
          path: { type: "string", description: "Base directory. Default: home dir" },
        },
        required: ["pattern"],
      },
    },
    {
      name: "grep",
      description: "Search file contents using regex. Returns matching lines with file paths and line numbers.",
      input_schema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern" },
          path: { type: "string", description: "File or directory to search" },
          include: { type: "string", description: "File filter, e.g. '*.js'" },
        },
        required: ["pattern"],
      },
    },
    {
      name: "send_file",
      description: "Send a file to the user in chat.",
      input_schema: {
        type: "object",
        properties: {
          filename: { type: "string", description: "Filename in the shared directory" },
        },
        required: ["filename"],
      },
    },
    {
      name: "schedule_task",
      description: "Schedule a task to run once after a delay OR on a recurring cron schedule.",
      input_schema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Bash command to execute" },
          cron: { type: "string", description: "Cron expression for recurring tasks" },
          delay: { type: "number", description: "Run once after this many seconds" },
          description: { type: "string", description: "Human-readable description" },
          ai_prompt: { type: "string", description: "If set, AI processes the output before displaying" },
        },
        required: ["description"],
      },
    },
    {
      name: "todo",
      description: "Manage user's todo/task list shown on the home screen. PROACTIVELY add items whenever the user mentions ANY plan, intention, or commitment — even casual ones like '上完课去睡觉', '下午要开会', '晚上想跑步'. Don't wait for the user to ask you to add it. If the user says they plan to do something, add it immediately as a todo so it shows on their home screen. IMPORTANT: Always convert relative dates (e.g. '明天', 'next Monday', '上完课后') to absolute ISO 8601 timestamps based on the current time. Set expires_at to a reasonable time after the event ends (usually event time + 1 hour) so expired items auto-hide.",
      input_schema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["add", "complete", "remove", "list"], description: "Action to perform" },
          title: { type: "string", description: "Todo title (for add/complete/remove)" },
          detail: { type: "string", description: "Extra detail (for add)" },
          due_date: { type: "string", description: "ISO 8601 absolute timestamp for when this is due, e.g. '2026-03-08T06:00:00+08:00'. MUST be absolute, never relative like '明天'. (for add)" },
          expires_at: { type: "string", description: "ISO 8601 absolute timestamp for when this todo should auto-hide, e.g. '2026-03-08T07:00:00+08:00'. Usually due_date + 1 hour. (for add)" },
        },
        required: ["action"],
      },
    },
    {
      name: "memory",
      description: "Save, delete, list, or search long-term memories.",
      input_schema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["save", "delete", "list", "search"] },
          key: { type: "string", description: "Memory key" },
          value: { type: "string", description: "Value to remember (for save)" },
          query: { type: "string", description: "Search keyword (for search)" },
        },
        required: ["action"],
      },
    },
    {
      name: "apple_reminders",
      description: "Manage Apple Reminders: add, complete, list, or delete reminders.",
      input_schema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["add", "complete", "list", "delete"], description: "Action to perform" },
          title: { type: "string", description: "Reminder title (for add/complete/delete)" },
          list: { type: "string", description: "Reminder list name. Default: Reminders" },
          due_date: { type: "string", description: "Due date in YYYY-MM-DD or YYYY-MM-DD HH:mm format (for add)" },
          notes: { type: "string", description: "Reminder notes (for add)" },
        },
        required: ["action"],
      },
    },
    {
      name: "apple_notes",
      description: "Manage Apple Notes: create, search, read, or list notes.",
      input_schema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["create", "search", "read", "list"], description: "Action to perform" },
          title: { type: "string", description: "Note title (for create/read)" },
          body: { type: "string", description: "Note body content (for create)" },
          folder: { type: "string", description: "Folder name. Default: Notes" },
          query: { type: "string", description: "Search keyword (for search)" },
        },
        required: ["action"],
      },
    },
    {
      name: "apple_clock",
      description: "Set alarms and timers using macOS. Actions: set_alarm, set_timer, list_alarms.",
      input_schema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["set_alarm", "set_timer", "list_alarms"], description: "Action to perform" },
          time: { type: "string", description: "Alarm time in HH:mm format (for set_alarm)" },
          label: { type: "string", description: "Alarm/timer label" },
          seconds: { type: "number", description: "Timer duration in seconds (for set_timer)" },
        },
        required: ["action"],
      },
    },
    {
      name: "create_pptx",
      description: "Create a polished PowerPoint presentation (.pptx). Supports dark/light/blue/green themes, slide layouts: title, content, two_column, quote. Body text supports bullet points (lines starting with '- '). Always generate at least 5 detailed slides with rich content.",
      input_schema: {
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
                layout: { type: "string", enum: ["title", "content", "two_column", "quote"], description: "Slide layout" },
                title: { type: "string", description: "Slide title" },
                body: { type: "string", description: "Body text. Use \\n for line breaks, start lines with '- ' for bullets" },
                left: { type: "string", description: "Left column text (two_column layout)" },
                right: { type: "string", description: "Right column text (two_column layout)" },
                quote: { type: "string", description: "Quote text (quote layout)" },
                author: { type: "string", description: "Quote author (quote layout)" },
                notes: { type: "string", description: "Speaker notes" },
              },
            },
          },
        },
        required: ["filename", "title", "slides"],
      },
    },
    {
      name: "create_docx",
      description: "Create a polished Word document (.docx). Supports themes (default/formal/modern/minimal), headings, paragraphs, bullet/numbered lists, tables, quotes, code blocks, images, and page breaks. Always generate structured, well-organized content with proper headings and sections.",
      input_schema: {
        type: "object",
        properties: {
          filename: { type: "string", description: "Output filename, e.g. 'report.docx'" },
          title: { type: "string", description: "Document title" },
          subtitle: { type: "string", description: "Optional subtitle" },
          theme: { type: "string", enum: ["default", "formal", "modern", "minimal"], description: "Color theme. Default: default" },
          header_text: { type: "string", description: "Optional text shown in page header" },
          footer_text: { type: "string", description: "Optional text shown in page footer" },
          sections: {
            type: "array",
            description: "Array of document sections",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["heading", "paragraph", "bullet_list", "numbered_list", "table", "quote", "code", "page_break", "image"], description: "Section type" },
                level: { type: "integer", description: "Heading level 1-3 (for heading type)" },
                text: { type: "string", description: "Text content (for heading, paragraph, quote, code)" },
                items: { type: "array", items: { type: "string" }, description: "List items (for bullet_list, numbered_list)" },
                headers: { type: "array", items: { type: "string" }, description: "Table column headers" },
                rows: { type: "array", items: { type: "array", items: { type: "string" } }, description: "Table rows" },
                language: { type: "string", description: "Code language hint (for code type)" },
                src: { type: "string", description: "Image file path (for image type)" },
                width_inches: { type: "number", description: "Image width in inches (default 5)" },
                bold: { type: "boolean", description: "Bold text (for paragraph)" },
                italic: { type: "boolean", description: "Italic text (for paragraph)" },
                alignment: { type: "string", enum: ["left", "center", "right"], description: "Text alignment (for paragraph)" },
              },
            },
          },
        },
        required: ["filename", "title", "sections"],
      },
    },
    {
      name: "create_xlsx",
      description: "Create a polished Excel spreadsheet (.xlsx). Supports themes (blue/green/dark/minimal), auto-filter, freeze panes, formulas, and charts (bar/line/pie). Multiple sheets supported.",
      input_schema: {
        type: "object",
        properties: {
          filename: { type: "string", description: "Output filename, e.g. 'data.xlsx'" },
          theme: { type: "string", enum: ["blue", "green", "dark", "minimal"], description: "Color theme. Default: blue" },
          sheets: {
            type: "array",
            description: "Array of sheets",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Sheet name" },
                headers: { type: "array", items: { type: "string" }, description: "Column headers" },
                rows: { type: "array", items: { type: "array" }, description: "Data rows" },
                column_widths: { type: "array", items: { type: "number" }, description: "Column widths" },
                freeze: { type: "string", description: "Freeze pane cell, e.g. 'A2'. Default: 'A2'" },
                auto_filter: { type: "boolean", description: "Enable auto filter. Default: true" },
                formulas: { type: "object", description: "Cell formulas, e.g. {\"D2\": \"=SUM(B2:C2)\"}" },
                chart: {
                  type: "object",
                  properties: {
                    type: { type: "string", enum: ["bar", "line", "pie"], description: "Chart type" },
                    title: { type: "string", description: "Chart title" },
                    position: { type: "string", description: "Chart position cell, e.g. 'E2'" },
                  },
                },
              },
            },
          },
        },
        required: ["filename", "sheets"],
      },
    },
    {
      name: "download_media",
      description: "Download video or audio from YouTube, Bilibili, Twitter, TikTok, and 1000+ sites using yt-dlp.",
      input_schema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL of the video/audio" },
          format: { type: "string", enum: ["video", "audio"], description: "Download as video or audio. Default: video" },
          quality: { type: "string", description: "Quality: best, 720p, 480p. Default: best" },
        },
        required: ["url"],
      },
    },
    {
      name: "convert_media",
      description: "Convert or process media files using ffmpeg.",
      input_schema: {
        type: "object",
        properties: {
          input: { type: "string", description: "Input filename (in shared directory)" },
          output: { type: "string", description: "Output filename" },
          options: { type: "string", description: "ffmpeg options between input and output" },
        },
        required: ["input", "output"],
      },
    },
    {
      name: "recent_files",
      description: "List recently modified files on this Mac. Shows what the user has been working on.",
      input_schema: {
        type: "object",
        properties: {
          days: { type: "number", description: "How many days back to look (default: 1)" },
          limit: { type: "number", description: "Max files to return (default: 20)" },
          folder: { type: "string", description: "Specific folder to search in (default: home directory)" },
        },
      },
    },
    {
      name: "read_url",
      description: "Read a web page and extract its main text content.",
      input_schema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to read" },
        },
        required: ["url"],
      },
    },
    {
      name: "her_web_search",
      description: "Search the web using Anthropic's built-in search. Returns relevant results with snippets. Use this for real-time information, current events, facts, etc.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
        },
        required: ["query"],
      },
    },
  ];

  function describeShellCommand(command) {
    const executable = String(command || "").trim().split(/\s+/)[0];
    const labels = {
      git: "运行 Git",
      npm: "运行 npm",
      npx: "运行 npx",
      node: "运行 Node.js",
      python: "运行 Python",
      python3: "运行 Python",
      ls: "查看目录",
      cat: "查看文件",
      rg: "搜索代码",
      grep: "搜索内容",
      curl: "请求网页",
      search_news: "搜索新闻",
      ffmpeg: "处理媒体",
      "yt-dlp": "下载媒体",
    };
    return labels[executable] || "执行终端命令";
  }

  function shortValue(value, fallback = "") {
    const text = String(value || fallback || "").trim();
    if (!text) return "";
    return text.length > 72 ? `${text.slice(0, 72)}...` : text;
  }

  function emitCommand(command, title, detail) {
    emit({
      type: "command",
      command,
      title,
      detail: shortValue(detail, command),
    });
  }

  function emitFile(filename, filePath) {
    const stat = fs.statSync(filePath);
    emit({
      type: "file",
      filename,
      url: toFileUrl(filePath),
      fileType: getFileType(filename),
      size: formatSize(stat.size),
      sizeBytes: stat.size,
    });
  }

  function rememberTask(key, value, tags = []) {
    memoryStore.saveEntry(key, value, {
      type: "task_history",
      tags: ["task_history", ...tags],
    });
  }

  function rememberArtifact(filename, detail, tags = [], meta = {}) {
    if (!filename) return;
    memoryStore.saveEntry(`artifact:${filename}`, detail, {
      type: "artifact",
      tags: ["artifact", ...tags],
      meta: { filename, ...meta },
    });
  }

  function rememberShellTask(command, output) {
    const textCommand = String(command || "");
    if (!/\byt-dlp\b/.test(textCommand)) return;

    const urlMatch = textCommand.match(/https?:\/\/[^\s"]+/);
    const lines = String(output || "").trim().split("\n").map((line) => line.trim()).filter(Boolean);
    const lastLine = lines[lines.length - 1] || "";
    const filename = lastLine ? path.basename(lastLine) : "";
    const label = filename || "媒体文件";
    const source = urlMatch ? `，来源 ${urlMatch[0]}` : "";

    rememberTask(
      `task:download-media:${label}`,
      `已为用户下载媒体 ${label}${source}。`,
      ["media", "video"]
    );
    if (filename) {
      rememberArtifact(
        filename,
        `这是我通过终端替用户下载的媒体文件 ${filename}${source}。`,
        ["media", "video"],
        { kind: getFileType(filename), origin: "bash_yt_dlp", sourceUrl: urlMatch ? urlMatch[0] : "" }
      );
    }
  }

  async function resolveFinalUrl(url) {
    if (!url) return "";
    // Google News uses JS redirect — curl can't follow it
    // Use Electron BrowserWindow to resolve the real URL
    if (url.includes("news.google.com")) {
      try {
        return await resolveGoogleNewsUrl(url);
      } catch {
        return url;
      }
    }
    const command = `curl -Ls -o /dev/null -w "%{url_effective}" "${url}"`;
    const output = await execAsync(command, { timeout: 15000, cwd: paths.sharedDir });
    return String(output || "").trim() || url;
  }

  function resolveGoogleNewsUrl(googleUrl) {
    const { BrowserWindow } = require("electron");
    return new Promise((resolve) => {
      let resolved = false;
      const win = new BrowserWindow({
        show: false, width: 400, height: 300,
        webPreferences: { nodeIntegration: false, contextIsolation: true },
      });
      const timeout = setTimeout(() => {
        if (!resolved) { resolved = true; win.destroy(); resolve(googleUrl); }
      }, 10000);
      win.webContents.on("did-redirect-navigation", (_event, newUrl) => {
        if (!newUrl.includes("news.google.com") && !resolved) {
          resolved = true; clearTimeout(timeout); win.destroy(); resolve(newUrl);
        }
      });
      win.webContents.on("did-navigate", (_event, newUrl) => {
        if (!newUrl.includes("news.google.com") && !resolved) {
          resolved = true; clearTimeout(timeout); win.destroy(); resolve(newUrl);
        }
      });
      win.loadURL(googleUrl).catch(() => {
        if (!resolved) { resolved = true; clearTimeout(timeout); win.destroy(); resolve(googleUrl); }
      });
    });
  }

  async function fetchPreviewImage(url) {
    if (!url) return "";
    try {
      const command = `curl -Ls -m 8 -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" "${url}" | head -c 200000`;
      const html = await execAsync(command, { timeout: 12000, cwd: paths.sharedDir });

      // Try og:image (both attribute orders)
      const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
        || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
      if (ogMatch && ogMatch[1]) return decodeHtml(ogMatch[1]).trim();

      // Try twitter:image
      const twitterMatch = html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)
        || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);
      if (twitterMatch && twitterMatch[1]) return decodeHtml(twitterMatch[1]).trim();

      // Try first large-ish <img> with https src (skip icons/tracking pixels)
      const imgMatches = html.matchAll(/<img[^>]+src=["'](https?:\/\/[^"']+)["'][^>]*>/gi);
      for (const m of imgMatches) {
        const src = decodeHtml(m[1]).trim();
        if (/\.(svg|gif|ico)(\?|$)/i.test(src)) continue;
        if (/logo|icon|avatar|badge|pixel|tracker|1x1/i.test(src)) continue;
        // Check for width/height hints suggesting a real image
        const tag = m[0];
        const widthMatch = tag.match(/width=["']?(\d+)/i);
        if (widthMatch && parseInt(widthMatch[1], 10) < 100) continue;
        return src;
      }
    } catch {
      // timeout or network error — just skip
    }
    return "";
  }

  function extractBingImageUrl(block) {
    const match = String(block || "").match(/<News:Image>([^<]+)<\/News:Image>/i);
    if (!match) return "";
    const raw = decodeHtml(match[1]).trim();
    // Bing images support size params — request a reasonable thumbnail
    if (raw.includes("bing.com/th?")) return `${raw}&w=400&h=240&c=7`;
    return raw;
  }

  function extractBingRealUrl(linkText) {
    // Bing wraps real URLs: ...&url=https%3a%2f%2f...&...
    const match = String(linkText || "").match(/[?&]url=(https?%3[aA]%2[fF]%2[fF][^&]+)/i);
    if (match) {
      try { return decodeURIComponent(match[1]); } catch { return ""; }
    }
    return "";
  }

  function extractRssImage(block) {
    const mediaMatch = String(block || "").match(/<media:content[^>]+url=["']([^"']+)["']/i);
    if (mediaMatch) return decodeHtml(mediaMatch[1]).trim();
    const encMatch = String(block || "").match(/<enclosure[^>]+url=["']([^"']+)["'][^>]+type=["']image\//i);
    if (encMatch) return decodeHtml(encMatch[1]).trim();
    const imgMatch = String(block || "").match(/<img[^>]+src=["'](https?:\/\/[^"']+)["']/i);
    if (imgMatch) return decodeHtml(imgMatch[1]).trim();
    return "";
  }

  function extractCurlFailure(output) {
    const text = String(output || "").trim();
    if (!text) return "";

    const failureLine = text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => /curl:\s*\(\d+\)|Could not resolve host|Failed to connect|Connection refused|proxyconnect|timed out|Connection reset|SSL|Empty reply from server/i.test(line));

    return failureLine || "";
  }

  function parseDuckDuckGoResults(html, numResults) {
    const results = [];
    const regex = /<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let match;

    while ((match = regex.exec(html)) !== null && results.length < numResults) {
      const href = match[1].replace(/\/\/duckduckgo\.com\/l\/\?uddg=/, "").split("&")[0];
      const title = stripTags(match[2]).trim();
      const snippet = stripTags(match[3]).trim();
      try {
        results.push({ title, url: decodeURIComponent(href), snippet });
      } catch {
        results.push({ title, url: href, snippet });
      }
    }

    return results.filter((result) => result.title && result.url);
  }

  function parseBingSearchResults(html, numResults) {
    const results = [];
    const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) || [];

    for (const block of blocks) {
      if (results.length >= numResults) break;
      const titleMatch = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      if (!titleMatch) continue;

      const snippetMatch = block.match(/<div class="b_caption"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i)
        || block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);

      results.push({
        title: stripTags(titleMatch[2]).trim(),
        url: decodeHtml(titleMatch[1]).trim(),
        snippet: stripTags(snippetMatch ? snippetMatch[1] : "").trim(),
      });
    }

    return results.filter((result) => result.title && /^https?:\/\//i.test(result.url));
  }

  async function searchNews(query, numResults = 5) {
    const limitedResults = Math.max(1, Math.min(Number(numResults) || 5, 8));

    // Try Bing News RSS first (has thumbnails built-in)
    try {
      const bingUrl = `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss`;
      const bingRss = await execAsync(
        `curl -Ls --max-time 15 -H "User-Agent: Mozilla/5.0" "${bingUrl}"`,
        { timeout: 20000, cwd: paths.sharedDir }
      );
      const bingFailure = extractCurlFailure(bingRss);
      if (bingFailure) throw new Error(bingFailure);

      if (bingRss.includes("<item>")) {
        const items = [];
        const itemRegex = /<item>([\s\S]*?)<\/item>/g;
        let match;
        while ((match = itemRegex.exec(bingRss)) !== null && items.length < limitedResults) {
          const block = match[1];
          const title = stripTags(extractTag(block, "title")).trim();
          const bingLink = extractTag(block, "link");
          const realUrl = extractBingRealUrl(bingLink) || bingLink;
          const summary = stripTags(extractTag(block, "description"));
          const publishedAt = formatNewsDate(extractTag(block, "pubDate"));
          const imageUrl = extractBingImageUrl(block);
          const sourceMatch = block.match(/<News:Source>([^<]+)<\/News:Source>/i);
          const source = sourceMatch ? decodeHtml(sourceMatch[1]).trim() : "";
          items.push({ title, source, summary: summary || "暂无摘要", publishedAt, url: realUrl, imageUrl });
        }
        if (items.length > 0) return items;
      }
    } catch (err) {
      console.error("[News] Bing RSS failed, falling back to Google:", err.message);
    }

    // Fallback: Google News RSS
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`;
    const rss = await execAsync(`curl -Ls --max-time 20 "${rssUrl}"`, { timeout: 25000, cwd: paths.sharedDir });
    const rssFailure = extractCurlFailure(rss);
    if (rssFailure) throw new Error(rssFailure);
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;

    while ((match = itemRegex.exec(rss)) !== null && items.length < limitedResults) {
      const block = match[1];
      const title = stripTags(extractTag(block, "title")).replace(/\s+-\s+[^-]+$/, "").trim();
      const source = extractSource(block);
      const googleUrl = extractTag(block, "link");
      const summary = stripTags(extractTag(block, "description"));
      const publishedAt = formatNewsDate(extractTag(block, "pubDate"));
      const rssImage = extractRssImage(block);
      items.push({ title, source: source.name, summary: summary || "暂无摘要", publishedAt, googleUrl, rssImage });
    }

    // Resolve Google URLs and fetch images in parallel
    const cards = await Promise.all(items.map(async (item) => {
      const finalUrl = await resolveFinalUrl(item.googleUrl);
      const imageUrl = item.rssImage || await fetchPreviewImage(finalUrl);
      return { title: item.title, source: item.source, summary: item.summary, publishedAt: item.publishedAt, url: finalUrl || item.googleUrl, imageUrl };
    }));

    return cards;
  }

  const TOOL_TIMEOUTS = {
    bash: 120000,
    read_url: 20000,
    read_url: 20000,
    download_media: 60000,
    convert_media: 60000,
    schedule_task: 30000,
  };
  const DEFAULT_TOOL_TIMEOUT = 30000;

  async function executeWithTimeout(block, activeProcesses) {
    const timeout = TOOL_TIMEOUTS[block.name] || DEFAULT_TOOL_TIMEOUT;
    const start = Date.now();
    try {
      const result = await Promise.race([
        execute(block, activeProcesses),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Tool "${block.name}" timed out after ${timeout / 1000}s`)), timeout)),
      ]);
      console.log(`[Tool] ${block.name} done in ${Date.now() - start}ms`);
      return result;
    } catch (err) {
      console.error(`[Tool] ${block.name} failed: ${err.message}`);
      return { type: "tool_result", tool_use_id: block.id, content: `Error: ${err.message}`, is_error: true };
    }
  }

  async function execute(block, activeProcesses) {
    if (block.name === "bash") {
      emitCommand(block.input.command, describeShellCommand(block.input.command), block.input.command);
      const promise = execAsync(block.input.command, { cwd: block.input.cwd || paths.sharedDir });
      if (promise.child) activeProcesses.push(promise.child);
      const output = await promise;
      if (promise.child) activeProcesses.splice(activeProcesses.indexOf(promise.child), 1);
      if (output.trim()) emit({ type: "command_output", output: output.slice(0, 5000) });
      rememberShellTask(block.input.command, output);
      return { type: "tool_result", tool_use_id: block.id, content: output.slice(0, 10000) };
    }

    if (block.name === "send_file") {
      const filename = block.input.filename;
      const filePath = safePath(paths.sharedDir, filename);
      if (!filePath) return { type: "tool_result", tool_use_id: block.id, content: "Invalid filename", is_error: true };
      if (!fs.existsSync(filePath)) return { type: "tool_result", tool_use_id: block.id, content: `"${filename}" not found.`, is_error: true };
      emitFile(filename, filePath);
      rememberTask(`task:send-file:${filename}`, `已把文件 ${filename} 发给用户。`, ["file_send"]);
      rememberArtifact(filename, `这个文件已经发给过用户：${filename}`, ["shared_file"], { kind: getFileType(filename), origin: "send_file" });
      return { type: "tool_result", tool_use_id: block.id, content: `File "${filename}" sent.` };
    }

    if (block.name === "apple_reminders") {
      const { action, title, list: listName = "提醒事项", due_date, notes } = block.input;
      try {
        if (action === "list") {
          const script = `
            tell application "Reminders"
              set output to ""
              try
                set theList to list "${listName}"
              on error
                set theList to default list
              end try
              set theReminders to (every reminder of theList whose completed is false)
              repeat with r in theReminders
                set dueStr to ""
                try
                  set dueStr to " [" & (due date of r as string) & "]"
                end try
                set output to output & name of r & dueStr & linefeed
              end repeat
              if output is "" then return "No incomplete reminders."
              return output
            end tell`;
          emitCommand("apple_reminders:list", "查看提醒", listName);
          const result = await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 10000, cwd: paths.sharedDir });
          return { type: "tool_result", tool_use_id: block.id, content: result.trim() || "No reminders found." };
        }
        if (action === "add" && title) {
          let dateClause = "";
          if (due_date) {
            // Parse YYYY-MM-DD or YYYY-MM-DD HH:mm
            const parts = due_date.split(" ");
            const [y, m, d] = parts[0].split("-");
            if (parts[1]) {
              const [hh, mm] = parts[1].split(":");
              dateClause = `set due date of newReminder to date "${m}/${d}/${y} ${hh}:${mm}:00"`;
            } else {
              dateClause = `set due date of newReminder to date "${m}/${d}/${y} 09:00:00"`;
            }
          }
          const notesClause = notes ? `set body of newReminder to "${notes.replace(/"/g, '\\"')}"` : "";
          const script = `
            tell application "Reminders"
              try
                set theList to list "${listName}"
              on error
                set theList to default list
              end try
              set newReminder to make new reminder at end of theList with properties {name:"${title.replace(/"/g, '\\"')}"}
              ${dateClause}
              ${notesClause}
              return "OK"
            end tell`;
          emitCommand("apple_reminders:add", "添加提醒", title);
          await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 10000, cwd: paths.sharedDir });
          const dueInfo = due_date ? ` (due: ${due_date})` : "";
          return { type: "tool_result", tool_use_id: block.id, content: `Reminder added: "${title}"${dueInfo} in list "${listName}"` };
        }
        if (action === "complete" && title) {
          const script = `
            tell application "Reminders"
              try
                set theList to list "${listName}"
              on error
                set theList to default list
              end try
              set theReminders to (every reminder of theList whose name is "${title.replace(/"/g, '\\"')}" and completed is false)
              if (count of theReminders) > 0 then
                set completed of item 1 of theReminders to true
                return "OK"
              else
                return "NOT_FOUND"
              end if
            end tell`;
          emitCommand("apple_reminders:complete", "完成提醒", title);
          const result = await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 10000, cwd: paths.sharedDir });
          if (result.trim() === "NOT_FOUND") return { type: "tool_result", tool_use_id: block.id, content: `Reminder "${title}" not found.`, is_error: true };
          return { type: "tool_result", tool_use_id: block.id, content: `Reminder "${title}" completed.` };
        }
        if (action === "delete" && title) {
          const script = `
            tell application "Reminders"
              try
                set theList to list "${listName}"
              on error
                set theList to default list
              end try
              set theReminders to (every reminder of theList whose name is "${title.replace(/"/g, '\\"')}")
              if (count of theReminders) > 0 then
                delete item 1 of theReminders
                return "OK"
              else
                return "NOT_FOUND"
              end if
            end tell`;
          emitCommand("apple_reminders:delete", "删除提醒", title);
          const result = await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 10000, cwd: paths.sharedDir });
          if (result.trim() === "NOT_FOUND") return { type: "tool_result", tool_use_id: block.id, content: `Reminder "${title}" not found.`, is_error: true };
          return { type: "tool_result", tool_use_id: block.id, content: `Reminder "${title}" deleted.` };
        }
        return { type: "tool_result", tool_use_id: block.id, content: "Missing required parameter: title", is_error: true };
      } catch (error) {
        return { type: "tool_result", tool_use_id: block.id, content: `Error: ${error.message}`, is_error: true };
      }
    }

    if (block.name === "apple_notes") {
      const { action, title, body, folder = "Notes", query } = block.input;
      try {
        if (action === "list") {
          const script = `
            tell application "Notes"
              set output to ""
              try
                set theFolder to folder "${folder}"
                set theNotes to every note of theFolder
              on error
                set theNotes to every note of default account
              end try
              set maxCount to 30
              set i to 0
              repeat with n in theNotes
                set i to i + 1
                if i > maxCount then exit repeat
                set output to output & name of n & " (" & (modification date of n as string) & ")" & linefeed
              end repeat
              if output is "" then return "No notes found."
              return output
            end tell`;
          emitCommand("apple_notes:list", "查看备忘录", folder);
          const result = await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 10000, cwd: paths.sharedDir });
          return { type: "tool_result", tool_use_id: block.id, content: result.trim() || "No notes found." };
        }
        if (action === "create" && title) {
          const htmlBody = (body || "").replace(/"/g, '\\"').replace(/\n/g, "<br>");
          const script = `
            tell application "Notes"
              try
                set theFolder to folder "${folder}"
              on error
                set theFolder to default account
              end try
              make new note at theFolder with properties {name:"${title.replace(/"/g, '\\"')}", body:"<h1>${title.replace(/"/g, '\\"')}</h1>${htmlBody ? "<br>" + htmlBody : ""}"}
              return "OK"
            end tell`;
          emitCommand("apple_notes:create", "创建备忘录", title);
          await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 10000, cwd: paths.sharedDir });
          return { type: "tool_result", tool_use_id: block.id, content: `Note created: "${title}" in folder "${folder}"` };
        }
        if (action === "read" && title) {
          const script = `
            tell application "Notes"
              set theNotes to every note whose name is "${title.replace(/"/g, '\\"')}"
              if (count of theNotes) > 0 then
                set n to item 1 of theNotes
                set noteBody to plaintext of n
                return name of n & linefeed & "---" & linefeed & noteBody
              else
                return "NOT_FOUND"
              end if
            end tell`;
          emitCommand("apple_notes:read", "读取备忘录", title);
          const result = await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 10000, cwd: paths.sharedDir });
          if (result.trim() === "NOT_FOUND") return { type: "tool_result", tool_use_id: block.id, content: `Note "${title}" not found.`, is_error: true };
          return { type: "tool_result", tool_use_id: block.id, content: result.trim().slice(0, 10000) };
        }
        if (action === "search" && query) {
          const script = `
            tell application "Notes"
              set output to ""
              set allNotes to every note whose name contains "${query.replace(/"/g, '\\"')}"
              set maxCount to 10
              set i to 0
              repeat with n in allNotes
                set i to i + 1
                if i > maxCount then exit repeat
                set output to output & name of n & " (" & (modification date of n as string) & ")" & linefeed
              end repeat
              if output is "" then return "No notes matching query."
              return output
            end tell`;
          emitCommand("apple_notes:search", "搜索备忘录", query);
          const result = await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 10000, cwd: paths.sharedDir });
          return { type: "tool_result", tool_use_id: block.id, content: result.trim() || "No notes found." };
        }
        return { type: "tool_result", tool_use_id: block.id, content: "Missing required parameter.", is_error: true };
      } catch (error) {
        return { type: "tool_result", tool_use_id: block.id, content: `Error: ${error.message}`, is_error: true };
      }
    }

    if (block.name === "apple_clock") {
      const { action, time, label = "Her Timer", seconds } = block.input;
      try {
        if (action === "set_timer" && seconds) {
          // Use macOS schedule a notification after delay
          const mins = Math.ceil(seconds / 60);
          const command = `(sleep ${seconds} && osascript -e 'display notification "${label}" with title "Her Timer" sound name "Glass"' && afplay /System/Library/Sounds/Glass.aiff) &
echo "Timer set: ${label} (${seconds}s)"`;
          emitCommand("apple_clock:timer", "设置计时器", `${label} - ${mins}min`);
          const result = await execAsync(command, { timeout: 5000, cwd: paths.sharedDir });
          return { type: "tool_result", tool_use_id: block.id, content: `Timer set: "${label}" will fire in ${seconds} seconds (${mins} min).` };
        }
        if (action === "set_alarm" && time) {
          // Calculate seconds until the alarm time
          const script = `
            set now to current date
            set alarmTime to current date
            set hours of alarmTime to ${parseInt(time.split(":")[0])}
            set minutes of alarmTime to ${parseInt(time.split(":")[1])}
            set seconds of alarmTime to 0
            if alarmTime < now then set alarmTime to alarmTime + 86400
            set diff to (alarmTime - now) as integer
            return diff`;
          emitCommand("apple_clock:alarm", "设置闹钟", `${time} - ${label}`);
          const diffStr = await execAsync(`osascript -e '${script}'`, { timeout: 5000, cwd: paths.sharedDir });
          const diff = parseInt(diffStr.trim());
          if (isNaN(diff) || diff <= 0) return { type: "tool_result", tool_use_id: block.id, content: "Invalid time.", is_error: true };
          const alarmCmd = `(sleep ${diff} && osascript -e 'display notification "${label}" with title "Her Alarm" sound name "Glass"' && afplay /System/Library/Sounds/Glass.aiff) &
echo "Alarm set"`;
          await execAsync(alarmCmd, { timeout: 5000, cwd: paths.sharedDir });
          const hours = Math.floor(diff / 3600);
          const mins = Math.floor((diff % 3600) / 60);
          return { type: "tool_result", tool_use_id: block.id, content: `Alarm set: "${label}" at ${time} (in ${hours}h ${mins}m).` };
        }
        if (action === "list_alarms") {
          // List background sleep processes (our alarms/timers)
          const result = await execAsync(`ps aux | grep '[s]leep' | grep -v 'grep' | head -10`, { timeout: 5000, cwd: paths.sharedDir });
          if (!result.trim()) return { type: "tool_result", tool_use_id: block.id, content: "No active alarms or timers." };
          return { type: "tool_result", tool_use_id: block.id, content: result.trim() };
        }
        return { type: "tool_result", tool_use_id: block.id, content: "Missing required parameter.", is_error: true };
      } catch (error) {
        return { type: "tool_result", tool_use_id: block.id, content: `Error: ${error.message}`, is_error: true };
      }
    }

    if (block.name === "create_pptx") {
      const { filename, slides, ...rest } = block.input;
      const outPath = safePath(paths.sharedDir, filename);
      if (!outPath) return { type: "tool_result", tool_use_id: block.id, content: "Invalid filename", is_error: true };
      const scriptPath = path.join(__dirname, "make_pptx.py");
      const jsonData = JSON.stringify({ ...rest, slides });
      emitCommand("create_pptx", "创建 PPT", filename);
      try {
        const tmpJson = path.join(paths.sharedDir, `.tmp_pptx_${Date.now()}.json`);
        fs.writeFileSync(tmpJson, jsonData, "utf-8");
        await execAsync(`python3 "${scriptPath}" "${outPath}" < "${tmpJson}"`, { timeout: 30000, cwd: paths.sharedDir });
        fs.unlinkSync(tmpJson);
        if (fs.existsSync(outPath)) {
          emitFile(filename, outPath);
          return { type: "tool_result", tool_use_id: block.id, content: `PPT created: ${filename} (${slides.length} slides)` };
        }
        return { type: "tool_result", tool_use_id: block.id, content: "Failed to create PPT", is_error: true };
      } catch (error) {
        return { type: "tool_result", tool_use_id: block.id, content: `Error: ${error.message}`, is_error: true };
      }
    }

    if (block.name === "create_docx") {
      const { filename, sections, ...rest } = block.input;
      const outPath = safePath(paths.sharedDir, filename);
      if (!outPath) return { type: "tool_result", tool_use_id: block.id, content: "Invalid filename", is_error: true };
      const scriptPath = path.join(__dirname, "make_docx.py");
      const jsonData = JSON.stringify({ ...rest, sections });
      emitCommand("create_docx", "创建 Word", filename);
      try {
        const tmpJson = path.join(paths.sharedDir, `.tmp_docx_${Date.now()}.json`);
        fs.writeFileSync(tmpJson, jsonData, "utf-8");
        await execAsync(`python3 "${scriptPath}" "${outPath}" < "${tmpJson}"`, { timeout: 30000, cwd: paths.sharedDir });
        fs.unlinkSync(tmpJson);
        if (fs.existsSync(outPath)) {
          emitFile(filename, outPath);
          return { type: "tool_result", tool_use_id: block.id, content: `Word document created: ${filename} (${sections.length} sections)` };
        }
        return { type: "tool_result", tool_use_id: block.id, content: "Failed to create Word document", is_error: true };
      } catch (error) {
        return { type: "tool_result", tool_use_id: block.id, content: `Error: ${error.message}`, is_error: true };
      }
    }

    if (block.name === "create_xlsx") {
      const { filename, sheets, ...rest } = block.input;
      const outPath = safePath(paths.sharedDir, filename);
      if (!outPath) return { type: "tool_result", tool_use_id: block.id, content: "Invalid filename", is_error: true };
      const scriptPath = path.join(__dirname, "make_xlsx.py");
      const jsonData = JSON.stringify({ ...rest, sheets });
      emitCommand("create_xlsx", "创建 Excel", filename);
      try {
        const tmpJson = path.join(paths.sharedDir, `.tmp_xlsx_${Date.now()}.json`);
        fs.writeFileSync(tmpJson, jsonData, "utf-8");
        await execAsync(`python3 "${scriptPath}" "${outPath}" < "${tmpJson}"`, { timeout: 30000, cwd: paths.sharedDir });
        fs.unlinkSync(tmpJson);
        if (fs.existsSync(outPath)) {
          emitFile(filename, outPath);
          return { type: "tool_result", tool_use_id: block.id, content: `Excel created: ${filename} (${sheets.length} sheets)` };
        }
        return { type: "tool_result", tool_use_id: block.id, content: "Failed to create Excel", is_error: true };
      } catch (error) {
        return { type: "tool_result", tool_use_id: block.id, content: `Error: ${error.message}`, is_error: true };
      }
    }

    if (block.name === "download_media") {
      const { url, format = "video", quality = "best" } = block.input;
      if (!/^https?:\/\//i.test(url)) {
        return { type: "tool_result", tool_use_id: block.id, content: "Invalid URL", is_error: true };
      }
      const safeUrl = url.replace(/[`$(){}|;&]/g, "");
      let command;
      if (format === "audio") {
        command = `yt-dlp -x --audio-format mp3 --audio-quality 0 -o "${paths.sharedDir}/%(title)s.%(ext)s" --no-playlist --print filename "${safeUrl}"`;
      } else {
        const qualityMap = {
          best: "bestvideo+bestaudio/best",
          "720p": "bestvideo[height<=720]+bestaudio/best[height<=720]",
          "480p": "bestvideo[height<=480]+bestaudio/best[height<=480]",
        };
        const formatSpec = qualityMap[quality] || qualityMap.best;
        command = `yt-dlp -f "${formatSpec}" --merge-output-format mp4 -o "${paths.sharedDir}/%(title)s.%(ext)s" --no-playlist --print filename "${safeUrl}"`;
      }

      emitCommand(command, "下载媒体", `${format} · ${url}`);
      const promise = execAsync(command, { timeout: 600000, cwd: paths.sharedDir });
      if (promise.child) activeProcesses.push(promise.child);
      const output = await promise;
      if (promise.child) activeProcesses.splice(activeProcesses.indexOf(promise.child), 1);

      const lines = output.trim().split("\n");
      const filename = path.basename(lines[lines.length - 1].trim());
      const filePath = safePath(paths.sharedDir, filename);
      if (filePath && fs.existsSync(filePath)) {
        emitFile(filename, filePath);
        rememberTask(
          `task:download-media:${filename}`,
          `已为用户下载${format === "audio" ? "音频" : "视频"} ${filename}，来源 ${url}。`,
          ["media", format === "audio" ? "audio" : "video"]
        );
        rememberArtifact(
          filename,
          `这是我替用户下载的${format === "audio" ? "音频" : "视频"}文件 ${filename}，来源 ${url}。`,
          ["media", format === "audio" ? "audio" : "video"],
          { kind: format === "audio" ? "audio" : "video", origin: "download_media", sourceUrl: url }
        );
        return { type: "tool_result", tool_use_id: block.id, content: `Downloaded and displayed: ${filename}. Do NOT call send_file — it's already shown to the user.` };
      }
      return { type: "tool_result", tool_use_id: block.id, content: `Download output:\n${output.slice(0, 3000)}` };
    }

    if (block.name === "convert_media") {
      const { input: inputFile, output: outputFile, options = "" } = block.input;
      const inputPath = safePath(paths.sharedDir, inputFile);
      const outputPath = safePath(paths.sharedDir, outputFile);
      if (!inputPath || !outputPath) return { type: "tool_result", tool_use_id: block.id, content: "Invalid file path", is_error: true };
      if (!fs.existsSync(inputPath)) return { type: "tool_result", tool_use_id: block.id, content: "Input file not found", is_error: true };

      const command = `ffmpeg -y -i "${inputPath}" ${options} "${outputPath}"`;
      emitCommand(command, "处理媒体", `${inputFile} -> ${outputFile}`);
      const promise = execAsync(command, { timeout: 600000, cwd: paths.sharedDir });
      if (promise.child) activeProcesses.push(promise.child);
      const output = await promise;
      if (promise.child) activeProcesses.splice(activeProcesses.indexOf(promise.child), 1);

      if (fs.existsSync(outputPath)) {
        emitFile(outputFile, outputPath);
        rememberTask(
          `task:convert-media:${outputFile}`,
          `已把媒体文件 ${inputFile} 转换为 ${outputFile}。`,
          ["media", "convert"]
        );
        rememberArtifact(
          outputFile,
          `这是我处理后生成的媒体文件 ${outputFile}，由 ${inputFile} 转换而来。`,
          ["media", "convert"],
          { kind: getFileType(outputFile), origin: "convert_media", sourceFile: inputFile }
        );
        return { type: "tool_result", tool_use_id: block.id, content: `Converted: ${outputFile}` };
      }
      return { type: "tool_result", tool_use_id: block.id, content: `ffmpeg output:\n${output.slice(0, 3000)}` };
    }

    if (block.name === "recent_files") {
      const days = Math.min(block.input.days || 1, 7);
      const limit = Math.min(block.input.limit || 20, 50);
      const folder = block.input.folder || process.env.HOME || "/Users";
      emitCommand("recent_files", "查看最近文件", `${days}天内`);
      try {
        const cmd = `mdfind 'kMDItemFSContentChangeDate >= $time.today(-${days})' -onlyin "${folder}" 2>/dev/null | grep -v '/Library/' | grep -v '/\\.' | grep -v 'node_modules' | grep -v '__pycache__' | head -${limit}`;
        const raw = await execAsync(cmd, { timeout: 10000 });
        const files = raw.trim().split("\n").filter(Boolean);
        if (files.length === 0) return { type: "tool_result", tool_use_id: block.id, content: "No recently modified files found." };
        return { type: "tool_result", tool_use_id: block.id, content: `Recently modified files (last ${days} day${days > 1 ? "s" : ""}):\n${files.join("\n")}` };
      } catch (err) {
        return { type: "tool_result", tool_use_id: block.id, content: `Error: ${err.message}`, is_error: true };
      }
    }

    if (block.name === "read_url") {
      emitCommand(`read_url: ${block.input.url}`, "读取网页", block.input.url);
      try {
        const proxyUrl = `http://43.134.52.155:3941/read?url=${encodeURIComponent(block.input.url)}`;
        const raw = await execAsync(`curl -sL --max-time 20 "${proxyUrl}"`, { timeout: 25000 });
        const data = JSON.parse(raw);
        const text = (data.text || "").trim();
        if (!text || text.startsWith("Error:")) {
          return { type: "tool_result", tool_use_id: block.id, content: text || "Could not extract text.", is_error: true };
        }
        return { type: "tool_result", tool_use_id: block.id, content: text.slice(0, 15000) };
      } catch (error) {
        return { type: "tool_result", tool_use_id: block.id, content: `Read failed: ${error.message}`, is_error: true };
      }
    }

    if (block.name === "web_search") {
      emitCommand("web_search", "搜索网页", block.input.query);
      try {
        const settings = stores.settingsStore.get();
        const searchKey = settings.searchApiKey;
        if (!searchKey) {
          return { type: "tool_result", tool_use_id: block.id, content: "Web search not configured. Please add an Anthropic API key for search in Settings.", is_error: true };
        }
        const Anthropic = require("@anthropic-ai/sdk");
        const client = new Anthropic({ apiKey: searchKey });
        const response = await client.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1024,
          tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
          messages: [{ role: "user", content: block.input.query }],
        });
        // Extract text from response (search results are woven into the text)
        const text = response.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n");
        return { type: "tool_result", tool_use_id: block.id, content: text.slice(0, 10000) || "No results found." };
      } catch (error) {
        return { type: "tool_result", tool_use_id: block.id, content: `Search failed: ${error.message}`, is_error: true };
      }
    }

    if (block.name === "schedule_task") {
      try {
        const result = scheduleService.schedule(block.input);
        return { type: "tool_result", tool_use_id: block.id, content: result.message };
      } catch (error) {
        return { type: "tool_result", tool_use_id: block.id, content: error.message, is_error: true };
      }
    }

    if (block.name === "read_file") {
      const filePath = block.input.path;
      emitCommand(`read_file: ${filePath}`, "查看文件", path.basename(filePath) || filePath);
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const lines = content.split("\n");
        const start = Math.max(0, (block.input.offset || 1) - 1);
        const end = Math.min(lines.length, start + (block.input.limit || 500));
        const numbered = lines.slice(start, end).map((line, index) => `${String(start + index + 1).padStart(6)}|${line}`).join("\n");
        if (numbered.trim()) emit({ type: "command_output", output: numbered.slice(0, 5000) });
        return { type: "tool_result", tool_use_id: block.id, content: `Lines ${start + 1}-${end} of ${lines.length}\n${numbered.slice(0, 15000)}` };
      } catch (error) {
        return { type: "tool_result", tool_use_id: block.id, content: `Error: ${error.message}`, is_error: true };
      }
    }

    if (block.name === "write_file") {
      const filePath = block.input.path;
      emitCommand(`write_file: ${filePath}`, "写入文件", path.basename(filePath) || filePath);
      try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, block.input.content, "utf-8");
        const result = `Written: ${filePath} (${block.input.content.split("\n").length} lines)`;
        emit({ type: "command_output", output: result });
        return { type: "tool_result", tool_use_id: block.id, content: result };
      } catch (error) {
        return { type: "tool_result", tool_use_id: block.id, content: `Error: ${error.message}`, is_error: true };
      }
    }

    if (block.name === "edit_file") {
      const filePath = block.input.path;
      emitCommand(`edit_file: ${filePath}`, "修改文件", path.basename(filePath) || filePath);
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const count = content.split(block.input.old_string).length - 1;
        if (count === 0) {
          return { type: "tool_result", tool_use_id: block.id, content: "old_string not found. Read file first.", is_error: true };
        }
        if (count > 1) {
          return { type: "tool_result", tool_use_id: block.id, content: `old_string found ${count} times — must be unique.`, is_error: true };
        }
        fs.writeFileSync(filePath, content.replace(block.input.old_string, block.input.new_string), "utf-8");
        emit({ type: "command_output", output: `Edit applied to ${filePath}` });
        return { type: "tool_result", tool_use_id: block.id, content: `Edit applied to ${filePath}` };
      } catch (error) {
        return { type: "tool_result", tool_use_id: block.id, content: `Error: ${error.message}`, is_error: true };
      }
    }

    if (block.name === "glob") {
      const searchDir = block.input.path || require("os").homedir();
      const namePattern = block.input.pattern.includes("/") ? block.input.pattern.split("/").pop() : block.input.pattern;
      emitCommand(`glob: ${block.input.pattern} in ${searchDir}`, "搜索文件", block.input.pattern);
      const command = `find "${searchDir}" -name "${namePattern}" -type f 2>/dev/null | head -100`;
      const output = await execAsync(command, { cwd: paths.sharedDir });
      const result = output.trim() || "No files found.";
      emit({ type: "command_output", output: result.slice(0, 5000) });
      return { type: "tool_result", tool_use_id: block.id, content: result.slice(0, 10000) };
    }

    if (block.name === "grep") {
      const dir = block.input.path || require("os").homedir();
      const includeFlag = block.input.include ? `--include="${block.input.include}"` : "";
      emitCommand(`grep: "${block.input.pattern}" in ${dir}`, "搜索内容", block.input.pattern);
      const command = `grep -rn ${includeFlag} "${block.input.pattern}" "${dir}" 2>/dev/null | head -200`;
      const output = await execAsync(command, { cwd: paths.sharedDir });
      const result = output.trim() || "No matches found.";
      emit({ type: "command_output", output: result.slice(0, 5000) });
      return { type: "tool_result", tool_use_id: block.id, content: result.slice(0, 10000) };
    }

    if (block.name === "todo") {
      const { action, title, detail, due_date, expires_at } = block.input;
      if (action === "add" && title) {
        const item = todoStore.add(title, detail || "", due_date || "", expires_at || "");
        emit({ type: "todo_updated" });
        return { type: "tool_result", tool_use_id: block.id, content: `Todo added: "${title}"${due_date ? ` (${due_date})` : ""}` };
      }
      if (action === "complete" && title) {
        const item = todoStore.complete(title);
        if (!item) return { type: "tool_result", tool_use_id: block.id, content: `Todo "${title}" not found.`, is_error: true };
        emit({ type: "todo_updated" });
        return { type: "tool_result", tool_use_id: block.id, content: `Todo "${item.title}" completed.` };
      }
      if (action === "remove" && title) {
        const item = todoStore.remove(title);
        if (!item) return { type: "tool_result", tool_use_id: block.id, content: `Todo "${title}" not found.`, is_error: true };
        emit({ type: "todo_updated" });
        return { type: "tool_result", tool_use_id: block.id, content: `Todo "${item.title}" removed.` };
      }
      if (action === "list") {
        const todos = todoStore.list();
        if (todos.length === 0) return { type: "tool_result", tool_use_id: block.id, content: "No pending todos." };
        const list = todos.map((t, i) => `${i + 1}. ${t.title}${t.dueDate ? ` (${t.dueDate})` : ""}${t.detail ? ` — ${t.detail}` : ""}`).join("\n");
        return { type: "tool_result", tool_use_id: block.id, content: list };
      }
      return { type: "tool_result", tool_use_id: block.id, content: "Missing title.", is_error: true };
    }

    if (block.name === "memory") {
      const { action, key, value, query } = block.input;
      if (action === "save" && key && value) {
        memoryStore.saveEntry(key, value);
        emit({ type: "memory_saved", key, value });
        return { type: "tool_result", tool_use_id: block.id, content: `Memory saved: ${key} = ${value}` };
      }
      if (action === "delete" && key) {
        const before = memoryStore.list().length;
        memoryStore.deleteEntry(key);
        const after = memoryStore.list().length;
        return {
          type: "tool_result",
          tool_use_id: block.id,
          content: after < before ? `Deleted: ${key}` : `"${key}" not found.`,
        };
      }
      if (action === "list") {
        const memories = memoryStore.list();
        return {
          type: "tool_result",
          tool_use_id: block.id,
          content: memories.length === 0
            ? "No memories."
            : memories
              .sort((a, b) => new Date(b.updated || b.saved || 0) - new Date(a.updated || a.saved || 0))
              .map((memory) => `[${(memory.tags || []).join(",")}] ${memory.key}: ${memory.value}`)
              .join("\n"),
        };
      }
      if (action === "search" && (query || key)) {
        const found = memoryStore.search(query || key);
        return {
          type: "tool_result",
          tool_use_id: block.id,
          content: found.length === 0
            ? `No memories matching "${query || key}".`
            : found.map((memory) => `[${(memory.tags || []).join(",")}] ${memory.key}: ${memory.value}`).join("\n"),
        };
      }
      return { type: "tool_result", tool_use_id: block.id, content: "Invalid action. Use: save, delete, list, search." };
    }

    return { type: "tool_result", tool_use_id: block.id, content: "Unknown tool", is_error: true };
  }

  return { tools, execute: executeWithTimeout, processScheduleOutput };
}

module.exports = { createTools };
