# SHUD-Harness 文档主索引

> **当前基准版本**: v0.8 (2026-04-24)
> 技术栈: TypeScript 全栈 (Bun + Hono + React)，基于 Zero agent runtime 扩展。
> Web 是用户唯一交互渠道。所有旧版文档 (v0.1–v0.6) 已归档或保留为参考。

## 核心文件 (只需读这两个即可开始开发)

1. **`../CLAUDE.md`** — 项目定义 + 仓库布局 + 设计决策速查
2. **`SPEC_v0.7_Final.md`** — 自包含实施规格书 (v0.8: 对象模型 + Coordinator 行为 + Playbook + 8 周计划 + 验收标准)

## 补充参考

- `01_CODEBASE/` — 四个 repo 的代码现实报告 (SHUD/rSHUD/AutoSHUD/Zero)
- `02_ARCHITECTURE/` — 架构文档 (定位/角色/Agent 实例模型/Web 交互模型/状态机/Zero 扩展)
- `03_SPEC/` — 规范文档 (对象/Schema/执行/沙箱/WebSocket/前端/可视化/报告/Park-Resume/权限/错误处理/变量注册/成本)
- `04_IMPLEMENTATION/` — 实施文档 (TS monorepo/REST API/8 周计划/DoD/Playbook/部署/测试/CI-CD)
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
| `Agent_Architecture.md` | **Agent 实例模型**: 角色/通信/决策流/闭环标准/并发规则 |
| `Interaction_Model.md` | **Web 四栏工作台**: 对话驱动 + 日志流 + PI 审批 + 报告阅读 |
| `Control_Kernel.md` | 最小运行时状态机 + Park/Resume |
| `Zero_Reuse_Matrix.md` | **基于 Zero 扩展**: 复用矩阵 + Adapter 层 + Hook/Tool 命名空间 + 集成步骤 |
| `Module_Status_Matrix.md` | [E]/[O]/[N] 模块矩阵 |
| `Research_Constitution.md` | 科研治理规则 (参见 SPEC v0.8 Section 3) |

### 03_SPEC/ — 规范
| 文件 | 用途 |
|------|------|
| `Minimal_Schemas.md` | **Canonical Schema Contract**: 9 个对象唯一权威字段定义 |
| `Research_Object_Model.md` | 8 个核心对象 + 合并/降级对照表 |
| `Execution_Jobs_Runs.md` | 3 种执行模式、Park/Resume、失败恢复、Sandbox 执行器、长任务转换 |
| `Park_Resume_Design.md` | **长任务全生命周期**: parked_state/job watcher/幂等 collect/Resume 上下文重建 |
| `WebSocket_Protocol.md` | **实时通信协议**: 事件 envelope/20 种消息类型/seq/ack/心跳/断线重连 |
| `Frontend_State_Design.md` | **四栏前端状态**: 5 层 store/WebSocket reducer/entity 缓存/chart 状态 |
| `Visualization_Data_Spec.md` | **可视化数据契约**: Hydrograph/Comparison/Heatmap/MetricsCards 的 JSON 格式 |
| `SHUD_Output_Variables.md` | **SHUD 输出变量注册表**: 32 变量/单位/优先级/水量平衡角色/数值健康阈值 |
| `Report_Generation_Spec.md` | **EvidenceReport 生成**: 6 阶段流程/模板/语言约束/证据等级/审阅状态 |
| `Auth_Permission_Design.md` | **认证与权限**: 5 角色权限矩阵/PI gate/session/API key/审计 |
| `Error_Handling_Spec.md` | **错误处理**: 10 分类/4 严重级别/重试策略/用户提示/错误记录 |
| `Sensitivity_Calibration_Benchmark.md` | 敏感性一等公民、校准 ≠ 科学、3 层 benchmark |
| `Sensitivity_Calibration_Benchmark_Addendum.md` | **补充**: 参数空间/批运行独立性/指标解读/语言推荐/PI gate 触发 |
| `Sandbox_and_Executor.md` | 沙箱权限、命令 trace、回滚策略 |
| `Workspace_Conventions.md` | **Workspace 约定**: 目录结构/artifact 命名/路径安全/清理策略 |
| `Memory_Skills_Lite.md` | 2 级 memory、3 阶段 skill |
| `Cost_Inference_Budget.md` | 软监控: cheap/normal/deep + cost_record 结构 + Token 阶段归因 |
| `Multiuser_Harness_Versioning.md` | Lite 锁、Harness 版本进 StackLock |
| `Internationalization_Localization.md` | **国际化**: 中英术语表/报告语言约束/单位显示 |
| `Data_Storage_Provenance.md` | 存储层次、Git 策略、DuckDB 指标仓 |

### 04_IMPLEMENTATION/ — 实施
| 文件 | 用途 |
|------|------|
| `Repository_Layout.md` | **TS monorepo** (packages/core + backend + frontend) + shud-workspace |
| `Schemas_APIs_CLIs.md` | **REST API + WebSocket** 端点 + Zod schema |
| `Phased_Plan.md` | **8 周实施计划** (Hono + React + 逐周功能交付) |
| `DOD_and_Risks.md` | 9 项 MVP DoD + 成功 = 时间节省 |
| `Task_Playbooks.md` | 工程/科研辅助/运维 3 种 Web 交互工作流 |
| `Deployment_Architecture.md` | **部署架构**: 本地开发/单机/Docker/HPC-SLURM 4 种模式 |
| `Testing_Strategy.md` | **测试策略**: 5 层测试金字塔/Schema/WebSocket/Sandbox/fixture/E2E |
| `CICD_Release.md` | **CI/CD**: 11 步 pipeline/submodule 检查/schema drift 检测/版本策略 |

### 99_ARCHIVE/ — 已归档
| 内容 | 数量 |
|------|------|
| v0.1–v0.4 文档 | 6 个 .md |
| v0.5 模块化方案包 | 完整目录 (27 文件) |
| v0.6 设计补充包 | shud_harness_v0_8_design_addendum_zh/ (原始来源) |
| 项目图片 | 6 个 .png |
