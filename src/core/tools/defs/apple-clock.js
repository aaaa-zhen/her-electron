const { BaseTool } = require("../base-tool");

class AppleClockTool extends BaseTool {
  get name() { return "apple_clock"; }
  get description() { return "Set alarms and timers using macOS. Actions: set_alarm, set_timer, list_alarms."; }
  get input_schema() {
    return {
      type: "object",
      properties: {
        action: { type: "string", enum: ["set_alarm", "set_timer", "list_alarms"], description: "Action to perform" },
        time: { type: "string", description: "Alarm time in HH:mm format (for set_alarm)" },
        label: { type: "string", description: "Alarm/timer label" },
        seconds: { type: "number", description: "Timer duration in seconds (for set_timer)" },
      },
      required: ["action"],
    };
  }

  async execute(input, ctx) {
    const { action, time, label = "Her Timer", seconds } = input;

    if (action === "set_timer" && seconds) {
      const mins = Math.ceil(seconds / 60);
      const command = `(sleep ${seconds} && osascript -e 'display notification "${label}" with title "Her Timer" sound name "Glass"' && afplay /System/Library/Sounds/Glass.aiff) &\necho "Timer set: ${label} (${seconds}s)"`;
      ctx.emitCommand("apple_clock:timer", "设置计时器", `${label} - ${mins}min`);
      await ctx.execAsync(command, { timeout: 5000, cwd: ctx.paths.sharedDir });
      return `Timer set: "${label}" will fire in ${seconds} seconds (${mins} min).`;
    }

    if (action === "set_alarm" && time) {
      const script = `
        set now to current date
        set alarmTime to current date
        set hours of alarmTime to ${parseInt(time.split(":")[0])}
        set minutes of alarmTime to ${parseInt(time.split(":")[1])}
        set seconds of alarmTime to 0
        if alarmTime < now then set alarmTime to alarmTime + 86400
        set diff to (alarmTime - now) as integer
        return diff`;
      ctx.emitCommand("apple_clock:alarm", "设置闹钟", `${time} - ${label}`);
      const diffStr = await ctx.execAsync(`osascript -e '${script}'`, { timeout: 5000, cwd: ctx.paths.sharedDir });
      const diff = parseInt(diffStr.trim());
      if (isNaN(diff) || diff <= 0) return { content: "Invalid time.", is_error: true };
      const alarmCmd = `(sleep ${diff} && osascript -e 'display notification "${label}" with title "Her Alarm" sound name "Glass"' && afplay /System/Library/Sounds/Glass.aiff) &\necho "Alarm set"`;
      await ctx.execAsync(alarmCmd, { timeout: 5000, cwd: ctx.paths.sharedDir });
      const hours = Math.floor(diff / 3600);
      const mins = Math.floor((diff % 3600) / 60);
      return `Alarm set: "${label}" at ${time} (in ${hours}h ${mins}m).`;
    }

    if (action === "list_alarms") {
      const result = await ctx.execAsync(`ps aux | grep '[s]leep' | grep -v 'grep' | head -10`, { timeout: 5000, cwd: ctx.paths.sharedDir });
      if (!result.trim()) return "No active alarms or timers.";
      return result.trim();
    }

    return { content: "Missing required parameter.", is_error: true };
  }
}

module.exports = AppleClockTool;
