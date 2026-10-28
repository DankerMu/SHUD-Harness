---
status: living
canonical_for: [spec-gaps-register]
---

# Spec 缺口与歧义登记册

跨文档矛盾、未定义行为与竞态条件的登记。实现代码对某个缺口做出选择时，在对应条目的 **实现选择** 填入「决定 + PR/提交」；reviewer 据此检查同一歧义点是否只有一种解释。
**行号为 2026-04 冻结前所记，M3 建对象前须逐条重核**（处置表执行后文件已裁剪）。原载 `.agents/skills/shud-gov/knowledge/spec-gaps.md`（2026-10-20 降级为文档，skill 删除；GAP-07 分页与 GAP-08/RACE-02 WebSocket 条目随 ADR-0004 K2 失效）。

## 已确认的跨文档矛盾

### GAP-01: EvidenceReport revision_requested 是否回退

- **已定选择（M3 design D4/D7）**：revision_requested 的 EvidenceReport 保持终态，TaskCard 回 planned；每次 report_generate 分配新 report_id，旧报告字节与 decision_history 不变。
- **边界**：不定义新旧报告的延续关系，不复用旧 report_id、不把旧报告回退 draft、不继承旧决定历史。
- **依据**：[m3-mvp-1 design](../../openspec/changes/m3-mvp-1/design.md#d4-taskcard-状态机与-closure-谓词)。这是已定实现契约，工具/状态机仍随 M3 对应切片交付。

### GAP-02: RunJob.timed_out 时 TaskCard 如何转换

- Minimal_Schemas.md: RunJob 和 TaskCard 状态机分别定义
- Control_Kernel.md (line 42): TaskCard.runtime_phase 值与 RunJob.status 不对应
- **歧义**: RunJob timed_out 时，TaskCard 进入 parked 还是保持 running?
- **影响**: 作业卡状态呈现、状态机校验
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

### GAP-07 分页 / GAP-08 WebSocket 重连：已随 ADR-0004 K2 失效

作业完成事件的持久化由 durable JobRegistry 的 `job/settled` 落盘保证（K8）；编号保留不复用。

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

### RACE-03: 双重 collect（retry 时日志追加）

- **场景**: 第一次 collect 成功; retry 时日志已追加; digest 变化; 创建第二个 RunRecord
- **问题**: 幂等性破坏
- **防护**: digest 不用内容 hash（见 GAP-05）

### RACE-04: PI reject 后 agent 反馈循环

- **场景**: PI reject report; comment 标记 generalization_allowed=false; agent 无法把 reason 当通用指导
- **问题**: agent 反复创建类似 task
- **防护**: reject reason 绑定到特定 task，不扩散到其他 task

## Spec 中标记为 "TBD" 或 "MVP 不实现" 的项目（2026-10-20 重核）

- Container/SLURM backend — Source: Minimal_Schemas.md RunJob 注释
- Tiny benchmark 具体数值 — 已定义：ccw END=30 天，`04_IMPLEMENTATION/Test_Fixtures_And_Command_Matrix.md` §4 + `03_SPEC/SHUD_Output_Variables.md` §13
- SHUD 输出变量中哪些是 "optional event diagnostics" — 仍未定义（GAP_ANALYSIS 已删，见 tag archive/zero-v0.8.3）
- 三仓库 worktree 策略 — 已定义：`<workspace>/shud/` 为运行副本，源 submodule 只读（`04_IMPLEMENTATION/Repository_Layout.md` §2）

## 审查用法（按 diff 内容裁剪）

不是所有条目都适用于每个 PR，只检查与 diff 相关的项；对已记录「实现选择」的 GAP 验证代码是否一致，对未记录的标注代码做了什么选择并要求回填本文。

不是所有检查项都适用于每个 PR。只检查与 diff 相关的项:

### 如果 diff 涉及 EvidenceReport / report 相关代码:
- [ ] GAP-01：revision_requested 保持旧报告终态、TaskCard 回 planned；重新生成使用新 report_id，旧报告与决定历史不变。
- [ ] 如果两处代码做了不同选择，标注不一致

### 如果 diff 涉及 RunJob / TaskCard 状态转换:
- [ ] GAP-02: 验证 RunJob.timed_out 时 TaskCard 如何转换
- [ ] GAP-03: 验证 cost_budget.max_compute_minutes 是硬限制（SIGTERM）还是软监控

### 如果 diff 涉及对象创建（TaskCard/RunJob/RunRecord 等）:
- [ ] GAP-04: 验证 ID 生成方式——sequential counter 还是 UUID?
- [ ] 如果多处代码生成 ID，检查策略是否一致

### 如果 diff 涉及 collect / 幂等逻辑:
- [ ] GAP-05: 验证 output_digest 算法——用了什么? 日志追加是否会改变 digest?

### 如果 diff 涉及 RunJob schema:
- [ ] GAP-06: 验证 pid 字段在不同 backend 下的处理

### 如果 diff 涉及 job 监控 / watcher:
- [ ] GAP-09: 检查是否有 stale job 检测逻辑

### 如果 diff 涉及 artifact 引用:
- [ ] GAP-10: 检查是否 graceful 处理 dead artifact reference

## 竞态条件检查

只在相关代码出现时检查:

- [ ] RACE-01: RunJob 状态转换是否用 CAS 或等效的原子操作?
- [ ] RACE-03: collect 逻辑中的 digest 是否避免了内容 hash?
