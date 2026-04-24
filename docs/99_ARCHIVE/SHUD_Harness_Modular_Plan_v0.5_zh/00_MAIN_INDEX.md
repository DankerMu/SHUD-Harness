# SHUD-Harness 模块化详细方案（v0.5）主文档索引

## 1. 文档定位
本主文档**只负责索引和阅读路径**，不承担详细设计正文。  
详细规范全部下沉到对应子文档。

> 状态标签说明  
> **[R] 已实现可复用**：ZeRo 当前已有对应能力，可直接复用或小幅包装。  
> **[M] 需修改后复用**：ZeRo 当前有相邻能力，但不满足 SHUD-Harness 的科研语义、治理要求或对象模型，需要改造。  
> **[N] 必须新增**：ZeRo 当前没有这层能力，SHUD-Harness 必须新增实现。  
> **独立实现要求**：本方案的所有模块都要求在**不依赖 ZeRo** 的情况下可实现；ZeRo 仅作为参考实现和加速来源，不是硬前置。

## 2. 顶层结论
- SHUD-Harness 应被建设为**面向 SHUD / rSHUD / AutoSHUD 持续演化的科研 Agent Runtime**。
- 主 Agent 需要**固定 runtime control kernel**，但不应绑定固定科研流程。
- 系统必须支持**不依赖 ZeRo 的独立实现**；ZeRo 只是一个成熟的 runtime 参考基座。
- 当前最重要的四条底座仍然是：**版本锁、执行层、数据 provenance、Benchmark / calibration 治理**。

## 3. 核心阅读路径
### A. 先建立总判断
1. `01_GOVERNANCE/01_Project_Positioning_and_Boundaries.md`
2. `01_GOVERNANCE/02_Commander_Runtime_Control_Kernel.md`
3. `01_GOVERNANCE/03_Research_Constitution_and_Gates.md`

### B. 再看 ZeRo 对照
4. `02_ZERO_REFERENCE/01_Zero_Current_Baseline.md`
5. `02_ZERO_REFERENCE/02_Reuse_Modify_Add_Matrix.md`
6. `02_ZERO_REFERENCE/03_Independent_Implementation_Strategy.md`

### C. 再看 Runtime 设计
7. `03_RUNTIME/01_Runtime_Core_and_Profiles.md`
8. `03_RUNTIME/02_Sandbox_and_Executor.md`
9. `03_RUNTIME/03_Observability_Artifacts_and_Jobs.md`
10. `03_RUNTIME/04_Skills_System.md`
11. `03_RUNTIME/05_Memory_System.md`
12. `03_RUNTIME/06_Web_Console_and_Operator_Workflows.md`

### D. 再看 SHUD 领域对象
13. `04_RESEARCH_DOMAIN/01_Research_Object_Model.md`
14. `04_RESEARCH_DOMAIN/02_Version_Provenance_and_Contracts.md`
15. `04_RESEARCH_DOMAIN/03_Experiments_Calibration_and_Holdout.md`
16. `04_RESEARCH_DOMAIN/04_Benchmark_Validation_and_Release.md`

### E. 最后看实施与落地
17. `05_IMPLEMENTATION/01_Repository_and_Package_Layout.md`
18. `05_IMPLEMENTATION/02_Schemas_APIs_and_CLIs.md`
19. `05_IMPLEMENTATION/03_Phased_Implementation_Plan.md`
20. `05_IMPLEMENTATION/04_DOD_Risks_and_Migration_Cutover.md`

### F. 速查附录
21. `99_APPENDICES/A_Module_Status_Matrix.md`
22. `99_APPENDICES/B_Document_Map.md`
23. `99_APPENDICES/C_Suggested_File_Trees.md`

