# Zero 运行时扩展模式

以下事实从 Zero 源码提取。每条标注出处。
如果 Zero 代码已更新导致以下描述不准确，以代码为准并更新本文件。

## Tool 扩展接口

- Tool 继承 `BaseTool`（抽象类） — Source: zero/packages/core/src/tool/base.ts
- 必须实现: `name: string`, `description: string`, `parameters: Record<string, unknown>`, `execute(ctx, input): Promise<ToolResult>` — Source: zero/packages/core/src/tool/base.ts
- `parameters` 是 **JSON Schema 格式**（`{ type: 'object', properties: {...}, required: [...] }`），不是 Zod — Source: zero/packages/core/src/tool/base.ts
- 输入验证通过 `validateRequiredFields()` 手动检查 `required` 数组 — Source: zero/packages/core/src/tool/base.ts
- `ToolResult` 结构: `{ success: boolean; output: string; outputSummary: string; artifacts?: string[] }` — Source: zero/packages/shared/src/types/
- 所有错误必须转为 string，不能 throw 到 `execute()` 外部 — Source: zero/packages/core/src/tool/base.ts (run方法的catch)
- 注册在 `ToolRegistry` via `register(tool)` — Source: zero/packages/core/src/tool/registry.ts
- 注册点是 `apps/server/src/main.ts` 启动序列 — Source: zero/apps/server/src/main.ts

## ToolContext 结构

- 提供: sessionId, currentModel, workDir, projectRoot, logger, tracer, secretFilter, observability, secretResolver, memoryRetriever, memoryStore, channelBinding, schedulerHandle, agentControl — Source: zero/packages/core/src/tool/base.ts

## Session 与状态持久化

- Session 状态通过 `SessionDB` (SQLite) 持久化 — Source: zero/packages/observe/src/session-db.ts
- 表: `sessions`(metadata + agent config JSON), `session_messages`(完整对话历史 JSON), `channel_models` — Source: zero/packages/observe/src/session-db.ts
- 保存: `sessionDb.saveSession(data, agentConfigJson, systemPrompt)` — Source: zero/packages/observe/src/session-db.ts
- 启动时从 DB 加载中断的 session — Source: zero/apps/server/src/main.ts

## AgentLoop 与 Hooks

- `AgentLoop` 运行 LLM tool-use 循环 — Source: zero/packages/core/src/agent/agent-loop.ts
- Hooks (`AgentLoopHooks`): pre-request content, completion start/end, tool call start/end, text deltas, interruption — Source: zero/packages/core/src/agent/agent-loop.ts
- hooks 是 awaited 的 — 如果 hook block，session 整体 block — Source: zero/packages/core/src/agent/agent-loop.ts
- 无 hook timeout 机制 — Verified: 2026-04-26

## Sub-agent 管理

- `AgentControl` 管理 spawned sub-agents — Source: zero/packages/core/src/agent/agent.ts
- 状态: running | waiting | completed | failed | closed — Source: zero/packages/core/src/agent/agent.ts
- 状态是**内存态**，不自动持久化 — Source: zero/packages/core/src/agent/agent.ts
- `AgentSnapshot` 是 snapshot-in-time，需手动 restoreSnapshot() — Source: zero/packages/core/src/agent/agent.ts
- Park/Resume 必须手动编排: save → exit loop → [外部事件] → restore — Verified: 2026-04-26

## Memory 系统

- 文件系统存储: `.zero/memory/` 目录，Markdown + YAML frontmatter — Source: zero/packages/memory/src/
- 向量索引 via Vectra（需 embedding API） — Source: zero/packages/memory/src/
- 不在 SessionDB 中 — Verified: 2026-04-26

## 包依赖图

- Leaf: `@zero-os/shared`（所有包都 import）, `@zero-os/secrets` — Source: zero/packages/*/package.json
- Core hub: `@zero-os/core` → shared + model + observe + secrets + memory — Source: zero/packages/core/package.json
- Channel: `@zero-os/channel` → core + observe + shared — Source: zero/packages/channel/package.json
- 正确方向: SHUD domain → @zero-os/core（单向）— Verified: 2026-04-26
- 禁止方向: @zero-os/core → SHUD domain — Verified: 2026-04-26

## 构建系统

- 包管理器: Bun（不是 npm/yarn） — Source: zero/bun.lock
- Workspaces: `packages/*`, `apps/*`, `benchmarks/*` — Source: zero/package.json
- 开发期不编译（直接导入 TypeScript src/） — Verified: 2026-04-26
- Linter: Biome — Source: zero/biome.json
- TypeScript: strict mode, ESNext target — Source: zero/tsconfig.base.json

## Streaming 与消息流

- 消息流: Channel → MessageHandler → SessionManager → Session.handleMessage() — Source: zero/apps/server/src/message-handler.ts
- Streaming via `onTextDelta` callback — Source: zero/packages/core/src/session/session.ts
- 不是 RPC 式，是 callback 式 — Verified: 2026-04-26

## 错误处理

- 瞬态错误(429/503): 指数退避 `Math.min(5000 * 2^(attempt-1), 60000)` ms, 最多 3 次 — Source: zero/packages/core/src/agent/agent-loop.ts
- 空响应: 通过 `onEmptyResponse` hook 处理 — Source: zero/packages/core/src/agent/agent-loop.ts
- Tool 错误: 转为 ToolResult(success=false)，不 throw — Source: zero/packages/core/src/tool/base.ts

## Graceful Shutdown

- `isShuttingDown()` flag 在 message handler 中 — Source: zero/apps/server/src/message-handler.ts
- 关闭时需: close pending agents, flush observability, save state — Verified: 2026-04-26
