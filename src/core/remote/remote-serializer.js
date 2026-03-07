const fs = require("fs");
const path = require("path");
const { getFileType, formatSize } = require("../tools/helpers");

function clipText(text, limit = 200) {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.length > limit ? `${compact.slice(0, limit)}...` : compact;
}

function normalizeTimestamp(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString();
}

function serializeTimelineEvent(memory) {
  if (!memory) return null;
  const timestamp = normalizeTimestamp(
    (memory.meta && memory.meta.at) || memory.updated || memory.saved || ""
  );
  return {
    key: memory.key || "",
    title: memory.meta && memory.meta.title ? memory.meta.title : clipText(memory.value || memory.key, 120),
    detail: clipText(memory.value || "", 220),
    source: memory.type === "task_history" ? "task_history" : (memory.meta && memory.meta.source) || memory.type || "memory",
    status: (memory.meta && memory.meta.status) || "known",
    at: timestamp,
    meta: memory.meta || {},
  };
}

function serializeArtifact(memory, sharedDir) {
  if (!memory || !memory.meta || !memory.meta.filename) return null;
  const filename = memory.meta.filename;
  const filePath = path.join(sharedDir, filename);
  const exists = fs.existsSync(filePath);
  const stat = exists ? fs.statSync(filePath) : null;
  return {
    key: memory.key || "",
    filename,
    kind: memory.meta.kind || getFileType(filename),
    origin: memory.meta.origin || "unknown",
    detail: clipText(memory.value || "", 220),
    exists,
    path: exists ? filePath : "",
    size: stat ? stat.size : 0,
    sizeLabel: stat ? formatSize(stat.size) : "",
    updatedAt: normalizeTimestamp(memory.updated || memory.saved || ""),
    modifiedAt: stat ? stat.mtime.toISOString() : "",
  };
}

function serializeContext({ currentPage, frontApp, calendar, environmentSnapshot, activeTodos }) {
  return {
    frontApp: frontApp || "",
    currentPage: currentPage || null,
    calendar: Array.isArray(calendar) ? calendar : [],
    activeTodos: Array.isArray(activeTodos) ? activeTodos : [],
    environment: environmentSnapshot || null,
  };
}

module.exports = {
  serializeArtifact,
  serializeContext,
  serializeTimelineEvent,
};