## 4. 文档清单与用途
| 编号 | 文档 | 用途 | 主状态 |
|---|---|---|---|
| G-01 | Project Positioning and Boundaries | 定义项目边界、目标、非目标 | [M]/[N] |
| G-02 | Commander Runtime Control Kernel | 定义主 Agent 固定控制环 | [M]/[N] |
| G-03 | Research Constitution and Gates | 定义科研宪法、审批和 release gate | [N] |
| Z-01 | Zero Current Baseline | 抽取当前 ZeRo 已有能力 | [R] |
| Z-02 | Reuse Modify Add Matrix | 系统级复用/改造/新增矩阵 | [R]/[M]/[N] |
| Z-03 | Independent Implementation Strategy | 无 ZeRo 实现路径 | [N] |
| R-01 | Runtime Core and Profiles | Agent、session、episode、context 设计 | [M] |
| R-02 | Sandbox and Executor | bash sandbox、JobSpec、executor 设计 | [M]/[N] |
| R-03 | Observability, Artifacts and Jobs | trace、artifact、warehouse、job events | [M]/[N] |
| R-04 | Skills System | SKILL.md、promotion、registry | [M] |
| R-05 | Memory System | proposal-only memory、epistemic memory | [M] |
| R-06 | Web Console and Workflows | Operator-first 信息架构 | [M]/[N] |
| D-01 | Research Object Model | RCS/Experiment/Run/Evidence/Change 等对象 | [N] |
| D-02 | Version, Provenance and Contracts | StackLock/Data manifest/OutputContract | [N] |
| D-03 | Experiments, Calibration and Holdout | CalibrationSpec/HoldoutPolicy/anti-leakage | [N] |
| D-04 | Benchmark, Validation and Release | BenchmarkPolicy/Validation/ReleaseGate | [N] |
| I-01 | Repository and Package Layout | 代码仓结构与 package 建议 | [M]/[N] |
| I-02 | Schemas, APIs and CLIs | CLI/API/schema 落点 | [N] |
| I-03 | Phased Implementation Plan | 12 周与 P0/P1/P2 路线 | [M]/[N] |
| I-04 | DoD, Risks and Migration Cutover | 验收、风险、迁移、切换策略 | [N] |

## 5. 版本关系
- `v0.2`：内化方案初稿
- `v0.3`：补齐版本锁 / provenance / Job 层
- `v0.4`：正式写实 StackLock / JobSpec / DatasetManifest / CalibrationSpec / BenchmarkPolicy
- `v0.5`：**模块化拆分**，并正式加入：
  - ZeRo 当前实现对照
  - 独立实现路线
  - 固定 runtime kernel / 可变 scientific graph
  - 文档级 `[R] / [M] / [N]` 标注

## 6. 本版新增的关键方法论
### 6.1 固定的是控制内核，不是科研路径
推荐主控制环：

```text
Refresh State
→ Observe
→ Decide
→ Act | Spawn | Wait
→ Integrate Result
→ Evaluate / Gate
→ Continue | Pause | Finish | Block | Escalate

[conditional]
→ Reflect
→ Propose Memory Update
→ Propose Skill Update
```

### 6.2 科研工作图谱是可变的
建议以以下对象图谱组织科研活动，而不是固定 workflow：

```text
RCS
↔ StackLock
↔ DatasetManifest / ObservationManifest / PreprocessRecipe
↔ ExperimentSpec
↔ CalibrationSpec / HoldoutPolicy
↔ JobSpec / RunManifest
↔ EvidencePacket
↔ ChangeSpec
↔ OutputContract / CompatibilitySuite
↔ ValidationReport
↔ BenchmarkPolicy
↔ Human Gate / ReleaseGate
```

## 7. 直接跳转建议
- 你如果要先做方案评审：看 `Z-02` + `I-03`
- 你如果要开始写代码：看 `R-01` ~ `R-05` + `I-01` + `I-02`
- 你如果要给老板/合作者解释：看 `G-01` + `G-02` + `D-04`
- 你如果要做 ZeRo fork：看 `Z-01` + `Z-02` + `I-04`
