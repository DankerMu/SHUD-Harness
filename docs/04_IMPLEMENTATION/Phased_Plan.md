# 8 周实施计划

## Week 1：Hono API 骨架 + React 壳 + Workspace

交付：

```text
- Bun workspace monorepo 初始化
- Hono 后端: POST /api/workspace/init, POST/GET /api/tasks
- React 前端: Dashboard 壳 + TaskList 组件
- TaskCard Zod schema
- workspace 文件树自动生成
```

验收：前端可创建任务，后端返回空报告骨架。

## Week 2：StackLock + DataProvenance

交付：

```text
- POST /api/stacks/lock (自动采集 repo commits + runtime versions)
- POST /api/data/register (校验 + sha256 计算)
- 前端展示版本信息卡片
- renv.lock 集成
```

验收：任意 task 能绑定 stack_id 和 data_id，前端展示完整版本链。

## Week 3：Sandbox + RunJob + WebSocket 日志流

交付：

```text
- task workspace + git worktree support
- command trace 记录
- POST /api/jobs (local job submit)
- GET /api/jobs/:id (status)
- POST /api/jobs/:id/collect
- WS /ws/logs/:jobId (实时日志流)
- 前端 LogViewer 组件
```

验收：提交 dummy long job，前端实时看日志，park/collect 正常。

## Week 4：Tiny SHUD Loop + 前端结果展示

交付：

```text
- run-shud-tiny-case skill
- SHUD build/run 脚本
- RunRecord 生成
- metrics summary + water balance
- 前端 RunRecord 展示卡片
```

验收：tiny case 可重复运行，前端展示完整 RunRecord。

## Week 5：rSHUD Roundtrip + Compatibility

交付：

```text
- rshud-roundtrip-test skill
- old-output fixture check
- ChangeRequest Zod schema
- PATCH /api/patches/:id/diff 和 /bundle
- 前端 patch diff 展示
```

验收：能发现 old-output reader 失败并在前端展示报告。

## Week 6：Sensitivity Analysis + 前端图表

交付：

```text
- AnalysisPlan mode=sensitivity
- batch parameter runner
- sensitivity_results.parquet → DuckDB
- 前端 tornado 图 + sensitivity table 组件
```

验收：PI 在 Web 界面指定参数后，系统生成敏感性表 + 图表。

## Week 7：Memory/Skills + Cost Dashboard + PI 审批

交付：

```text
- MemoryNote (note + evidence_note)
- POST/GET /api/notes
- skill loader (SKILL.md from .zero/skills/)
- inference budget 实时追踪
- 前端 CostDashboard 组件
- 前端 ApprovalButtons 组件
```

验收：Dashboard 显示 LLM 成本，notes 可保存，PI 可点审批按钮。

## Week 8：端到端 Web Demo + 对话 + 恢复

交付：

```text
- WS /ws/chat (LLM streaming 对话)
- 前端 ChatInterface 组件
- engineering task demo: 对话驱动的 event diagnostics 添加
- science-assist task demo: 对话驱动的敏感性分析
- rollback test
- job failure recovery test
- 部署文档
```

验收：PI 在浏览器中对话 + 看报告 + 点审批即可完成全流程。

## 不在 8 周内做

```text
- Harness Optimizer
- multi-agent autonomous loop
- full HPC scheduler integration (slurm)
- release gate platform
- complex memory review workflow
- 多用户并发 session 管理
```
