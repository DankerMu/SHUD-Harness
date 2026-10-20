---
status: frozen
---

# Task Playbooks (dsh 对话交互)

> 交互面 = `dsh --profile shud` 自带聊天、审批卡片、作业卡片 + Markdown 报告文件（ADR-0004 K2/K7）；下列步骤中的工具与 seam 名以 [Phased_Plan v2](Phased_Plan.md) 为准。

## 1. 工程任务：添加输出诊断

```text
PI 在对话框输入：添加 event_flux 诊断，但不能破坏旧 rSHUD reader。

步骤：
1. Coordinator 建 TaskCard (type=engineering)，记录经 `ctx.storage` 持久化
2. Coordinator 生成 StackLock（SHUD/rSHUD/AutoSHUD 版本 + `git status` + llm 三字段）
3. Coordinator 调用 `shud_run` 工具跑 baseline tiny，经 `ctx.jobs` 提交
   → dsh 作业卡片展示编译/运行日志
4. Worker 修改 SHUD output (在 worktree 中)
5. Worker 修改 rSHUD reader
6. `shud_run` 跑 tiny；rSHUD roundtrip + old-output fixture 走 `scripts/` 确定性脚本；`shud_collect` 解析产物 → RunRecord
7. 生成 ChangeRequest + patch bundle
8. 生成 EvidenceReport（Markdown 文件写入 workspace `reports/`）→ 对话中给出路径与摘要
9. 合入动作经 `tools/pre-execute` 返回 ask → dsh 审批卡片 → PI 批准或拒绝（修订意见在对话中回复）
```

## 2. 科学辅助任务：洪峰偏低敏感性分析

```text
PI 在对话框输入：对 Cache Creek storm，检查 ksat 和 roughness 对洪峰的敏感性。

步骤：
1. Coordinator 建 TaskCard (type=science_assist)
2. Coordinator 登记 DataProvenance
3. Coordinator 创建 AnalysisPlan (mode=sensitivity)
4. 调用 `shud_run` 跑 baseline，经 `ctx.jobs` 提交 → dsh 作业卡片展示日志
5. 逐参数集调用 `shud_run`（6 组合），每组一个独立作业
   → 长任务: agent park（空闲），作业完成通知自动唤醒新 turn
6. `shud_collect` 汇总 metrics；tornado 图作为 figure artifact 写入 run 目录
7. 生成 EvidenceReport Markdown → 对话中给出路径与摘要
8. PI 在对话中选择下一步（涉及治理动作时经 `tools/pre-execute` 返回 ask → dsh 审批卡片）
```

Agent 不得写："H2 is validated"。
Agent 可以写："Within this event, peak timing is more sensitive to hillslope roughness multiplier than ksat multiplier."

## 3. 运维任务：记录失败经验

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
