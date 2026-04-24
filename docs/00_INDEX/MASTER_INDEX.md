# SHUD-Harness 文档主索引

> **当前基准版本**: v0.7 Final (2026-04-24)
> 所有旧版文档 (v0.1–v0.6) 已归档或保留为参考。

## 核心文件 (只需读这两个即可开始开发)

1. **`../CLAUDE.md`** — 项目定义 + 仓库布局 + 设计决策速查
2. **`SPEC_v0.7_Final.md`** — 自包含实施规格书 (对象模型 + Coordinator 行为 + Playbook + 8 周计划 + 验收标准)

## 补充参考

- `01_CODEBASE/` — 四个 repo 的代码现实报告 (SHUD/rSHUD/AutoSHUD/Zero)
- `02_ARCHITECTURE/` — v0.6 架构文档拆件 (定位/角色/状态机/Zero 决策)
- `03_SPEC/` — v0.6 规范文档拆件 (对象/存储/执行/敏感性/沙箱/记忆/成本)
- `04_IMPLEMENTATION/` — v0.6 实施文档拆件 (目录树/CLI/计划/DoD/Playbook)
- `00_INDEX/GAP_ANALYSIS.md` — 文档设计 vs 代码现实差距分析

---

## 文档清单

### 00_INDEX/ — 索引与导航
| 文件 | 用途 |
|------|------|
| `MASTER_INDEX.md` | 本文件 |
| `GAP_ANALYSIS.md` | 文档设计 vs 代码现实差距分析 |

### 01_CODEBASE/ — 代码库现实报告 (2026-04-24 深度探索)
| 文件 | 对象 |
|------|------|
| `SHUD_Codebase_Report.md` | C++ 求解器: ~7K 行, CVODE 6.0, 5 类状态变量 |
| `rSHUD_Codebase_Report.md` | R 工具包: 154 函数, terra/sf, 二进制 I/O |
| `AutoSHUD_Codebase_Report.md` | R 自动化: 7 步流水线, 多源数据, 配置驱动 |
| `Zero_Codebase_Report.md` | Agent Runtime: 11 包, 18 工具, 无 SHUD 定制 |

### 02_ARCHITECTURE/ — 架构与治理 (v0.6)
| 文件 | 来源 | 用途 |
|------|------|------|
| `Architecture_Decisions.md` | v0.6 01_POSITIONING/01 | MVP 定位、边界、非目标 |
| `Roles_and_Boundaries.md` | v0.6 01_POSITIONING/02 | PI/Coordinator/Worker/Reviewer 职责边界 |
| `Interaction_Model.md` | v0.6 01_POSITIONING/03 | CLI-first, 报告-first, Web 最小化 |
| `Control_Kernel.md` | v0.6 02_ARCHITECTURE/01 | 最小运行时状态机 + Park/Resume |
| `Zero_Reuse_Matrix.md` | v0.6 02_ARCHITECTURE/02 | Zero 决策: MVP 不 fork, 仅参考 |
| `Module_Status_Matrix.md` | v0.6 02_ARCHITECTURE/03 | [R]/[M]/[N] 模块矩阵 |
| `Research_Constitution.md` | v0.5 (保留) | 科研宪法 + Human Gate 矩阵 (v0.6 内嵌到角色文档) |

### 03_SPEC/ — 规范 (v0.6)
| 文件 | 来源 | 用途 |
|------|------|------|
| `Research_Object_Model.md` | v0.6 03_DOMAIN/01 | **8 个核心对象**: TaskCard, StackLock, DataProvenance, RunJob, RunRecord, AnalysisPlan, EvidenceReport, ChangeRequest |
| `Data_Storage_Provenance.md` | v0.6 03_DOMAIN/02 | 存储层次、Git 策略、DuckDB 指标仓、保留策略 |
| `Execution_Jobs_Runs.md` | v0.6 03_DOMAIN/03 | 3 种执行模式、Park/Resume、失败恢复、增量 benchmark |
| `Sensitivity_Calibration_Benchmark.md` | v0.6 03_DOMAIN/04 | 敏感性分析一等公民、校准 ≠ 科学、3 层 benchmark |
| `Sandbox_and_Executor.md` | v0.6 04_RUNTIME/01 | 沙箱权限、命令 trace、回滚策略 |
| `Memory_Skills_Lite.md` | v0.6 04_RUNTIME/02 | 3 类 memory (note/evidence/playbook)、3 阶段 skill |
| `Cost_Inference_Budget.md` | v0.6 04_RUNTIME/03 | cheap/normal/deep 模式、每任务推理预算 |
| `Multiuser_Harness_Versioning.md` | v0.6 04_RUNTIME/04 | Lite 锁、Harness 版本进 StackLock |
| `Minimal_Schemas.md` | v0.6 99_APPENDICES/A | 9 个对象的完整 YAML schema 示例 |

### 04_IMPLEMENTATION/ — 实施 (v0.6)
| 文件 | 来源 | 用途 |
|------|------|------|
| `Repository_Layout.md` | v0.6 05_IMPLEMENTATION/01 | Python CLI + shud-workspace 目录树 |
| `Schemas_APIs_CLIs.md` | v0.6 05_IMPLEMENTATION/02 | CLI 命令集 + 报告生成策略 |
| `Phased_Plan.md` | v0.6 05_IMPLEMENTATION/03 | **8 周实施计划** |
| `DOD_and_Risks.md` | v0.6 05_IMPLEMENTATION/04 | 9 项 MVP DoD + 成功 = 时间节省 |
| `Task_Playbooks.md` | v0.6 99_APPENDICES/C | 工程/科研辅助/运维 3 种典型任务流程 |

### 99_ARCHIVE/ — 已归档
| 内容 | 数量 |
|------|------|
| v0.1–v0.4 文档 | 6 个 .md |
| v0.5 模块化方案包 | 完整目录 (27 文件) |
| 项目图片 | 6 个 .png |
