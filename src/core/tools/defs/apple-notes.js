const { BaseTool } = require("../base-tool");

class AppleNotesTool extends BaseTool {
  get name() { return "apple_notes"; }
  get description() { return "Manage Apple Notes: create, search, read, or list notes."; }
  get input_schema() {
    return {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "search", "read", "list"], description: "Action to perform" },
        title: { type: "string", description: "Note title (for create/read)" },
        body: { type: "string", description: "Note body content (for create)" },
        folder: { type: "string", description: "Folder name. Default: Notes" },
        query: { type: "string", description: "Search keyword (for search)" },
      },
      required: ["action"],
    };
  }

  async execute(input, ctx) {
    const { action, title, body, folder = "Notes", query } = input;

    if (action === "list") {
      const script = `
        tell application "Notes"
          set output to ""
          try
            set theFolder to folder "${folder}"
            set theNotes to every note of theFolder
          on error
            set theNotes to every note of default account
          end try
          set maxCount to 30
          set i to 0
          repeat with n in theNotes
            set i to i + 1
            if i > maxCount then exit repeat
            set output to output & name of n & " (" & (modification date of n as string) & ")" & linefeed
          end repeat
          if output is "" then return "No notes found."
          return output
        end tell`;
      ctx.emitCommand("apple_notes:list", "查看备忘录", folder);
      const result = await ctx.execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 10000, cwd: ctx.paths.sharedDir });
      return result.trim() || "No notes found.";
    }

    if (action === "create" && title) {
      const htmlBody = (body || "").replace(/"/g, '\\"').replace(/\n/g, "<br>");
      const script = `
        tell application "Notes"
          try
            set theFolder to folder "${folder}"
          on error
            set theFolder to default account
          end try
          make new note at theFolder with properties {name:"${title.replace(/"/g, '\\"')}", body:"<h1>${title.replace(/"/g, '\\"')}</h1>${htmlBody ? "<br>" + htmlBody : ""}"}
          return "OK"
        end tell`;
      ctx.emitCommand("apple_notes:create", "创建备忘录", title);
      await ctx.execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 10000, cwd: ctx.paths.sharedDir });
      return `Note created: "${title}" in folder "${folder}"`;
    }

    if (action === "read" && title) {
      const script = `
        tell application "Notes"
          set theNotes to every note whose name is "${title.replace(/"/g, '\\"')}"
          if (count of theNotes) > 0 then
            set n to item 1 of theNotes
            set noteBody to plaintext of n
            return name of n & linefeed & "---" & linefeed & noteBody
          else
            return "NOT_FOUND"
          end if
        end tell`;
      ctx.emitCommand("apple_notes:read", "读取备忘录", title);
      const result = await ctx.execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 10000, cwd: ctx.paths.sharedDir });
      if (result.trim() === "NOT_FOUND") return { content: `Note "${title}" not found.`, is_error: true };
      return result.trim().slice(0, 10000);
    }

    if (action === "search" && query) {
      const script = `
        tell application "Notes"
          set output to ""
          set allNotes to every note whose name contains "${query.replace(/"/g, '\\"')}"
          set maxCount to 10
          set i to 0
          repeat with n in allNotes
            set i to i + 1
            if i > maxCount then exit repeat
            set output to output & name of n & " (" & (modification date of n as string) & ")" & linefeed
          end repeat
          if output is "" then return "No notes matching query."
          return output
        end tell`;
      ctx.emitCommand("apple_notes:search", "搜索备忘录", query);
      const result = await ctx.execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 10000, cwd: ctx.paths.sharedDir });
      return result.trim() || "No notes found.";
    }

    return { content: "Missing required parameter.", is_error: true };
  }
}

module.exports = AppleNotesTool;
