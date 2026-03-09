/* --- Markdown rendering & caching --- */

function esc(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

const mdCache = new Map();
const MD_CACHE_MAX = 150;
const MD_CACHE_CHAR_LIMIT = 30000;

function mdCached(raw) {
  if (raw.length > MD_CACHE_CHAR_LIMIT) return md(raw);
  const cached = mdCache.get(raw);
  if (cached) {
    mdCache.delete(raw);
    mdCache.set(raw, cached);
    return cached;
  }
  const html = md(raw);
  mdCache.set(raw, html);
  if (mdCache.size > MD_CACHE_MAX) mdCache.delete(mdCache.keys().next().value);
  return html;
}

function md(raw) {
  if (raw.length > 100000) raw = `${raw.slice(0, 100000)}\n\n... (内容过长，已截断)`;
  if (raw.length > 40000) {
    return `<pre class="md-fallback" style="white-space:pre-wrap;word-break:break-all;font-size:13px;line-height:1.5;color:var(--text2)">${esc(raw)}</pre>`;
  }

  const blocks = [];
  let html = raw.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    const safeCode = esc(code.replace(/^\n|\n$/g, ""));
    const language = lang || "code";
    const block = `<pre><div class="pre-header"><span class="pre-lang">${language}</span><button class="copy-btn" onclick="copyCodeBlock(this)">复制</button></div><code>${safeCode}</code></pre>`;
    blocks.push(block);
    return `\x00BLOCK${blocks.length - 1}\x00`;
  });

  html = esc(html);
  html = html.replace(/\x00BLOCK(\d+)\x00/g, (_match, index) => blocks[Number(index)]);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
  html = html.replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>");
  html = html.replace(/^---$/gm, "<hr>");
  html = html.replace(/((?:^\|.+\|$\n?)+)/gm, (block) => {
    const rows = block.trim().split("\n");
    if (rows.length < 2 || !/^\|[\s\-:|]+\|$/.test(rows[1])) return block;
    const parseRow = (row) => row.replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
    const headers = parseRow(rows[0]).map((header) => `<th>${header}</th>`).join("");
    const body = rows.slice(2).map((row) => `<tr>${parseRow(row).map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("");
    return `<table><thead><tr>${headers}</tr></thead><tbody>${body}</tbody></table>`;
  });
  html = html.replace(/((?:^\d+\. .+$\n?)+)/gm, (block) => `<ol>${block.trim().split("\n").map((line) => `<li>${line.replace(/^\d+\.\s+/, "")}</li>`).join("")}</ol>`);
  html = html.replace(/((?:^[\-\*] .+$\n?)+)/gm, (block) => `<ul>${block.trim().split("\n").map((line) => `<li>${line.replace(/^[\-\*]\s+/, "")}</li>`).join("")}</ul>`);
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, url) => {
    if (/^https?:\/\//i.test(url) || /^file:\/\//i.test(url)) {
      return `<a href="${url}" target="_blank" rel="noopener">${label}</a>`;
    }
    return `${label} (${url})`;
  });
  html = html.replace(/^(?!<[hupbloait]|<\/|<hr)(.*\S.*)$/gm, "<p>$1</p>");
  html = html.replace(/\n{2,}/g, "\n");
  return html;
}
