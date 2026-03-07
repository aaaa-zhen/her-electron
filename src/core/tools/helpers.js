const path = require("path");
const { pathToFileURL } = require("url");

function safePath(dir, filename) {
  const baseDir = path.resolve(dir);
  const resolved = path.resolve(dir, filename);
  if (!resolved.startsWith(baseDir + path.sep) && resolved !== baseDir) return null;
  return resolved;
}

function getFileType(filename) {
  const ext = path.extname(filename).toLowerCase();
  if ([".mp4", ".webm", ".mov", ".avi", ".mkv"].includes(ext)) return "video";
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg"].includes(ext)) return "image";
  if ([".mp3", ".wav", ".ogg", ".flac", ".aac"].includes(ext)) return "audio";
  return "file";
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function toFileUrl(filePath) {
  return pathToFileURL(filePath).toString();
}

module.exports = {
  safePath,
  getFileType,
  formatSize,
  toFileUrl,
};
