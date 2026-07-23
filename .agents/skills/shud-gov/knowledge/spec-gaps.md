# SHUD-Harness Spec 已确认缺口与歧义

以下是从 docs/ 文档体系中确认的具体矛盾和未定义行为。
每条标注相关文档出处。实现代码一旦对某个缺口做出选择，应在此文件中记录该选择。

## 已确认的跨文档矛盾

### GAP-01: EvidenceReport revision_requested 是否回退

- Minimal_Schemas.md (line 202-218): `revision_requested` 列为终态之一
- PI_Decision_Comments_Spec.md (line 45-48): 暗示 agent 修改后重新提交
- **歧义**: 同一 EvidenceReport 对象回退到 draft，还是新建一个?
- **影响**: idempotency key 设计、report 历史追溯
- **实现选择**: （待填写）

### GAP-02: RunJob.timed_out 时 TaskCard 如何转换

- Minimal_Schemas.md: RunJob 和 TaskCard 状态机分别定义
- Control_Kernel.md (line 42): TaskCard.runtime_phase 值与 RunJob.status 不对应
- **歧义**: RunJob timed_out 时，TaskCard 进入 parked 还是保持 running?
- **影响**: WebSocket event handler、状态机校验
- **实现选择**: （待填写）

### GAP-03: cost_budget 软限制 vs 硬限制

- Cost_Inference_Budget.md (line 2-9): "软监控指标，不自动中断"
- Minimal_Schemas.md: RunJob.cost_budget.max_compute_minutes 作为结构化字段存在
- **歧义**: Runner adapter 是否在 max_compute_minutes 时 SIGTERM?
- **影响**: 长时间 SHUD 运行是被杀还是被放行
- **实现选择**: （待填写）

## 完全未定义的行为

### GAP-04: ID 生成策略

- Minimal_Schemas.md 使用 TASK-0001, JOB-0001 等示例
- 无任何文档定义: sequential vs UUID, 计数器存储位置, 并发安全
- **影响**: 并发创建时 ID 碰撞
- **实现选择**: （待填写）

### GAP-05: output_digest 算法（幂等 collect）

- Park_Resume_Design.md (line 135-149): "collect 必须幂等"
- Idempotency_Concurrency_Locking_Spec.md (line 49): key = `job_id + output_digest_or_exit_marker`
- **未定义**: digest 是什么? 内容 hash 会因日志追加而变化
- **建议**: exit_code + file_count + total_bytes（不用内容 hash）
- **实现选择**: （待填写）

### GAP-06: RunJob.pid 条件存在性

- Minimal_Schemas.md (line 122): `pid: null` 注释"仅 local_job 填写"
- **未定义**: docker_job 时存容器 ID 还是 null? local_direct 时有 pid 吗?
- **实现选择**: （待填写）

### GAP-07: 分页契约

- Performance_NFR_Spec.md (line 78): "大型 timeseries 必须分页"
- **未定义**: limit/offset 还是 cursor? 默认 page size? 最大 page size?
- **实现选择**: （待填写）

### GAP-08: WebSocket 重连事件缺口

- WebSocket_Protocol.md (line 7-13): `since_seq` 参数
- **未定义**: event log 保留多少条? 缺口时 snapshot 的 seq 是否保证 ≥ since_seq?
- **实现选择**: （待填写）

### GAP-09: 卡在 running 的 RunJob

- **无任何文档**定义 stale job 检测超时
- **建议**: running > 24h 无 heartbeat → auto timed_out
- **实现选择**: （待填写）

### GAP-10: 报告引用已清理的 artifact

- Artifact_Registry_Spec.md (line 113-117): 有 retention policy
- **未定义**: report 引用的 artifact 被清理后怎么办? 报告失效? graceful degradation?
- **实现选择**: （待填写）

## 已确认的竞态条件

### RACE-01: RunJob timeout + 手动 Cancel 同时发生

- **场景**: RunJob 30min 超时，watcher 设为 timed_out; 同时人工点 Cancel
- **问题**: collect handler 不知道期望哪个终态
- **防护**: 状态转换必须用 CAS 操作

### RACE-02: WebSocket 断连期间事件丢失

- **场景**: 断连时生成 events 1001-1100; reconnect 时 event log 只保留 500 条
- **问题**: 1001-1100 已丢失，snapshot 可能也过时
- **防护**: event log 保留量可配置 + reconnect 能检测 gap

### RACE-03: 双重 collect（retry 时日志追加）

- **场景**: 第一次 collect 成功; retry 时日志已追加; digest 变化; 创建第二个 RunRecord
- **问题**: 幂等性破坏
- **防护**: digest 不用内容 hash（见 GAP-05）

### RACE-04: PI reject 后 agent 反馈循环

- **场景**: PI reject report; comment 标记 generalization_allowed=false; agent 无法把 reason 当通用指导
- **问题**: agent 反复创建类似 task
- **防护**: reject reason 绑定到特定 task，不扩散到其他 task

## Spec 中标记为 "TBD" 或 "MVP 不实现" 的项目

- Container/SLURM backend — Source: Minimal_Schemas.md RunJob 注释
- Tiny benchmark 具体数值（用哪个流域、什么时段、验收阈值） — Source: GAP_ANALYSIS.md line 75-81
- SHUD 输出变量中哪些是"optional event diagnostics" — Source: GAP_ANALYSIS.md line 84-87
- 三仓库 git worktree 策略（submodule vs fresh clone） — Source: GAP_ANALYSIS.md line 89-92
