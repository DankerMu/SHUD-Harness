# 附录 D：ZeRo 参考实现代码定位

以下路径用于开发时快速对照 ZeRo 当前实现：

- README：`README.md`
- 启动主入口：`apps/server/src/main.ts`
- Agent loop：`packages/core/src/agent/agent-loop.ts`
- Task closure：`packages/core/src/agent/task-closure.ts`
- Builtin roles：`packages/core/src/agent/roles.ts`
- Bash tool：`packages/core/src/tool/bash.ts`
- Memory tool：`packages/core/src/tool/memory.ts`
- Skills loader：`packages/core/src/skill/loader.ts`
- 导出工具索引：`packages/core/src/index.ts`
