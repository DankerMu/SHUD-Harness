# Theory-to-Code Requirements Addendum

**状态**：建议并入 `docs/00_INDEX/Requirements_Catalog.md`  
**编号策略**：为避免和现有 `FR-###` 冲突，本补充暂用 `FR-TC-*`、`GR-TC-*`、`TR-TC-*`、`NFR-TC-*`。Claude 合并时可映射到仓库正式编号。

## 1. User Stories

| ID | 角色 | 用户故事 | 优先级 | 验收标准 |
|---|---|---|---:|---|
| US-TC-001 | PI | 作为 PI，我希望任何物理方程或模型假设变更都有理论说明、公式、推导和代码映射。 | P0 | 高风险 ChangeRequest 必须引用 TheoryToCodeBundle |
| US-TC-002 | PI | 作为 PI，我希望能区分 verification、validation 和 calibration，避免校准结果被误写成结构验证。 | P0 | 报告包含三者定义；language guard 有负例 |
| US-TC-003 | 研究工程师 | 作为工程师，我希望公式项能追踪到代码文件、函数和变量，便于审查实现是否忠实。 | P0 | ImplementationMapping 包含 equation_id/symbol_id/code_target |
| US-TC-004 | Reviewer | 作为 Reviewer，我希望在 report reviewed 前检查推导、单位、实现映射和验证用例。 | P1 | Reviewer checklist 包含 theory-to-code lineage |
| US-TC-005 | PI | 作为 PI，我希望参数搜索只在理论/实现链路已审查后启动。 | P0 | AnalysisPlan search 前置检查 bundle status |

## 2. Functional Requirements

| ID | 需求 | 优先级 | 验收标准 |
|---|---|---:|---|
| FR-TC-001 | 系统应支持 `TheoryToCodeBundle`，用于聚合 TheoryNote、EquationSpec、DerivationRecord、NumericalSchemeSpec、ImplementationMapping 和 VerificationCase。 | P0 | Zod schema + create/read API 可用 |
| FR-TC-002 | 系统应支持 `EquationSpec`，要求每个符号有 meaning、unit、dimension、可选 code_variable。 | P0 | 缺 unit 的关键符号不能进入 reviewed |
| FR-TC-003 | 系统应支持 `DerivationRecord`，记录推导步骤、使用的假设、未决问题和 PI 决策点。 | P0 | unresolved PI question 可触发 PI gate |
| FR-TC-004 | 系统应支持 `NumericalSchemeSpec`，记录离散化类型、state variables、flux/source terms、边界/初始条件和守恒期望。 | P0 | 至少可用于 SHUD finite-volume/ODE scheme |
| FR-TC-005 | 系统应支持 `ImplementationMapping`，把 equation_id/symbol_id 映射到 repo/file/function/block。 | P0 | Report lineage 可引用 mapping_id |
| FR-TC-006 | 系统应支持 `VerificationCase`，并能把其结果绑定到 RunRecord 和 artifact。 | P0 | verification passed/failed/inconclusive 可查询 |
| FR-TC-007 | 系统应阻止未通过 gate 的 `physical_equation` / `model_assumption` 变更进入 search/calibration。 | P0 | 负例测试返回 403/409/422 |
| FR-TC-008 | EvidenceReport 应包含 `Theory-to-Code Evidence` 章节，用于科学变更任务。 | P1 | report template 能渲染该章节 |
| FR-TC-009 | 系统应保存失败 verification 和失败 patch artifact，不能因为失败而丢弃证据。 | P0 | failed VerificationCase 仍有 artifacts/ref |
| FR-TC-010 | Controlled Search Loop 只能在 `accepted_for_search` 或更高状态的 bundle 上启动。 | P1 | AnalysisPlan preflight 校验 bundle status |

## 3. Governance Requirements

| ID | 需求 | 优先级 | 验收标准 |
|---|---|---:|---|
| GR-TC-001 | Agent 不得把自己生成的 TheoryToCodeBundle 标记为 accepted。 | P0 | agent actor 调用 accept endpoint 返回 403 |
| GR-TC-002 | calibration improvement 不得作为 theory validation。 | P0 | language guard 负例测试 |
| GR-TC-003 | 修改物理方程、模型假设、默认参数物理意义必须 PI approval。 | P0 | high-risk ChangeRequest 自动生成 PiGate |
| GR-TC-004 | PI comment 可作为 hypothesis 或 decision evidence，但不得自动泛化成科学事实。 | P0 | MemoryNote generalization_allowed=false |
| GR-TC-005 | 验证通过只能证明实现满足指定验证用例，不证明模型结构普遍真实。 | P0 | report limitation 必须出现 |

## 4. Test Requirements

| ID | 测试需求 | 优先级 | 验收标准 |
|---|---|---:|---|
| TR-TC-001 | 缺少 EquationSpec 的 physical_equation ChangeRequest 不能进入 reviewed。 | P0 | API 返回 422 |
| TR-TC-002 | 缺少 ImplementationMapping 的 numerical_implementation ChangeRequest 不能进入 implementation_reviewed。 | P0 | API 返回 422 |
| TR-TC-003 | failed VerificationCase 仍然保留 RunRecord、logs、patch artifact。 | P0 | artifact registry 可查询 |
| TR-TC-004 | 未 accepted_for_search 的 bundle 不能创建 calibration/search AnalysisPlan。 | P0 | API 返回 409 |
| TR-TC-005 | Report line guard 拒绝“校准证明结构正确”。 | P0 | report cannot enter reviewed |
| TR-TC-006 | equation_id → code_target → test_id → RunRecord → report_id traceability 可生成。 | P1 | Traceability check 通过 |

## 5. Non-Functional Requirements

| ID | 需求 | 优先级 | 验收标准 |
|---|---|---:|---|
| NFR-TC-001 | Theory-to-code schema 校验应在 P95 <= 300ms 内完成。 | P1 | performance test |
| NFR-TC-002 | Report lineage guard 对 tiny report P95 <= 5s。 | P1 | report test |
| NFR-TC-003 | Theory-to-code artifacts 应遵守现有 retention / immutability / cleanup guard。 | P0 | artifact registry test |
