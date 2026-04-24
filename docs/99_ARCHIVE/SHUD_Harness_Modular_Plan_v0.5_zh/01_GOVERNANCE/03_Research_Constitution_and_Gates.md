# G-03 科研宪法、门控与审批体系

## 模块状态标签
- **独立实现**：必须支持
- **ZeRo 参考实现**：弱参考
- **[R] 已实现可复用**：无完整对应层，最多可借用通用工具与 Web UI 交互
- **[M] 需修改后复用**：task closure、session actions、review UI
- **[N] 必须新增**：Research Constitution、Human Gate、ReleaseGate、baseline overwrite policy、risk matrix

## 1. 科研宪法（Research Constitution）
系统内置的所有 Agent 都必须遵守以下规则。

### 1.1 研究问题优先
- 不允许没有问题意识的代码修改
- 不允许没有 RCS 的重要工程变更
- 不允许“先改再找理由”

### 1.2 证据优先
- 没有 baseline，不允许宣称改进
- 没有 water balance / solver health，不允许宣称模型更好
- 单一 basin / single event 提升，不允许外推为普遍改进

### 1.3 数据与版本优先
- 没有 StackLock 的结果不能进 validated benchmark
- 没有 DatasetManifest / ObservationManifest / PreprocessRecipe 的结论不能升级为 validated claim

### 1.4 兼容性优先
- 影响 SHUD 输出消费路径的修改，必须先看 OutputContract
- additive change 优先
- breaking change 必须升版本并触发 human gate

### 1.5 人工责任边界
以下动作不能由 Agent 自动越过：
- 修改物理过程实现
- 修改默认参数
- 覆盖 benchmark baseline
- 放宽 acceptance threshold
- 接受 breaking output contract
- 推入 release gate

## 2. 风险分级
### Low
- 读文件
- 写临时脚本
- 运行 tiny case
- 解析日志
- 生成报告草稿

### Medium
- 修改 episode worktree 代码
- 增加 optional 输出文件
- 新增 regression case
- 提升 skill proposal
- 更新 memory proposal

### High
- 修改默认参数
- 修改方程/物理过程
- 修改 output contract major version
- baseline overwrite
- threshold relaxation
- release promotion

## 3. Human Gate 触发矩阵
| 动作 | 是否强制 Human Gate | 备注 |
|---|---|---|
| 改诊断输出，且为 additive optional file | 视 contract 而定 | 通常 Critic + compatibility suite 即可 |
| 改 output contract major version | 是 | 必须人工 |
| 改默认参数 | 是 | 必须人工 |
| 改 governing equations | 是 | 必须人工 |
| 覆盖 benchmark baseline | 是 | 必须人工 |
| 放松 regression threshold | 是 | 必须人工 |
| 仅新增 smoke benchmark case | 否 | Critic 审查即可 |
| memory proposal promote 为 canonical scientific memory | 视 claim 强度 | 高强度 claim 要人工 |

## 4. Gate 对象
### 4.1 HumanGateRequest
```yaml
gate_id: HG-2026-001
kind: human_gate
reason: default parameter change proposed
linked_change: CHG-2026-021
required_reviewers:
  - scientific_owner
  - runtime_owner
status: pending
```

### 4.2 ReleaseGate
```yaml
release_gate_id: RG-2026-003
linked_change: CHG-2026-021
required_conditions:
  - validation_report_status == pass
  - compatibility_suite == pass
  - benchmark_regression_within_threshold == true
  - human_gate_approved == true
status: pending
```

## 5. Gate 与控制内核的关系
在控制内核里，`Gate` 不应只是日志事件，而是**状态转移条件**：
- gate 未满足：进入 `Pause` 或 `Block`
- gate 满足：允许 `Continue` 或 `Finish`
- gate 触发：可强制 `Escalate`

## 6. Operator 需要看到什么
每个 gate 至少展示：
- 谁触发
- 为什么触发
- 影响对象
- 所需证据
- 当前缺项
- 审批结果
- 审批时间

## 7. 与 ZeRo 的关系
ZeRo 可为 gate 提供：
- session / message / tool traces
- Web control plane
- 用户交互入口

但真正的科研 gate 仍需 SHUD-Harness 新增：
- gate object model
- reviewer workflow
- release/baseline policy
- claim strength promotion policy

## 8. V1 最低要求
- High-risk 动作一律不能自动越过
- gate 能阻止 episode 自动完成
- gate 状态可在 Web Console 查看
- gate 与 ValidationReport / ChangeSpec / BenchmarkPolicy 有关联
