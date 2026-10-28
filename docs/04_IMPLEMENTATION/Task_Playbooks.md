---
status: frozen
---

# Task Playbooks (dsh 对话交互)

> 交互面 = `dsh --profile shud` 自带聊天、审批卡片、作业卡片 + Markdown 报告文件（ADR-0004 K2/K7）；下列步骤中的工具与 seam 名以 [Phased_Plan v2](Phased_Plan.md) 为准。

M3 交付目标以 [m3-mvp-1 design](../../openspec/changes/m3-mvp-1/design.md) 为准；以下首任务流程中的报告工具与角色 preset 随该 change 后续切片交付，不表示当前均已挂载。已挂载工具用法见 [Repository Layout](Repository_Layout.md)。

## M3 首任务：ccw 运行与报告

1. Coordinator 调用 `task_create(type="science_assist", title, question_or_goal)`，记录落到会话工作区 `tasks/<task_id>/task.json`，不经 `ctx.storage`。
2. Coordinator 通过 `subagent` 显式派发 `worker`，任务含 `task_id` 与输入副本路径；coordinator 不直接调用 `shud_run`。
3. Worker 调用 `shud_run(task_id, input_dir)`。提交器确定性采集/复用 `stacks/<stack_id>.json` 并从运行输入副本生成 `provenance/<data_id>.json`；不是由模型编造版本或 hash。
4. Worker 用当前 `dsh_job_id` 调 `job_output` 等待，再用持久 `run_id` 或 `job_id` 调 `shud_collect`，取得终态 RunRecord 后才返回。#426 实测子会话 SHUD 唤醒未送达，不能以唤醒或 job_output 单独代替收集证据；coordinator 保留自行 collect 的兜底。
5. Coordinator 调用 `report_generate`，再 `report_validate`；报告对象为 `reports/<report_id>.json`，Markdown 为同名 `.md` 的确定性投影。缺失的 metrics/图表写入 limitations，M3 不生成这些科学指标。
6. Coordinator 调用 `report_submit`，PI 经 Web 审批决定；未获放行保持 reviewed，后续 comment 与 `report_decide` 流程见 [PI 决策规范](../03_SPEC/PI_Decision_Comments_Spec.md) 及 [M3 policy-gate 契约](../../openspec/changes/m3-mvp-1/specs/policy-gate/spec.md)。工程检查不代替 PI 验收。

下列工程、敏感性分析与运维画像属于后续里程碑；M3 `task_create` 仅接受 science_assist，不能把 engineering/ops 或 AnalysisPlan 示例当成当前工具能力。

## 1. 工程任务：添加输出诊断（M4 规划）

```text
PI 在对话框输入：添加 event_flux 诊断，但不能破坏旧 rSHUD reader。

步骤：
1. Coordinator 规划工程 TaskCard；工程类型工具入口在 M4 定义，领域记录使用工作区文件，不经 ctx.storage
2. 运行提交路径负责 StackLock（SHUD/rSHUD/AutoSHUD 版本 + dirty_paths + llm 三字段）
3. Coordinator 派 Worker 调用 shud_run 跑 baseline tiny，经 ctx.jobs 提交
   → dsh 作业卡片展示编译/运行日志
4. Coder 修改 SHUD output（在可写工作副本中，不改只读 submodule）
5. Coder 修改 rSHUD reader
6. Worker 以 shud_run 跑 tiny；rSHUD roundtrip + old-output fixture 走 scripts/ 确定性脚本；shud_collect 收集产物元数据 → RunRecord
7. 生成 ChangeRequest + patch bundle
8. 生成 EvidenceReport（Markdown 文件写入 workspace `reports/`）→ 对话中给出路径与摘要
9. 合入动作经 `tools/pre-execute` 返回 ask → dsh 审批卡片 → PI 批准或拒绝（修订意见在对话中回复）
```

## 2. 科学辅助任务：洪峰偏低敏感性分析（M5 规划）

```text
PI 在对话框输入：对 Cache Creek storm，检查 ksat 和 roughness 对洪峰的敏感性。

步骤：
1. Coordinator 以 task_create 建 TaskCard（type=science_assist）
2. 每次提交从输入副本确定性生成 DataProvenance
3. Coordinator 创建 AnalysisPlan（mode=sensitivity，M5 能力）
4. Coordinator 派 Worker 调用 shud_run 跑 baseline，经 ctx.jobs 提交
5. Worker 逐参数集调用 shud_run（6 组合），每组一个独立作业
   → Worker 等待并以 shud_collect 取得终态记录后返回，不假定子会话 SHUD 唤醒可用
6. shud_collect 只返回 RunRecord；metrics/tornado 图由 M5 的独立确定性分析生产者生成，不冒充 M3 已有能力
7. Coordinator 通过 report_generate/report_validate/report_submit 生成、校验并提交报告
8. PI 在对话中选择下一步（涉及治理动作时经 `tools/pre-execute` 返回 ask → dsh 审批卡片）
```

