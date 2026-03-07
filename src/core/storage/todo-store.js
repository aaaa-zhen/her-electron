const path = require("path");
const { JsonFileStore } = require("./json-file");

class TodoStore extends JsonFileStore {
  constructor(dataDir) {
    super(path.join(dataDir, "todos.json"), () => []);
  }

  /** Return active (not done, not expired) todos — hides items whose due time has passed */
  list() {
    const now = Date.now();
    return this.read().filter((t) => {
      if (t.done) return false;
      // Due time passed → hide (no need to show stale reminders)
      if (t.dueDate) {
        const due = new Date(t.dueDate).getTime();
        if (!isNaN(due) && due < now) return false;
      }
      // Expiry passed → hide
      if (t.expiresAt) {
        const exp = new Date(t.expiresAt).getTime();
        if (!isNaN(exp) && exp < now) return false;
      }
      return true;
    });
  }

  listAll() {
    return this.read();
  }

  add(title, detail = "", dueDate = "", expiresAt = "") {
    const todos = this.read();
    const item = {
      id: `todo_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      title,
      detail,
      dueDate,
      expiresAt: expiresAt || "",
      done: false,
      created: new Date().toISOString(),
    };
    todos.push(item);
    this.write(todos);
    return item;
  }

  complete(id) {
    const todos = this.read();
    const item = todos.find((t) => t.id === id || t.title === id);
    if (!item) return null;
    item.done = true;
    item.completedAt = new Date().toISOString();
    this.write(todos);
    return item;
  }

  remove(id) {
    const todos = this.read();
    const idx = todos.findIndex((t) => t.id === id || t.title === id);
    if (idx === -1) return null;
    const removed = todos.splice(idx, 1)[0];
    this.write(todos);
    return removed;
  }
}

module.exports = { TodoStore };
