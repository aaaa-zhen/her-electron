# Her 内置 Anthropic OAuth Token 改造记录

## 背景

Her 原来通过第三方代理（packyapi.com）或用户手动配置 API Key 来调用 Claude。现在要改成直接内置 Anthropic 的 OAuth Token（`sk-ant-oat` 开头），让用户开箱即用，不需要任何配置。

## 遇到的问题

### 问题 1：旧配置残留

`settings.json` 里存了一个无效的 `apiKey` 值（一条 shell 命令被误存进去了），由于代码优先级是：

```
settings.apiKey > 环境变量 > 内置 key
```

无效值优先被使用，内置 key 永远不会生效。

**解决**：清理 `settings.json`，移除无效的 `apiKey` 字段。

### 问题 2：403 Request not allowed

清理配置后，内置 key 生效了，但每次请求都返回 403。

用 curl 测试同样的 token —— **200 成功**。
用 Node.js `fetch` 测试 —— **403 失败**。

**根因**：Anthropic 的 OAuth token 要求请求必须携带特定的 `user-agent` header（如 `claude-cli/2.1.44`）来验证请求来源。但 **Node.js 的 `fetch` 会静默丢弃自定义 `user-agent` header**（这是 Node 的安全限制），导致 Anthropic 服务端认为请求来源非法，直接拒绝。

```
curl（能设 user-agent）     → 200 ✅
Node fetch（吞掉 user-agent）→ 403 ❌
Electron net.fetch（能设）    → 200 ✅
Anthropic SDK（内部处理）     → 200 ✅
```

## 解决方案

将 `chat-session.js` 中的手动 `fetch` 请求替换为 **Anthropic 官方 SDK 的 stream 模式**。SDK 在检测到 OAuth token 时会：

1. 使用 `authToken` 参数（而非 `apiKey`）
2. 自动附加正确的 `anthropic-beta` 和 `user-agent` headers
3. 在 Electron 环境下使用 `net.fetch`（不受 Node 对 user-agent 的限制）

```javascript
// 之前：手动 fetch（user-agent 被 Node 吞掉 → 403）
const response = await fetch(endpoint, {
  method: "POST",
  headers: { "user-agent": "claude-cli/..." }, // 被 Node 丢弃
  body,
});

// 之后：用 Anthropic SDK（正确处理 OAuth headers）
const anthropic = createAnthropicClient(settingsStore);
const stream = anthropic.messages.stream(payload);
for await (const event of stream) {
  // 处理流式事件
}
```

## 修改的文件

### 1. `src/core/chat/anthropic-client.js`

- 内置 OAuth Token 作为 fallback
- 优先级：用户设置 > 环境变量 > 内置 token

```javascript
const BUILTIN_API_KEY = "sk-ant-oat01-sb-...";

function createAnthropicClient(settingsStore) {
  const apiKey = settings.apiKey || process.env.ANTHROPIC_API_KEY || BUILTIN_API_KEY;
  const isOAuth = apiKey.startsWith("sk-ant-oat");
  return new Anthropic({
    apiKey: isOAuth ? null : apiKey,
    authToken: isOAuth ? apiKey : null,
    // OAuth 时自动附加正确 headers
  });
}
```

### 2. `src/core/chat/chat-session.js`

- 引入 `createAnthropicClient`
- 将手动 `fetch` + SSE 解析替换为 SDK `messages.stream()`
- `needsApiKey` 永远返回 `false`（不再弹 API key 设置引导）
- 保持原有的流式事件 emit 逻辑不变（`type: "stream"`）

### 3. `server.js`

- 同样内置 OAuth Token 作为 fallback
- `createAnthropicClient()` 和 `isOAuthMode()` 都使用内置 key

### 4. `src/core/storage/settings-store.js`

- 默认 `baseURL` 从 `https://www.packyapi.com` 改为 `https://api.anthropic.com`

### 5. `~/.config/Her/data/settings.json`（运行时配置）

- 清除残留的无效 `apiKey`
- `baseURL` 设为 `https://api.anthropic.com`

## 关键知识点

| 特性 | 说明 |
|------|------|
| OAuth Token 格式 | 以 `sk-ant-oat` 开头 |
| 验证方式 | `Authorization: Bearer <token>` + 特定 `user-agent` |
| 必须的 beta header | `anthropic-beta: claude-code-20250219,oauth-2025-04-20` |
| Node fetch 限制 | 不允许设置自定义 `user-agent`（安全限制） |
| Electron net.fetch | 允许设置任意 header（SDK 内部会使用） |
| API Key 优先级 | 用户手动设置 > 环境变量 > 内置 token |
