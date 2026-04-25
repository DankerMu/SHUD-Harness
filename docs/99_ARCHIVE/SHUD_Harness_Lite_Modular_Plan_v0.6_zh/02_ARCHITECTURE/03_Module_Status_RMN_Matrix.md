# 模块状态矩阵：[R] / [M] / [N]

## 1. 标注含义

- **[R]**：ZeRo 中有实现模式可参考，但 SHUD-Harness Lite 自己实现。
- **[M]**：如果未来接入 ZeRo，需要修改 ZeRo 的部分。
- **[N]**：SHUD-Harness Lite 必须新增，ZeRo 无现成领域能力。

## 2. 矩阵

| 模块 | 状态 | MVP 说明 |
|---|---:|---|
| CLI task manager | [N] | 核心入口，必须新增 |
| TaskCard | [N] | 统一承载工程/科学辅助/运维任务 |
| Coordinator kernel | [R]/[N] | 参考 ZeRo loop，自己实现 Brief/Plan/Park/Report |
| Bash sandbox | [R]/[N] | 参考 ZeRo BashTool，增强 SHUD workspace 和 trace |
| Job manager | [N] | 支持长任务 submit/poll/collect |
| RunRecord | [N] | SHUD 运行结果记录 |
| StackLock | [N] | 包含 env 和 harness 版本 |
| DataProvenance | [N] | 合并 dataset/observation/preprocess |
| AnalysisPlan | [N] | 包含 sensitivity/calibration/benchmark 三类分析 |
| EvidenceReport | [N] | 合并 evidence/validation/report |
| ChangeRequest | [N] | 合并 change/output contract/compat checks/gates |
| Memory notes | [R]/[M]/[N] | 参考 ZeRo memory；禁止默认 verified；Lite 用 draft notes |
| Skills | [R]/[N] | 采用 SKILL.md 格式，但生命周期简化 |
| Reviewer | [R]/[N] | 只做工程/报告完整性检查 |
| Cost budget | [N] | ZeRo 不解决 SHUD 任务成本治理 |
| Data storage | [N] | DuckDB/Parquet/artifact retention |
| Failure recovery | [N] | worktree rollback、job retry、state machine |
| Incremental benchmark | [N] | 根据变更影响选择 smoke/regression |
| Multiuser lite | [N] | owner/session/lock，不做重 RBAC |
| Web UI | [M]/[N] | MVP 只做静态 report index；未来再接 UI |

## 3. MVP 必做模块

第一阶段只做：

```text
- CLI task manager
- TaskCard
- StackLock
- DataProvenance
- RunJob / RunRecord
- Bash sandbox
- Job manager local backend
- EvidenceReport markdown generator
- ChangeRequest + patch bundle
- Memory notes lite
- 5 个基础 skills
- Cost budget
```

不做：

```text
- Harness Optimizer
- full Critic workflow
- release platform
- complex Web Console
- multi-agent swarm
```
