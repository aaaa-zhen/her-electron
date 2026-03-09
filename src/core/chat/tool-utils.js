const TOOL_LABELS = {
  bash: "执行命令",
  read_file: "查看文件",
  write_file: "写入文件",
  edit_file: "修改文件",
  glob: "搜索文件",
  grep: "搜索内容",
  send_file: "发送文件",
  schedule_task: "安排任务",
  memory: "整理记忆",
  download_media: "下载媒体",
  convert_media: "处理媒体",
  web_search: "搜索网页",
  read_url: "读取网页",
};

const MAX_TOOL_ROUNDS = 4;
const MAX_NEWS_TOOL_CALLS = 3;

function summarizeToolBlocks(toolBlocks) {
  const labels = [...new Set(
    toolBlocks
      .map((block) => TOOL_LABELS[block.name] || block.name)
      .filter(Boolean)
  )];

  if (labels.length === 0) return "准备处理请求";
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]}、${labels[1]}`;
  return `${labels[0]}、${labels[1]} 等 ${labels.length} 项操作`;
}

function isNewsTool(name) {
  return name === "web_search" || name === "read_url";
}

function looksLikeToolFailure(result) {
  if (!result) return true;
  if (result.is_error) return true;

  const text = String(result.content || "").trim();
  if (!text) return true;

  return /^(No results for:|No news found for:|Could not extract text\.?|Web search failed:|Read failed:|News search failed:|Invalid URL|Missing required parameter|Error: )/i.test(text);
}

function summarizeToolResultPreview(block, result) {
  const text = String(result && result.content ? result.content : "").trim();
  if (!text) return "";

  if (block.name === "search_news") {
    return "相关新闻结果已经展示在上面了，你可以直接点开。";
  }

  if (block.name === "search_web") {
    return `搜索结果：\n${text.slice(0, 1200)}`;
  }

  if (block.name === "read_url") {
    return `网页内容片段：\n${text.slice(0, 900)}`;
  }

  return text.slice(0, 900);
}

function buildSyntheticToolReply(toolBlocks = [], toolResults = []) {
  const pairs = toolBlocks
    .map((block, index) => ({ block, result: toolResults[index] }))
    .filter(({ block, result }) => block && result);

  const toolSummary = summarizeToolBlocks(toolBlocks);
  const successful = pairs.filter(({ result }) => !looksLikeToolFailure(result));

  if (successful.length === 0) {
    const firstFailure = pairs
      .map(({ result }) => String(result.content || "").trim())
      .find(Boolean);

    return [{
      type: "text",
      text: [
        `我刚才已经完成了${toolSummary}，但这次没拿到可用结果。`,
        firstFailure ? `原因大概是：${firstFailure.slice(0, 220)}` : "",
      ].filter(Boolean).join("\n\n"),
    }];
  }

  const previews = [];
  for (const { block, result } of successful.slice(0, 3)) {
    const preview = summarizeToolResultPreview(block, result);
    if (preview) previews.push(preview);
  }

  return [{
    type: "text",
    text: [
      `我刚才已经完成了${toolSummary}。`,
      previews.length > 0 ? `先把拿到的结果直接给你：\n\n${previews.join("\n\n")}` : "上面的步骤已经执行完了。",
    ].join("\n\n"),
  }];
}

module.exports = {
  TOOL_LABELS,
  MAX_TOOL_ROUNDS,
  MAX_NEWS_TOOL_CALLS,
  summarizeToolBlocks,
  isNewsTool,
  looksLikeToolFailure,
  summarizeToolResultPreview,
  buildSyntheticToolReply,
};
