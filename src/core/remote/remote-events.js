const REMOTE_MESSAGE_TYPES = {
  AGENT_HELLO: "agent.hello",
  AGENT_STATUS: "agent.status",
  AGENT_PING: "agent.ping",
  AGENT_PONG: "agent.pong",
  AGENT_REFRESH_STATUS: "agent.refresh_status",
  CHAT_REQUEST: "chat.request",
  CHAT_STREAM: "chat.stream",
  CHAT_RESPONSE: "chat.response",
  JOB_REQUEST: "job.request",
  JOB_RESULT: "job.result",
  JOB_ERROR: "job.error",
};

const REMOTE_ACTIONS = {
  CHAT_SEND: "chat.send",
  TIMELINE_TODAY: "timeline.today",
  CONTEXT_CURRENT: "context.current",
  ARTIFACT_RECALL: "artifact.recall",
  MEDIA_DOWNLOAD: "media.download",
};

module.exports = {
  REMOTE_MESSAGE_TYPES,
  REMOTE_ACTIONS,
};
