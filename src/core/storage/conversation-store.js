const path = require("path");
const { JsonFileStore } = require("./json-file");

class ConversationStore extends JsonFileStore {
  constructor(dataDir) {
    super(path.join(dataDir, "conversation.json"), () => []);
    this.saveTimer = null;
  }

  get() {
    return this.read();
  }

  save(history) {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try {
        const limited = history.length > 500 ? history.slice(-500) : history;
        this.write(limited);
      } catch (error) {
        console.error("[Conversation] Save failed:", error.message);
      }
    }, 200);
  }

  clear() {
    this.write([]);
  }
}

module.exports = { ConversationStore };
