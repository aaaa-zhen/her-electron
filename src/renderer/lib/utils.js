/* --- Shared UI utilities --- */

function formatDueDate(raw) {
  if (!raw) return "";
  const d = new Date(raw);
  if (isNaN(d.getTime())) return raw;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((target - today) / 86400000);
  const time = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (diffDays === 0) return `今天 ${time}`;
  if (diffDays === 1) return `明天 ${time}`;
  if (diffDays === -1) return `昨天 ${time}`;
  if (diffDays > 1 && diffDays <= 6) {
    const weekday = ["周日","周一","周二","周三","周四","周五","周六"][d.getDay()];
    return `${weekday} ${time}`;
  }
  return `${d.getMonth()+1}/${d.getDate()} ${time}`;
}

function fmtTime(date = new Date()) {
  const hours = `${date.getHours()}`.padStart(2, "0");
  const minutes = `${date.getMinutes()}`.padStart(2, "0");
  return `${hours}:${minutes}`;
}

function toast(message) {
  const element = document.getElementById("toast");
  element.innerHTML = `<svg><use href="#i-check"/></svg>${esc(message)}`;
  element.classList.add("show");
  setTimeout(() => element.classList.remove("show"), 2200);
}

function fallbackCopy(text) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.cssText = "position:fixed;left:-9999px;top:-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

function doCopy(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  fallbackCopy(text);
  return Promise.resolve();
}

window.copyCodeBlock = function copyCodeBlock(button) {
  const code = button.closest("pre").querySelector("code").innerText;
  doCopy(code).then(() => {
    button.textContent = "已复制 ✓";
    button.classList.add("copied");
    setTimeout(() => {
      button.textContent = "复制";
      button.classList.remove("copied");
    }, 1500);
  });
};

function getActionIcon(label) {
  const map = {
    "帮我做点事": "#i-zap",
    "聊聊现在": "#i-heart", "帮我推进": "#i-zap", "设置提醒": "#i-clock",
    "回顾今天": "#i-check", "找回文件": "#i-folder", "整理桌面": "#i-folder",
    "做 PPT": "#i-presentation", "做表格": "#i-table", "下载视频": "#i-download",
  };
  return map[label] || "#i-sparkles";
}

function getActionColor(label) {
  const map = {
    "帮我做点事": "wc-orange",
    "聊聊现在": "wc-red", "帮我推进": "wc-cyan", "设置提醒": "wc-orange",
    "回顾今天": "wc-green", "找回文件": "wc-blue", "整理桌面": "wc-cyan",
    "做 PPT": "wc-orange", "做表格": "wc-green", "下载视频": "wc-purple",
  };
  return map[label] || "wc-green";
}

function getArtifactIcon(kind) {
  if (kind === "image") return "#i-image";
  if (kind === "video") return "#i-video";
  if (kind === "audio") return "#i-music";
  return "#i-file";
}

const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function extFromMediaType(mediaType) {
  const map = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" };
  return map[mediaType] || "png";
}
