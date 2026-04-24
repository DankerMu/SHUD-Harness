# ZeRo 路线决策：MVP 不 fork，作为参考实现

## 1. 当前决策

**MVP 不 fork ZeRo。**

SHUD-Harness Lite 从独立极简 runtime 实现开始，ZeRo 仅作为参考实现。

## 2. 原因

### A. 团队规模不支持维护大型 fork

1 名工程师同时维护 SHUD-Harness 领域逻辑和 ZeRo fork，风险过高。

### B. SHUD 的第一痛点不是 agent 平台

MVP 的核心痛点是：

```text
- 数据和版本可复盘；
- 长任务可管理；
- SHUD/rSHUD/AutoSHUD 可运行；
- 报告和 patch 可交付；
- 成本可控。
```

这些可以用 Python/CLI/YAML/SQLite/DuckDB/bash 更快落地。

### C. ZeRo 的通用能力可借鉴，不必依赖

可借鉴的模式包括：

```text
- agent loop hooks；
- bash tool 安全包装；
- session trace；
- skills loader；
- spawn/wait 子 agent；
- scheduler/supervisor 组织方式。
```

但这些不要求直接 fork。

## 3. ZeRo 参考层标注

| 模块 | v0.6 决策 |
|---|---|
| AgentLoop | [R] 读 ZeRo 设计，Lite 自己实现简化 kernel |
| BashTool | [R] 参考 timeout/cwd/stdout/stderr/fuse list，Lite 自己实现 |
| MemoryTool | [M] 若采用 ZeRo，必须禁用默认 verified 写入 |
| Skills loader | [R] 参考 SKILL.md 目录格式，Lite 可直接采用同类格式 |
| Spawn/Wait Agent | [R] 后续可借鉴；MVP 不强依赖多 agent |
| Web control plane | [M] 暂不采用；后续只做 task/job/report 轻量页面 |
| Scheduler/Supervisor | [R] 参考；MVP 用本地 job status + cron/poll 即可 |

## 4. 未来何时考虑接入 ZeRo

满足以下条件后，才考虑 ZeRo adapter 或 fork：

```text
- Lite MVP 已稳定跑通 20+ tasks；
- 明确需要 Web session、多 channel、复杂 multi-agent；
- 工程师有余力维护 TypeScript monorepo；
- ZeRo 上游接口足够稳定；
- 已经列出必须保留/删除/替换的模块。
```

## 5. 如果未来采用 ZeRo，需要修改的关键点

```text
- Memory create 默认 status 不得是 verified；
- role 从 assistant/coder/reviewer 改成 coordinator/worker/reviewer；
- agent loop 要支持 Park/Resume，而不是同步工具循环；
- bash sandbox 要接入 SHUD workspace 和 data read-only mount；
- Web UI 要降级成 task/job/report 视图；
- .zero runtime state 与 shud-workspace research state 分离。
```

## 6. 总结

MVP 路线：

```text
Independent Lite Runtime first;
ZeRo as reference, not dependency.
```

这消除了“两面下注”的执行风险。
