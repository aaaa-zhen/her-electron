function clipText(text, limit = 72) {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.length > limit ? `${compact.slice(0, limit)}...` : compact;
}

function toPlainText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function hasRenderableAssistantText(content) {
  if (typeof content === "string") return Boolean(content.trim());
  if (!Array.isArray(content)) return false;
  return content.some((block) => block.type === "text" && String(block.text || "").trim());
}

function sanitizeJsonString(value) {
  return String(value || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "\uFFFD")
    .replace(/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "$1\uFFFD");
}

function sanitizeForJson(value) {
  if (typeof value === "string") return sanitizeJsonString(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeForJson(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, sanitizeForJson(nested)])
    );
  }
  return value;
}

function getMessageText(message, images) {
  const cleaned = (message || "").trim();
  if (cleaned) return cleaned;
  if (images && images.length > 0) {
    const filenames = images.map((image) => image.filename).filter(Boolean);
    if (filenames.length > 0) {
      const suffix = filenames.join(", ");
      return images.length === 1
        ? `用户发送了一张图片，已保存为 ${suffix}`
        : `用户发送了 ${images.length} 张图片，已保存为 ${suffix}`;
    }
    return images.length === 1 ? "用户发送了一张图片" : `用户发送了 ${images.length} 张图片`;
  }
  return "";
}

function formatPhaseDetail(text, memoryCount) {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  const preview = compact.length > 48 ? `${compact.slice(0, 48)}...` : compact;
  if (preview && memoryCount > 0) return `${preview} · 已关联 ${memoryCount} 条历史上下文`;
  if (preview) return preview;
  if (memoryCount > 0) return `已关联 ${memoryCount} 条历史上下文`;
  return "结合当前上下文组织回应";
}

function formatScheduleNote(task) {
  if (!task) return "";
  if (task.cron) return `${task.description} · cron ${task.cron}`;
  if (task.runAt) return `${task.description} · ${task.runAt}`;
  return task.description || "";
}

module.exports = {
  clipText,
  toPlainText,
  hasRenderableAssistantText,
  sanitizeJsonString,
  sanitizeForJson,
  getMessageText,
  formatPhaseDetail,
  formatScheduleNote,
};
