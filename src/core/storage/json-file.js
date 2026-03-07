const fs = require("fs");

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

class JsonFileStore {
  constructor(filePath, fallbackValue) {
    this.filePath = filePath;
    this.fallbackValue = fallbackValue;
    this._cache = undefined;
    this._writing = false;
    this._pendingWrite = null;
  }

  read() {
    if (this._cache !== undefined) return this._cache;
    try {
      if (fs.existsSync(this.filePath)) {
        this._cache = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
        return this._cache;
      }
    } catch (error) {}
    this._cache = typeof this.fallbackValue === "function" ? this.fallbackValue() : this.fallbackValue;
    return this._cache;
  }

  write(value) {
    this._cache = value;
    const data = JSON.stringify(sanitizeForJson(value), null, 2);
    if (this._writing) {
      this._pendingWrite = data;
      return;
    }
    this._writing = true;
    fs.writeFile(this.filePath, data, (err) => {
      if (err) console.error(`[Store] Write failed ${this.filePath}:`, err.message);
      this._writing = false;
      if (this._pendingWrite !== null) {
        const next = this._pendingWrite;
        this._pendingWrite = null;
        this._writing = true;
        fs.writeFile(this.filePath, next, (err2) => {
          if (err2) console.error(`[Store] Write failed ${this.filePath}:`, err2.message);
          this._writing = false;
        });
      }
    });
  }
}

module.exports = { JsonFileStore };
