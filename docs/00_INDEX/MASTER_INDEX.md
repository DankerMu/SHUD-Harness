# SHUD-Harness 文档主索引

> **当前基准版本**: v0.8 (2026-04-24)
> 技术栈: TypeScript 全栈 (Bun + Hono + React)，基于 Zero agent runtime 扩展。
> Web 是用户唯一交互渠道。所有旧版文档 (v0.1–v0.6) 已归档或保留为参考。

## 核心文件 (只需读这两个即可开始开发)

1. **`../CLAUDE.md`** — 项目定义 + 仓库布局 + 设计决策速查
2. **`SPEC_v0.7_Final.md`** — 自包含实施规格书 (v0.8: 对象模型 + Coordinator 行为 + Playbook + 8 周计划 + 验收标准)

## 补充参考

- `01_CODEBASE/` — 四个 repo 的代码现实报告 (SHUD/rSHUD/AutoSHUD/Zero)
- `02_ARCHITECTURE/` — 架构文档 (定位/角色/Web 交互模型/状态机/Zero 扩展决策)
- `03_SPEC/` — 规范文档 (对象/存储/执行/敏感性/沙箱/记忆/成本)
- `04_IMPLEMENTATION/` — 实施文档 (TS monorepo 结构/REST API/8 周计划/DoD/Playbook)
- `00_INDEX/GAP_ANALYSIS.md` — 文档设计 vs 代码现实差距分析

---

## 文档清单

### 00_INDEX/ — 索引与导航
| 文件 | 用途 |
|------|------|
| `MASTER_INDEX.md` | 本文件 |
| `GAP_ANALYSIS.md` | 文档设计 vs 代码现实差距分析 (v0.5 阶段，部分已解决) |

### 01_CODEBASE/ — 代码库现实报告 (2026-04-24 深度探索)
| 文件 | 对象 |
|------|------|
| `SHUD_Codebase_Report.md` | C++ 求解器: ~7K 行, CVODE 6.0, 5 类状态变量 |
| `rSHUD_Codebase_Report.md` | R 工具包: 154 函数, terra/sf, 二进制 I/O |
| `AutoSHUD_Codebase_Report.md` | R 自动化: 7 步流水线, 多源数据, 配置驱动 |
| `Zero_Codebase_Report.md` | Agent Runtime: 11 包, 18 工具, SHUD-Harness 基础实现 |

### 02_ARCHITECTURE/ — 架构与治理
| 文件 | 用途 |
|------|------|
| `Architecture_Decisions.md` | MVP 定位、边界、非目标 |
| `Roles_and_Boundaries.md` | PI/Coordinator/Worker/Reviewer 职责边界 |
| `Interaction_Model.md` | **Web-first**: 对话驱动 + 日志流 + PI 审批 + 报告阅读 |
| `Control_Kernel.md` | 最小运行时状态机 + Park/Resume |
| `Zero_Reuse_Matrix.md` | **基于 Zero 扩展**: 复用/扩展/新增模块矩阵 |
| `Module_Status_Matrix.md` | [E]/[O]/[A] 模块矩阵 |
| `Research_Constitution.md` | 科研治理规则 (参见 SPEC v0.8 Section 3) |

### 03_SPEC/ — 规范
| 文件 | 用途 |
|------|------|
| `Research_Object_Model.md` | **8 个核心对象** + 合并/降级对照表 |
| `Data_Storage_Provenance.md` | 存储层次、Git 策略、DuckDB 指标仓 |
| `Execution_Jobs_Runs.md` | 3 种执行模式、Park/Resume、失败恢复 |
| `Sensitivity_Calibration_Benchmark.md` | 敏感性一等公民、校准 ≠ 科学、3 层 benchmark |
| `Sandbox_and_Executor.md` | 沙箱权限、命令 trace、回滚策略 |
| `Memory_Skills_Lite.md` | 2 级 memory、3 阶段 skill |
| `Cost_Inference_Budget.md` | 软监控: cheap/normal/deep 模式 |
| `Multiuser_Harness_Versioning.md` | Lite 锁、Harness 版本进 StackLock |
| `Minimal_Schemas.md` | 9 个对象的 YAML schema 示例 |

### 04_IMPLEMENTATION/ — 实施
| 文件 | 用途 |
|------|------|
| `Repository_Layout.md` | **TS monorepo** (packages/core + backend + frontend) + shud-workspace |
| `Schemas_APIs_CLIs.md` | **REST API + WebSocket** 端点 + Zod schema |
| `Phased_Plan.md` | **8 周实施计划** (Hono + React + 逐周功能交付) |
| `DOD_and_Risks.md` | 9 项 MVP DoD + 成功 = 时间节省 |
| `Task_Playbooks.md` | 工程/科研辅助/运维 3 种 Web 交互工作流 |

### 99_ARCHIVE/ — 已归档
| 内容 | 数量 |
|------|------|
| v0.1–v0.4 文档 | 6 个 .md |
| v0.5 模块化方案包 | 完整目录 (27 文件) |
| 项目图片 | 6 个 .png |
