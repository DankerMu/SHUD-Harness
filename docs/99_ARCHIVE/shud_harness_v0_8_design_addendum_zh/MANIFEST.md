# 文档清单

本清单列出中文设计补充包内的全部新增文档。文件路径保持英文，便于 GitHub、ZIP 下载链接、CI 和脚本处理。

| 路径 | 优先级 | 作用 |
|---|---:|---|
| `docs/02_ARCHITECTURE/Agent_Architecture.md` | P0 | 定义 Coordinator、Worker、Coder、Reviewer 的实例模型、职责边界、通信方式和任务状态驱动方式。 |
| `docs/02_ARCHITECTURE/Zero_Extension_Map.md` | P0 | 定义如何基于 Zero 扩展 SHUD-Harness，包括复用、覆盖、禁用和新增的模块。 |
| `docs/03_SPEC/Park_Resume_Design.md` | P0 | 定义长任务 parking、job watcher、collect、resume context、幂等和服务重启恢复。 |
| `docs/03_SPEC/WebSocket_Protocol.md` | P0 | 定义前后端实时通信的事件 envelope、消息类型、payload、seq、ack、心跳和断线重连。 |
| `docs/03_SPEC/Frontend_State_Design.md` | P1 | 定义四栏工作台的前端状态模型、store 分层、事件 reducer 和 UI 派生状态。 |
| `docs/03_SPEC/Visualization_Data_Spec.md` | P1 | 定义 HydrographChart、ResultsOverview、SensitivityHeatmap 等组件的数据契约。 |
| `docs/03_SPEC/Auth_Permission_Design.md` | P1 | 定义 MVP 单用户/小团队认证、角色、权限矩阵、PI gate 和 API key 管理。 |
| `docs/03_SPEC/Report_Generation_Spec.md` | P1 | 定义 EvidenceReport 的生成流程、模板、语言约束、证据等级和审阅状态。 |
| `docs/03_SPEC/Error_Handling_Spec.md` | P1 | 定义错误分类、严重性、重试策略、用户提示和错误记录格式。 |
| `docs/03_SPEC/Sandbox_Executor_Implementation_Addendum.md` | P1 | 补充 Sandbox Executor 的命令执行、环境隔离、资源限制和日志流实现。 |
| `docs/03_SPEC/SHUD_Output_Variables.md` | P1 | 定义 SHUD 输出变量注册表、默认前端变量、水量平衡指标和 runtime discovery。 |
| `docs/03_SPEC/Sensitivity_Calibration_Benchmark_Addendum.md` | P1 | 补充 sensitivity、calibration、benchmark 的计划、运行、报告和治理约束。 |
| `docs/03_SPEC/Workspace_Conventions.md` | P1 | 定义 runtime workspace 的目录结构、artifact 命名、路径安全和清理策略。 |
| `docs/03_SPEC/Internationalization_Localization.md` | P2 | 定义中英文 UI、报告、单位和术语的一致性策略。 |
| `docs/03_SPEC/Cost_Tracking_Implementation.md` | P2 | 定义 LLM token、tool call、job runtime 和预算提醒的软监控机制。 |
| `docs/04_IMPLEMENTATION/Deployment_Architecture.md` | P2 | 定义本地开发、单机部署、Docker 部署和远程 HPC/SLURM 接入边界。 |
| `docs/04_IMPLEMENTATION/Testing_Strategy.md` | P2 | 定义 schema、API、WebSocket、executor、fixture、report 和 UI 的测试策略。 |
| `docs/04_IMPLEMENTATION/CICD_Release.md` | P2 | 定义 CI/CD、release、文档检查、schema drift 检查和 submodule 版本锁检查。 |

## 合并建议

推荐先合并 P0 文档，并把其中的协议和状态契约同步到 Zod schema。P1 文档可随 MVP 端到端功能逐步合并。P2 文档用于稳定工程实践和后续发布，不应阻塞第一条 tiny SHUD 闭环。

## 与 TODO 的对应关系

| TODO 类型 | 本包覆盖方式 |
|---|---|
| Agent 架构缺失 | `Agent_Architecture.md` |
| Zero 扩展点不清楚 | `Zero_Extension_Map.md` |
| Park/Resume 不够实现级 | `Park_Resume_Design.md` |
| WebSocket 缺少消息契约 | `WebSocket_Protocol.md` |
| 前端状态流不清楚 | `Frontend_State_Design.md` |
| 可视化变量和单位不完整 | `Visualization_Data_Spec.md`、`SHUD_Output_Variables.md` |
| Auth/权限/API key 空白 | `Auth_Permission_Design.md` |
| EvidenceReport 生成细节不足 | `Report_Generation_Spec.md` |
| 错误和失败恢复缺少规范 | `Error_Handling_Spec.md` |
| Sandbox executor 需要实现细节 | `Sandbox_Executor_Implementation_Addendum.md` |
| sensitivity/calibration/benchmark 需要治理细节 | `Sensitivity_Calibration_Benchmark_Addendum.md` |
| workspace 与 artifact 约定需要固定 | `Workspace_Conventions.md` |
| 部署、测试、CI/CD 需要工程闭环 | `Deployment_Architecture.md`、`Testing_Strategy.md`、`CICD_Release.md` |
