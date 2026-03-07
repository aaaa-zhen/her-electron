const EventEmitter = require("events");
const { execFile } = require("child_process");

const REMINDER_LEAD_MS = 15 * 60 * 1000;

function parseTimestamp(value) {
  if (!value) return NaN;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? NaN : time;
}

function resolveTodoDueAt(todo) {
  const dueAt = parseTimestamp(todo.dueDate);
  if (!Number.isNaN(dueAt)) return dueAt;

  const expiresAt = parseTimestamp(todo.expiresAt);
  if (!Number.isNaN(expiresAt)) {
    return expiresAt - 60 * 60 * 1000;
  }

  return NaN;
}

function buildRelativeCopy(startAt, now = Date.now()) {
  const diff = startAt - now;
  if (diff <= 60 * 1000) return "现在差不多该开始了";
  const minutes = Math.max(1, Math.round(diff / 60000));
  return `还有 ${minutes} 分钟开始`;
}

class ContextMonitor extends EventEmitter {
  constructor({ todoStore, interval = 60000 }) {
    super();
    this.todoStore = todoStore;
    this.interval = interval;
    this.timer = null;
    this.notifiedEvents = new Set();
  }

  start() {
    this.timer = setInterval(() => this.check(), this.interval);
    setTimeout(() => this.check(), 5000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  check() {
    this.checkCalendar();
    this.checkTodos();
  }

  checkCalendar() {
    const script = `
      tell application "Calendar"
        set now to current date
        set soon to now + 15 * minutes
        set output to ""
        repeat with c in calendars
          set evts to (every event of c whose start date >= now and start date <= soon)
          repeat with e in evts
            set output to output & summary of e & "|" & (start date of e as string) & linefeed
          end repeat
        end repeat
        return output
      end tell`;
    execFile("osascript", ["-e", script], { timeout: 10000 }, (error, stdout) => {
      if (error) return;
      const result = String(stdout || "").trim();
      if (!result) return;

      const lines = result.split("\n").filter(Boolean);
      for (const line of lines) {
        const [title, dateStr] = line.split("|");
        const key = `cal:${title}:${dateStr}`;
        if (this.notifiedEvents.has(key)) continue;
        this.notifiedEvents.add(key);

        this.emit("notification", {
          kind: "calendar",
          title: (title || "").trim() || "日程提醒",
          body: "还有 15 分钟开始",
          meta: { startDate: (dateStr || "").trim() },
        });
      }
    });
  }

  checkTodos() {
    try {
      const todos = this.todoStore.list();
      const now = Date.now();
      for (const todo of todos) {
        const dueAt = resolveTodoDueAt(todo);
        if (Number.isNaN(dueAt)) continue;
        if (now < dueAt - REMINDER_LEAD_MS || now > dueAt + 10 * 60 * 1000) continue;

        const key = `todo:${todo.id}:${dueAt}`;
        if (this.notifiedEvents.has(key)) continue;
        this.notifiedEvents.add(key);

        this.emit("notification", {
          kind: "todo",
          title: todo.title,
          body: buildRelativeCopy(dueAt, now),
          meta: {
            id: todo.id,
            dueDate: todo.dueDate || "",
            detail: todo.detail || "",
          },
        });
      }
    } catch (_) {
      // Ignore todo store failures.
    }
  }
}

module.exports = { ContextMonitor };
