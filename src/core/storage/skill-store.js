const fs = require("fs");
const path = require("path");

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
const MAX_SKILL_CONTENT = 3000;
const MAX_SKILLS = 50;

// Security patterns to block in skill content
const THREAT_PATTERNS = [
  /ignore\s+(previous|all|above|prior)\s+instructions/i,
  /you\s+are\s+now\s+/i,
  /system\s+prompt\s+override/i,
  /disregard\s+(your|all|any)\s+(instructions|rules)/i,
  /\[CONVERSATION SUMMARY\]/,
];

function scanContent(content) {
  for (const pattern of THREAT_PATTERNS) {
    if (pattern.test(content)) return "Content blocked: matches injection pattern.";
  }
  return null;
}

function parseFrontmatter(raw) {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) return null;
  const lines = match[1].split("\n");
  const meta = {};
  for (const line of lines) {
    const sep = line.indexOf(":");
    if (sep < 0) continue;
    const key = line.slice(0, sep).trim();
    let val = line.slice(sep + 1).trim();
    if (key === "tags") {
      val = val.replace(/^\[|\]$/g, "").split(",").map((t) => t.trim()).filter(Boolean);
    }
    meta[key] = val;
  }
  return { meta, content: match[2].trim() };
}

function buildFrontmatter({ title, tags = [], created, updated }) {
  const tagStr = tags.length > 0 ? `[${tags.join(", ")}]` : "[]";
  return `---
title: ${title}
tags: ${tagStr}
created: ${created || new Date().toISOString()}
updated: ${updated || new Date().toISOString()}
---
`;
}

class SkillStore {
  constructor(dataDir) {
    this._skillsDir = path.join(dataDir, "skills");
    if (!fs.existsSync(this._skillsDir)) {
      fs.mkdirSync(this._skillsDir, { recursive: true });
    }
  }

  list() {
    if (!fs.existsSync(this._skillsDir)) return [];
    const results = [];
    for (const name of fs.readdirSync(this._skillsDir)) {
      const filePath = path.join(this._skillsDir, name);
      if (!name.endsWith(".md") || !fs.statSync(filePath).isFile()) continue;
      const skill = this._readSkill(filePath);
      if (skill) results.push(skill);
    }
    return results;
  }

  get(id) {
    const filePath = path.join(this._skillsDir, `${id}.md`);
    if (!fs.existsSync(filePath)) return null;
    return this._readSkill(filePath);
  }

  save(id, { title, tags = [], content }) {
    if (!id || !title || !content) return { success: false, error: "id, title, and content are required." };

    // Validate id
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) {
      return { success: false, error: "Invalid skill id. Use lowercase letters, numbers, hyphens." };
    }

    // Security scan
    const scanError = scanContent(content);
    if (scanError) return { success: false, error: scanError };

    // Content limit
    if (content.length > MAX_SKILL_CONTENT) {
      return { success: false, error: `Content exceeds ${MAX_SKILL_CONTENT} char limit.` };
    }

    // Skill count limit
    const existing = this.get(id);
    if (!existing && this.list().length >= MAX_SKILLS) {
      return { success: false, error: `Max ${MAX_SKILLS} skills reached. Delete old skills first.` };
    }

    const filePath = path.join(this._skillsDir, `${id}.md`);
    const created = existing ? existing.created : new Date().toISOString();
    const header = buildFrontmatter({ title, tags, created, updated: new Date().toISOString() });
    fs.writeFileSync(filePath, header + content, "utf-8");

    return { success: true, message: existing ? `Skill '${id}' updated.` : `Skill '${id}' created.` };
  }

  delete(id) {
    const filePath = path.join(this._skillsDir, `${id}.md`);
    if (!fs.existsSync(filePath)) return { success: false, error: `Skill '${id}' not found.` };
    fs.unlinkSync(filePath);
    return { success: true, message: `Skill '${id}' deleted.` };
  }

  search(query) {
    if (!query) return this.list();
    const lower = query.toLowerCase();
    return this.list().filter((s) =>
      s.title.toLowerCase().includes(lower) ||
      s.content.toLowerCase().includes(lower) ||
      (s.tags && s.tags.some((t) => t.toLowerCase().includes(lower)))
    );
  }

  getRelevant(query, limit = 3) {
    if (!query) return [];
    const lower = query.toLowerCase();
    const tokens = lower.split(/\s+/).filter((t) => t.length >= 2);
    if (tokens.length === 0) return [];

    return this.list()
      .map((skill) => {
        const text = `${skill.title} ${(skill.tags || []).join(" ")} ${skill.content}`.toLowerCase();
        let score = 0;
        for (const token of tokens) {
          if (text.includes(token)) score += 1;
        }
        if (skill.title.toLowerCase().includes(lower)) score += 3;
        return { skill, score };
      })
      .filter((e) => e.score >= 1)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((e) => e.skill);
  }

  _readSkill(filePath) {
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = parseFrontmatter(raw);
      if (!parsed) return null;
      const id = path.basename(filePath, ".md");
      return {
        id,
        title: parsed.meta.title || id,
        tags: Array.isArray(parsed.meta.tags) ? parsed.meta.tags : [],
        content: parsed.content,
        created: parsed.meta.created || "",
        updated: parsed.meta.updated || "",
      };
    } catch {
      return null;
    }
  }
}

module.exports = { SkillStore };
