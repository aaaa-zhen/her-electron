const { execFile } = require("child_process");

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(String(stdout || "").trim());
    });
  });
}

async function readFrontApp() {
  try {
    return await execFileAsync(
      "osascript",
      ["-e", 'tell application "System Events" to get name of first application process whose frontmost is true'],
      { timeout: 3000 }
    );
  } catch (_) {
    return "";
  }
}

async function readCalendarEvents() {
  try {
    const script = `
      set today to current date
      set time of today to 0
      set tomorrow to today + 2 * days
      set output to ""
      tell application "Calendar"
        repeat with cal in calendars
          set calName to name of cal
          set evts to (every event of cal whose start date >= today and start date < tomorrow)
          repeat with e in evts
            set t to title of e
            set s to start date of e
            set loc to ""
            try
              set loc to location of e
            end try
            if loc is missing value then set loc to ""
            set output to output & t & "||" & (s as string) & "||" & loc & "||" & calName & "\\n"
          end repeat
        end repeat
      end tell
      return output
    `;
    const raw = await execFileAsync("osascript", ["-e", script], { timeout: 8000 });
    if (!raw) return [];
    return raw.split("\n").filter(Boolean).map((line) => {
      const [title, startDate, location, calendar] = line.split("||");
      const parsed = new Date((startDate || "").trim());
      return {
        title: (title || "").trim(),
        startDate: (startDate || "").trim(),
        startAt: Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString(),
        location: (location || "").trim(),
        calendar: (calendar || "").trim(),
      };
    });
  } catch (_) {
    return [];
  }
}

module.exports = {
  readFrontApp,
  readCalendarEvents,
};
