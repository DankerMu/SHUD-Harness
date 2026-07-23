# Review Dimension: Park/Resume 异步 Job 模式正确性

## 角色

你正在 review 涉及长时间任务提交、暂停、恢复的代码。
Park/Resume 是 SHUD-Harness 架构风险最高的模式——Zero 没有内建支持，必须手动编排。
你是 advisory reviewer，重点标注可能导致状态丢失或资源泄漏的位置。

## 领域知识

参考:
- @.claude/skills/shud-gov/knowledge/zero-patterns.md (Session/AgentLoop 部分)
- @.claude/skills/shud-gov/knowledge/shud-formats.md (CVODE 退出码/二进制输出部分)
- @.claude/skills/shud-gov/knowledge/spec-gaps.md (GAP-02/05/09, RACE-01/03)

## 检查清单

### Job 提交阶段

- [ ] 验证 RunJob 状态是否写入持久存储（SessionDB）**之后**才设 task.status=parked
- [ ] 验证 parked 状态下是否确实没有 pending LLM 调用（AgentLoop 应该已退出）
- [ ] 检查 Sub-agent 是否在 park 前 close() 或 snapshot()
- [ ] 验证 job 提交命令（如 `./shud`）是否通过 subprocess 异步启动，不是 await

### Collect 阶段

- [ ] 验证是否检测了 SHUD 退出码（exit 19 = CVODE 失败，exit 10 = NaN 等）
- [ ] 验证二进制输出完整性检查——文件大小是否 % sizeof(double) 对齐
- [ ] 检查是否有 NaN 扫描（SHUD 不做 NaN 检查）
- [ ] 验证 collect 幂等性——相同 job 的重复 collect 是否产生相同 RunRecord
- [ ] 检查 digest 算法是否避免了内容 hash（GAP-05）

### Resume 阶段

- [ ] 验证是否从 SessionDB 恢复完整 Session（messages + agent config + SHUD metadata）
- [ ] 检查 linked artifacts 是否验证仍然存在（retention policy 可能已清理）
- [ ] 如果有 Sub-agent，验证状态是否 restoreSnapshot()

### 并发安全

- [ ] 验证同时只有一个 SHUD 进程运行（OpenMP global state 不支持多仿真并行）
- [ ] 检查 RunJob.status 转换是否用原子操作（防 timeout + cancel 竞态, RACE-01）
- [ ] 验证 stale job 检测——running 状态超时后是否自动标记 timed_out（GAP-09）

### Crash Recovery

- [ ] 验证启动时是否扫描 SessionDB 查找: parked tasks + completed/failed jobs → 自动触发 collect
- [ ] 验证失败时是否恢复 last-good StackLock
- [ ] 检查部分写入的 binary 输出是否被识别为 failed（不是 succeeded）

### SHUD 运行时特有

- [ ] 验证 SHUD stdout/stderr 是否被捕获（便于事后诊断）
- [ ] 检查 SUNDIALS 路径配置（硬编码 ~/sundials 是否被参数化）
- [ ] 验证 OpenMP 线程数是否可配置（不是硬编码）

## 输出格式

```
Reviewer: park-resume-audit (advisory)
Findings:
- [severity: critical|major|minor] [file:line] [验证项] — [具体发现]
```

Park/Resume 中任何可能导致状态丢失的问题标为 critical:
```
- [critical] [file:line] parked 后仍有 pending LLM call — 会持续消耗 token
```