Agent 不得写："H2 is validated"。
Agent 可以写："Within this event, peak timing is more sensitive to hillslope roughness multiplier than ksat multiplier."

## 3. 运维任务：记录失败经验（后续画像，非 M3 工具入口）

```text
Coordinator 自动记录一次兼容性失败：

1. Coordinator 建 TaskCard (type=ops)
2. Worker 在 dsh sandbox 中执行诊断，日志在对话 / 作业卡片中可见
3. 记录 compatibility_note (tags=["rshud","output-compatibility"])：MVP 不做记忆（ADR-0004 K11），
   先写入 EvidenceReport 的 limitations 段；记忆落点待 M6 评估
4. task done → 对话中回报
```

不需要 Reviewer，不需要 Coordinator approval。

## 4. Scientific Change Playbooks

并入 [Scientific_Change_Playbooks.md](Scientific_Change_Playbooks.md)。

### Playbook 4a：修改物理方程

```text
1. 创建 TaskCard(type=science_assist/code_change)。
2. 创建 ChangeRequest(semantic_level=physical_equation)。
3. 创建 TheoryToCodeBundle。
4. 填写 TheoryNote：科学问题、过程范围、假设、非目标、PI questions。
5. 填写 EquationSpec：符号、单位、公式、dimension checks。
6. 填写 DerivationRecord：推导步骤、假设、未决问题。
7. 填写 NumericalSchemeSpec：state/flux/source/boundary/conservation/stability。
8. PI/Reviewer 审查 theory/derivation/scheme。
9. 创建 ImplementationMapping，生成 patch。
10. 定义 VerificationCase。
11. 运行 verification，保留 RunRecord/artifact。
12. 生成 EvidenceReport，包含 Theory-to-Code Evidence。
13. PI gate：accepted / accepted_for_search / revision / reject。
14. 只有 accepted_for_search 后才允许 sensitivity/calibration。
```

### Playbook 4b：数值实现重构但物理语义不变

```text
1. ChangeRequest semantic_level=numerical_implementation 或 pure_engineering。
2. 如果可能影响数值结果，创建 bundle。
3. ImplementationMapping 标记 refactor_same_semantics。
4. VerificationCase 使用 regression + mass_balance。
5. 比较 old/new outputs within tolerance。
6. Report 写工程等价性，不写科学机制结论。
```

### Playbook 4c：修改默认参数

```text
1. ChangeRequest semantic_level=parameter_default。
2. TheoryNote 说明参数物理意义和修改动机。
3. EquationSpec 可引用该参数相关公式。
4. VerificationCase 至少包含 regression/tiny_basin。
5. Calibration result 只能作为候选证据。
6. PI gate 必须 comment。
7. accepted 后才可更新默认配置或文档。
```

### Playbook 4d：输出变量语义变化

```text
1. semantic_level=output_semantics。
2. 更新 ImplementationMapping.output_semantics_changes。
3. 检查 SHUD_Output_Variables、rSHUD reader（原 Visualization_Data_Spec 已删，见 tag archive/zero-v0.8.3）。
4. VerificationCase 使用 output_semantics + rSHUD roundtrip。
5. PI gate 审批是否接受 breaking semantic change。
```

### Playbook 4e：参数搜索 / calibration

```text
1. 确认模型结构和 bundle 已 accepted_for_search，或任务是低风险参数分析。
2. 确认 baseline_run_id。
3. 确认 fixed data_id、stack_id、eval_script_hash。
4. 运行 AnalysisPlan。
5. 生成 ExperimentLedger。
6. Report 写 performance / sensitivity observation，不写 theory validation。
```

### Scientific Change 通用禁令

- 不允许绕过 bundle 直接搜索高风险科学变更。
- 不允许把失败 verification 删除。
- 不允许把 PI comment 自动推广为普遍事实。
- 不允许 Agent 自行 accepted。

### Scientific Change Playbooks 验收标准

- [ ] physical equation playbook 包含 TheoryNote/Equation/Derivation/Scheme/Mapping/Verification/PI gate。
- [ ] calibration playbook 强制 baseline 和 accepted_for_search。

## 5. Patch review playbook

```text
1. Ensure patch only touches allowed worktree files.
2. Ensure tiny benchmark was run if executable code changed.
3. Ensure old-output check was run if output/reader changed.
4. Ensure report lists StackLock and DataProvenance.
5. If interface breaking, mark needs_pi_approval → `tools/pre-execute` 返回 ask → dsh 审批卡片.
```
