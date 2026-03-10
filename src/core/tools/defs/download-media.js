const fs = require("fs");
const path = require("path");
const { BaseTool } = require("../base-tool");
const { safePath, getFileType } = require("../helpers");

class DownloadMediaTool extends BaseTool {
  get name() { return "download_media"; }
  get timeout() { return 600000; }
  get description() { return "Download video or audio from YouTube, Bilibili, Twitter, TikTok, and 1000+ sites using yt-dlp."; }
  get input_schema() {
    return {
      type: "object",
      properties: {
        url: { type: "string", description: "URL of the video/audio" },
        format: { type: "string", enum: ["video", "audio"], description: "Download as video or audio. Default: video" },
        quality: { type: "string", description: "Quality: best, 720p, 480p. Default: best" },
      },
      required: ["url"],
    };
  }

  async execute(input, ctx) {
    const { url, format = "video", quality = "best" } = input;
    if (!/^https?:\/\//i.test(url)) return { content: "Invalid URL", is_error: true };
    const safeUrl = url.replace(/[`$(){}|;&]/g, "");

    let command;
    if (format === "audio") {
      command = `yt-dlp -x --audio-format mp3 --audio-quality 0 -o "${ctx.paths.sharedDir}/%(title)s.%(ext)s" --no-playlist --print filename "${safeUrl}"`;
    } else {
      const qualityMap = {
        best: "bestvideo+bestaudio/best",
        "720p": "bestvideo[height<=720]+bestaudio/best[height<=720]",
        "480p": "bestvideo[height<=480]+bestaudio/best[height<=480]",
      };
      const formatSpec = qualityMap[quality] || qualityMap.best;
      command = `yt-dlp -f "${formatSpec}" --merge-output-format mp4 -o "${ctx.paths.sharedDir}/%(title)s.%(ext)s" --no-playlist --print filename "${safeUrl}"`;
    }

    ctx.emitCommand(command, "下载媒体", `${format} · ${url}`);
    const promise = ctx.execAsync(command, { timeout: 600000, cwd: ctx.paths.sharedDir });
    if (promise.child) ctx.activeProcesses.push(promise.child);
    const output = await promise;
    if (promise.child) ctx.activeProcesses.splice(ctx.activeProcesses.indexOf(promise.child), 1);

    const lines = output.trim().split("\n");
    const filename = path.basename(lines[lines.length - 1].trim());
    const filePath = safePath(ctx.paths.sharedDir, filename);
    if (filePath && fs.existsSync(filePath)) {
      ctx.emitFile(filename, filePath);
      ctx.rememberTask(`task:download-media:${filename}`, `已为用户下载${format === "audio" ? "音频" : "视频"} ${filename}，来源 ${url}。`, ["media", format === "audio" ? "audio" : "video"]);
      ctx.rememberArtifact(filename, `这是我替用户下载的${format === "audio" ? "音频" : "视频"}文件 ${filename}，来源 ${url}。`, ["media", format === "audio" ? "audio" : "video"], { kind: format === "audio" ? "audio" : "video", origin: "download_media", sourceUrl: url });
      return `Downloaded: ${filename}`;
    }
    return `Download output:\n${output.slice(0, 3000)}`;
  }
}

module.exports = DownloadMediaTool;
