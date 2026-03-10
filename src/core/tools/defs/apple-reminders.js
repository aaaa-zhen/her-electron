const { BaseTool } = require("../base-tool");

class AppleRemindersTool extends BaseTool {
  get name() { return "apple_reminders"; }
  get description() { return "Manage Apple Reminders: add, complete, list, or delete reminders."; }
  get input_schema() {
    return {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "complete", "list", "delete"], description: "Action to perform" },
        title: { type: "string", description: "Reminder title (for add/complete/delete)" },
        list: { type: "string", description: "Reminder list name. Default: Reminders" },
        due_date: { type: "string", description: "Due date in YYYY-MM-DD or YYYY-MM-DD HH:mm format (for add)" },
        notes: { type: "string", description: "Reminder notes (for add)" },
      },
      required: ["action"],
    };
  }

  async execute(input, ctx) {
    const { action, title, list: listName = "提醒事项", due_date, notes } = input;

    if (action === "list") {
      const script = `
        tell application "Reminders"
          set output to ""
          try
            set theList to list "${listName}"
          on error
            set theList to default list
          end try
          set theReminders to (every reminder of theList whose completed is false)
          repeat with r in theReminders
            set dueStr to ""
            try
              set dueStr to " [" & (due date of r as string) & "]"
            end try
            set output to output & name of r & dueStr & linefeed
          end repeat
          if output is "" then return "No incomplete reminders."
          return output
        end tell`;
      ctx.emitCommand("apple_reminders:list", "查看提醒", listName);
      const result = await ctx.execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 10000, cwd: ctx.paths.sharedDir });
      return result.trim() || "No reminders found.";
    }

    if (action === "add" && title) {
      let dateClause = "";
      if (due_date) {
        const parts = due_date.split(" ");
        const [y, m, d] = parts[0].split("-");
        if (parts[1]) {
          const [hh, mm] = parts[1].split(":");
          dateClause = `set due date of newReminder to date "${m}/${d}/${y} ${hh}:${mm}:00"`;
        } else {
          dateClause = `set due date of newReminder to date "${m}/${d}/${y} 09:00:00"`;
        }
      }
      const notesClause = notes ? `set body of newReminder to "${notes.replace(/"/g, '\\"')}"` : "";
      const script = `
        tell application "Reminders"
          try
            set theList to list "${listName}"
          on error
            set theList to default list
          end try
          set newReminder to make new reminder at end of theList with properties {name:"${title.replace(/"/g, '\\"')}"}
          ${dateClause}
          ${notesClause}
          return "OK"
        end tell`;
      ctx.emitCommand("apple_reminders:add", "添加提醒", title);
      await ctx.execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 10000, cwd: ctx.paths.sharedDir });
      const dueInfo = due_date ? ` (due: ${due_date})` : "";
      return `Reminder added: "${title}"${dueInfo} in list "${listName}"`;
    }

    if (action === "complete" && title) {
      const script = `
        tell application "Reminders"
          try
            set theList to list "${listName}"
          on error
            set theList to default list
          end try
          set theReminders to (every reminder of theList whose name is "${title.replace(/"/g, '\\"')}" and completed is false)
          if (count of theReminders) > 0 then
            set completed of item 1 of theReminders to true
            return "OK"
          else
            return "NOT_FOUND"
          end if
        end tell`;
      ctx.emitCommand("apple_reminders:complete", "完成提醒", title);
      const result = await ctx.execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 10000, cwd: ctx.paths.sharedDir });
      if (result.trim() === "NOT_FOUND") return { content: `Reminder "${title}" not found.`, is_error: true };
      return `Reminder "${title}" completed.`;
    }

    if (action === "delete" && title) {
      const script = `
        tell application "Reminders"
          try
            set theList to list "${listName}"
          on error
            set theList to default list
          end try
          set theReminders to (every reminder of theList whose name is "${title.replace(/"/g, '\\"')}")
          if (count of theReminders) > 0 then
            delete item 1 of theReminders
            return "OK"
          else
            return "NOT_FOUND"
          end if
        end tell`;
      ctx.emitCommand("apple_reminders:delete", "删除提醒", title);
      const result = await ctx.execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 10000, cwd: ctx.paths.sharedDir });
      if (result.trim() === "NOT_FOUND") return { content: `Reminder "${title}" not found.`, is_error: true };
      return `Reminder "${title}" deleted.`;
    }

    return { content: "Missing required parameter: title", is_error: true };
  }
}

module.exports = AppleRemindersTool;
