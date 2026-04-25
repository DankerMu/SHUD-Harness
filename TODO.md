# SHUD-Harness v0.8 设计方案完善计划

> 本文件追踪 PRD + SPEC 层面尚未设计或设计不充分的方案空白。
> 每一项的交付物是**设计文档/规格定义**，不是代码。
> 完成本清单后，任何工程师拿到文档即可直接编码，无需再做设计决策。
>
> **更新 (2026-04-24)**: v0.8 设计补充包已合并，18 项全部有交付物。标记 ✅ 为已交付。

---

## 1. 主 Agent 架构方案 ⭐ ✅

- [x] Agent 实例模型、角色/通信/决策流/闭环标准/并发规则

**交付物**: `docs/02_ARCHITECTURE/Agent_Architecture.md`

---

## 2. Park/Resume 详细设计 ✅

- [x] parked_state 持久化格式、job watcher、幂等 collect、Resume 上下文重建、服务重启恢复

**交付物**: `docs/03_SPEC/Park_Resume_Design.md`

---

## 3. WebSocket 消息协议 ✅

- [x] 事件 envelope、20 种消息类型、seq/ack/心跳/断线重连、日志流格式

**交付物**: `docs/03_SPEC/WebSocket_Protocol.md`

---

## 4. 前端状态管理 & 数据流 ✅

- [x] 5 层 store 架构、WebSocket reducer、entity 缓存、chart 状态、permission-driven UI

**交付物**: `docs/03_SPEC/Frontend_State_Design.md`

---

## 5. 可视化数据规格 ✅

- [x] Hydrograph/Comparison/Heatmap/MetricsCards 的 JSON 格式、缺失值处理、artifact API

**交付物**: `docs/03_SPEC/Visualization_Data_Spec.md`

---

## 6. 认证 & 权限模型 ✅

- [x] 5 角色权限矩阵、PI gate、session/cookie、API key、审计日志

**交付物**: `docs/03_SPEC/Auth_Permission_Design.md`

---

## 7. 报告生成规格 ✅

- [x] 6 阶段生成流程、10 节模板、语言约束、5 级证据分类、Reviewer checklist、审阅状态流

**交付物**: `docs/03_SPEC/Report_Generation_Spec.md`

---

## 8. 错误处理 & 异常流规格 ✅

- [x] 10 分类、4 严重级别、标准 error 对象、重试策略、用户提示、WebSocket 错误事件

**交付物**: `docs/03_SPEC/Error_Handling_Spec.md`

---

## 9. Sandbox 安全规格细化 ✅

- [x] 执行请求 schema、路径策略、四级风险分类、streaming、资源限制、审计记录、SHUD 工具封装

**交付物**: 已合并入 `docs/03_SPEC/Execution_Jobs_Runs.md` 第 9-10 节

---

## 10. Zero 扩展点映射 ✅

- [x] Adapter 层模式、必须覆盖行为、工具命名空间、Prompt 改造、集成步骤

**交付物**: 已合并入 `docs/02_ARCHITECTURE/Zero_Reuse_Matrix.md` 第 7-15 节

---

## 11. 部署架构 ✅

- [x] 5 种部署模式、服务组件、Docker R/SUNDIALS 环境、HPC/SLURM adapter

**交付物**: `docs/04_IMPLEMENTATION/Deployment_Architecture.md`

---

## 12. SHUD 输出变量目录 ✅

- [x] 32 变量注册表、单位/优先级/水量平衡角色、数值健康阈值、rSHUD 别名

**交付物**: `docs/03_SPEC/SHUD_Output_Variables.md`

---

## 13. 敏感性分析 & 校准规格细化 ✅

- [x] 参数空间定义、批运行独立性、指标解读指南、语言推荐、PI gate 触发条件

**交付物**: `docs/03_SPEC/Sensitivity_Calibration_Benchmark_Addendum.md`

---

## 14. Workspace & 文件约定 ✅

- [x] 目录结构、artifact 命名、路径安全验证、清理策略、Git 包含规则

**交付物**: `docs/03_SPEC/Workspace_Conventions.md`

---

## 15. 国际化 & 本地化 ✅

- [x] 中英术语表、报告语言约束、单位显示策略

**交付物**: `docs/03_SPEC/Internationalization_Localization.md`

---

## 16. 成本追踪详细设计 ✅

- [x] cost_record 数据结构、Token 阶段归因、WebSocket 成本事件

**交付物**: 已合并入 `docs/03_SPEC/Cost_Inference_Budget.md` 第 7-9 节

---

## 17. 测试策略 ✅

- [x] 5 层测试金字塔、Schema/WebSocket/Sandbox 测试、ccw tiny fixture、E2E UI 流程

**交付物**: `docs/04_IMPLEMENTATION/Testing_Strategy.md`

---

## 18. CI/CD & 发布流程 ✅

- [x] 11 步 CI pipeline、submodule 检查、schema drift 检测、版本策略

**交付物**: `docs/04_IMPLEMENTATION/CICD_Release.md`

---

## 优先级 (参考)

| 优先级 | 项目 | 状态 |
|--------|------|------|
| **P0** | 1. 主 Agent 架构 | ✅ |
| **P0** | 10. Zero 扩展点映射 | ✅ |
| **P0** | 3. WebSocket 消息协议 | ✅ |
| **P1** | 2. Park/Resume 详细设计 | ✅ |
| **P1** | 6. 认证 & 权限 | ✅ |
| **P1** | 12. SHUD 输出变量目录 | ✅ |
| **P1** | 5. 可视化数据规格 | ✅ |
| **P2** | 4. 前端状态管理 | ✅ |
| **P2** | 7. 报告生成规格 | ✅ |
| **P2** | 9. Sandbox 安全细化 | ✅ |
| **P2** | 11. 部署架构 | ✅ |
| **P2** | 13. 敏感性分析细化 | ✅ |
| **P3** | 8. 错误处理规格 | ✅ |
| **P3** | 14. Workspace 约定 | ✅ |
| **P3** | 15. 国际化 | ✅ |
| **P3** | 16. 成本追踪细化 | ✅ |
| **P3** | 17. 测试策略 | ✅ |
| **P3** | 18. CI/CD | ✅ |
