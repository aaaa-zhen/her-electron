const { BaseTool } = require("../base-tool");

class ScheduleTaskTool extends BaseTool {
  get name() { return "schedule_task"; }
  get description() { return "Schedule a task to run once after a delay OR on a recurring cron schedule."; }
  get input_schema() {
    return {
      type: "object",
      properties: {
        command: { type: "string", description: "Bash command to execute" },
        cron: { type: "string", description: "Cron expression for recurring tasks" },
        delay: { type: "number", description: "Run once after this many seconds" },
        description: { type: "string", description: "Human-readable description" },
        ai_prompt: { type: "string", description: "If set, AI processes the output before displaying" },
      },
      required: ["description"],
    };
  }

  async execute(input, ctx) {
    const result = ctx.scheduleService.schedule(input);
    return result.message;
  }
}

module.exports = ScheduleTaskTool;
