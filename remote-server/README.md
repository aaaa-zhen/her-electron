# Her Relay MVP

This relay does not store your raw local data. It only:

- accepts WebSocket connections from your phone client
- accepts a persistent WebSocket connection from your Mac agent
- forwards requests and responses
- reports whether your Mac is online

## Environment variables

```bash
export HER_RELAY_PORT=3939
export HER_RELAY_AGENT_TOKEN="replace-with-agent-token"
export HER_RELAY_CLIENT_TOKEN="replace-with-client-token"
```

## Start

```bash
npm run start:relay
```

Then open:

```text
http://YOUR_SERVER:3939
```

## Mac-side settings

In Her's local `settings.json`, set:

```json
{
  "remoteAgentEnabled": true,
  "remoteRelayUrl": "ws://YOUR_SERVER:3939/ws/agent",
  "remoteDeviceToken": "replace-with-agent-token"
}
```

All original memories, browser history, files, reminders, notes, and timeline data still remain on your Mac.
