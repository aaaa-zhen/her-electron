const EventEmitter = require("events");
const nodeCron = require("node-cron");

function formatRunAt(runAt) {
  if (!runAt) return "";
  const timestamp = new Date(runAt);
  if (Number.isNaN(timestamp.getTime())) return String(runAt);
  return timestamp.toLocaleString();
}

class ScheduleService extends EventEmitter {
  constructor({ scheduleStore, execAsync, processScheduleOutput }) {
    super();
    this.scheduleStore = scheduleStore;
    this.execAsync = execAsync;
    this.processScheduleOutput = processScheduleOutput;
    this.scheduledTasks = [];
    this.nextTaskId = 1;

    this.restore();
  }

  restore() {
    const savedSchedules = this.scheduleStore.list();
    for (const schedule of savedSchedules) {
      if (nodeCron.validate(schedule.cron)) {
        this.registerCron(schedule);
        if (schedule.id >= this.nextTaskId) this.nextTaskId = schedule.id + 1;
      }
    }
    if (savedSchedules.length > 0) {
      console.log(`[Schedule] Restored ${savedSchedules.length} tasks`);
    }
  }

  listPersistedTasks() {
    return this.scheduledTasks.filter((task) => task.cron);
  }

  savePersistedTasks() {
    this.scheduleStore.saveSchedules(this.listPersistedTasks());
  }

  getActiveTasks(limit = 6) {
    return this.scheduledTasks
      .slice()
      .sort((left, right) => right.id - left.id)
      .slice(0, limit)
      .map((task) => ({
        id: task.id,
        description: task.description,
        command: task.command,
        cron: task.cron || "",
        runAt: task.runAt || "",
        ai_prompt: task.ai_prompt || "",
      }));
  }

  getTaskSummaries(limit = 6) {
    return this.getActiveTasks(limit).map((task) => {
      if (task.cron) {
        return `#${task.id} ${task.description} [cron: ${task.cron}]`;
      }
      if (task.runAt) {
        return `#${task.id} ${task.description} [once at ${formatRunAt(task.runAt)}]`;
      }
      return `#${task.id} ${task.description}`;
    });
  }

  async runTask(taskData) {
    try {
      const rawOutput = await this.execAsync(taskData.command);
      const output = await this.processScheduleOutput(taskData, rawOutput);
      this.emit("result", {
        type: "schedule_result",
        taskId: taskData.id,
        description: taskData.description,
        command: taskData.command,
        output,
      });
    } catch (error) {
      this.emit("result", {
        type: "schedule_result",
        taskId: taskData.id,
        description: taskData.description,
        command: taskData.command,
        output: error.message || String(error),
      });
    }
  }

  registerCron(taskData) {
    const job = nodeCron.schedule(taskData.cron, async () => {
      await this.runTask(taskData);
    });
    this.scheduledTasks.push({ ...taskData, job });
  }

  schedule({ command = "echo 'Task triggered'", cron, delay, description, ai_prompt }) {
    const taskId = this.nextTaskId++;
    if (delay && delay > 0) {
      const runAt = new Date(Date.now() + delay * 1000).toISOString();
      const taskData = { id: taskId, description, command, ai_prompt, runAt, once: true };
      const timeoutId = setTimeout(async () => {
        await this.runTask(taskData);
        this.scheduledTasks = this.scheduledTasks.filter((task) => task.id !== taskId);
      }, delay * 1000);
      this.scheduledTasks.push({ ...taskData, timeoutId });
      return {
        taskId,
        message: `One-time task #${taskId}: "${description}" in ${delay >= 60 ? `${Math.round(delay / 60)} min` : `${delay}s`}`,
      };
    }

    if (!cron || !nodeCron.validate(cron)) {
      throw new Error(`Invalid cron: "${cron}"`);
    }

    const taskData = { id: taskId, description, command, cron, ai_prompt };
    this.registerCron(taskData);
    this.savePersistedTasks();
    return { taskId, message: `Scheduled #${taskId}: "${description}" [${cron}]` };
  }

  stop() {
    this.scheduledTasks.forEach((task) => {
      if (task.job) task.job.stop();
      if (task.timeoutId) clearTimeout(task.timeoutId);
    });
    this.scheduledTasks = [];
  }
}

module.exports = { ScheduleService };
