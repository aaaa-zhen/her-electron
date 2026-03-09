const { clipText } = require("./text-utils");

function sortTodosForPrompt(todos = []) {
  return [...todos].sort((a, b) => {
    const timeA = a && a.dueDate ? new Date(a.dueDate).getTime() : Number.POSITIVE_INFINITY;
    const timeB = b && b.dueDate ? new Date(b.dueDate).getTime() : Number.POSITIVE_INFINITY;
    if (timeA !== timeB) return timeA - timeB;
    const createdA = a && a.created ? new Date(a.created).getTime() : 0;
    const createdB = b && b.created ? new Date(b.created).getTime() : 0;
    return createdB - createdA;
  });
}

function isSameLocalDay(dateLike, now = new Date()) {
  const value = new Date(dateLike);
  if (Number.isNaN(value.getTime())) return false;
  return value.getFullYear() === now.getFullYear()
    && value.getMonth() === now.getMonth()
    && value.getDate() === now.getDate();
}

function getTodoTimelineTime(todo) {
  const candidates = [todo && todo.dueDate, todo && todo.completedAt, todo && todo.created];
  for (const value of candidates) {
    const time = new Date(value || "").getTime();
    if (!Number.isNaN(time)) return time;
  }
  return Number.POSITIVE_INFINITY;
}

function normalizeTodayTodo(todo) {
  const dueAt = todo && todo.dueDate ? new Date(todo.dueDate).getTime() : NaN;
  let status = "today";
  if (todo && todo.done) status = "done";
  else if (!Number.isNaN(dueAt) && dueAt < Date.now()) status = "past";
  else if (!Number.isNaN(dueAt)) status = "upcoming";
  return {
    kind: "todo",
    title: todo.title,
    detail: todo.detail || "",
    dueDate: todo.dueDate || todo.completedAt || todo.created || "",
    status,
    id: todo.id || "",
  };
}

function normalizeTodayCalendarEvent(event) {
  const startAt = event && (event.startAt || event.startDate) ? new Date(event.startAt || event.startDate).getTime() : NaN;
  let status = "today";
  if (!Number.isNaN(startAt) && startAt < Date.now()) status = "past";
  else if (!Number.isNaN(startAt)) status = "upcoming";
  const detailParts = [];
  if (event && event.location) detailParts.push(`location: ${event.location}`);
  if (event && event.calendar) detailParts.push(`calendar: ${event.calendar}`);
  return {
    kind: "calendar",
    title: event.title,
    detail: detailParts.join(" | "),
    dueDate: event.startAt || event.startDate || "",
    status,
    id: `${event.calendar || "calendar"}:${event.title || ""}:${event.startAt || event.startDate || ""}`,
  };
}

function buildTodayCommitments(todoStore, calendar = [], limit = 6) {
  const now = new Date();
  const items = [];

  if (todoStore && typeof todoStore.listAll === "function") {
    items.push(...todoStore.listAll()
      .filter((todo) => {
        if (!todo) return false;
        return isSameLocalDay(todo.dueDate, now)
          || isSameLocalDay(todo.completedAt, now)
          || isSameLocalDay(todo.created, now);
      })
      .map((todo) => normalizeTodayTodo(todo)));
  }

  if (Array.isArray(calendar)) {
    items.push(...calendar
      .filter((event) => event && event.title && isSameLocalDay(event.startAt || event.startDate, now))
      .map((event) => normalizeTodayCalendarEvent(event)));
  }

  return items
    .sort((a, b) => getTodoTimelineTime(a) - getTodoTimelineTime(b))
    .slice(0, limit);
}

function syncTimelineEvents({ memoryStore, todayCommitments = [] }) {
  if (!memoryStore || typeof memoryStore.saveTimelineEvent !== "function") return;
  for (const item of todayCommitments) {
    memoryStore.saveTimelineEvent({
      key: item.kind === "todo"
        ? `timeline:todo:${item.id || item.title}`
        : `timeline:calendar:${item.id || item.title}`,
      title: item.title,
      at: item.dueDate,
      detail: item.detail,
      source: item.kind,
      status: item.status,
      meta: { id: item.id || "", kind: item.kind },
    });
  }
}

module.exports = {
  sortTodosForPrompt,
  isSameLocalDay,
  getTodoTimelineTime,
  normalizeTodayTodo,
  normalizeTodayCalendarEvent,
  buildTodayCommitments,
  syncTimelineEvents,
};
