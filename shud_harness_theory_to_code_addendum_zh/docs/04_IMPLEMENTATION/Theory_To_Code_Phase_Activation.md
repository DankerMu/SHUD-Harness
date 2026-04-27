# Theory-to-Code Phase Activation Addendum

**状态**：建议补到 `docs/Phased_Spec_Activation.md` 与 `docs/04_IMPLEMENTATION/Phased_Plan.md`  
**目标**：明确 Theory-to-Code 规范在哪些阶段激活，避免阻塞 Week 1 skeleton，但也避免 Phase 4 search 先于科学链路。

## 1. Activation principle

Theory-to-Code 不应阻塞 Phase 1/2 的 deterministic skeleton。它从 Phase 3 开始作为科学运行层约束，从 Phase 4 开始作为 search/calibration 前置 gate。

## 2. Phase mapping

| Phase | 激活程度 | 文档 |
|---|---|---|
| Phase 1 骨架 | 只准备 schema placeholder，不强制 UI | Support schema placeholder |
| Phase 2 执行闭环 | Runner preflight 初版 | Preflight_And_Mutation_Boundary_Spec |
| Phase 3 科学运行 | 激活 VerificationCase + basic bundle | Verification_Case_Spec, Theory_To_Code_Governance_Spec |
| Phase 4 分析引擎 | 激活 accepted_for_search 前置检查 | Controlled_Search_Boundary_Spec |
| Phase 5 报告治理 | 激活 Theory-to-Code Evidence 报告章节 | Report lineage spec |
| Phase 6 集成交付 | 激活完整 playbook 与 PI gate drill | Scientific_Change_Playbooks |

## 3. Phase 3 change

Phase 3 ccw tiny 不只是“跑通 SHUD”，还应产生一个最小 VerificationCase：

```text
VC-CCW-TINY-001
case_type: tiny_basin
expected: exit_code=0, WB residual threshold, required output exists
run_record_id: RUN-...
artifact_refs: metrics/hydrograph/logs
```

## 4. Phase 4 change

Phase 4 sensitivity/search 前增加：

```text
if analysis is downstream of high-risk change:
  require bundle.status in accepted_for_search | accepted
else:
  require baseline_run_id for improvement claims
```

## 5. Phase 5 change

Report template 增加 Theory-to-Code Evidence，尤其用于 code_change / numerical implementation / physical equation tasks。

## 6. 验收标准

- [ ] Phase 3 tiny run 能生成 VerificationCase。
- [ ] Phase 4 search preflight 能阻止未 accepted_for_search 的高风险 change。
- [ ] Phase 5 report 能展示 theory-to-code evidence。
