const path = require("path");
const { JsonFileStore } = require("./json-file");

class ScheduleStore extends JsonFileStore {
  constructor(dataDir) {
    super(path.join(dataDir, "schedules.json"), () => []);
  }

  list() {
    return this.read();
  }

  saveSchedules(schedules) {
    const data = schedules.map((schedule) => ({
      id: schedule.id,
      description: schedule.description,
      cron: schedule.cron,
      command: schedule.command,
      ai_prompt: schedule.ai_prompt || undefined,
    }));
    this.write(data);
  }
}

module.exports = { ScheduleStore };
