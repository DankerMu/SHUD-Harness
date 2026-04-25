# 分阶段 Spec 激活与对齐

**原则：** 代码跟着 spec 走，spec 是权威源。但 67 份 spec 不同时激活——每个阶段只激活该阶段代码直接依赖的文档。阶段切换时，基于实现经验对齐下一阶段的 spec。

---

## 全程基座（始终激活）

无论处于哪个阶段，以下文档始终是 source of truth：

| 文件 | 角色 |
|------|------|
| `CLAUDE.md` | 项目定位 + 10 项设计决策 |
| `SPEC_v0.8_Final.md` | 自包含阅读基准 |
| `CANONICAL_CONTRACTS.md` | 唯一事实源索引 |
| `Minimal_Schemas.md` | 8 核心对象字段定义 |
| `Support_Schema_Contracts.md` | Support schema 定义 |
| `Repository_Layout.md` | Monorepo 目录结构 |
| `Schemas_APIs_CLIs.md` | API 端点注册表 |

02_ARCHITECTURE 和 01_CODEBASE 为背景参考，按需查阅，不分配到具体阶段。

---

## Phase 1：骨架可运行

**目标：** Monorepo 初始化、核心 Zod schema 落地、workspace 目录生成、基础 CRUD API、四栏前端壳。

**激活 Spec：**

| 文件 | 本阶段关注点 |
|------|-------------|
| `Workspace_Conventions.md` | 路径体系、目录结构、Git 策略 |
| `Config_Secrets_And_Environment_Spec.md` | 环境变量命名、.env.local、配置层级 |
| `API_Error_And_Idempotency_Contracts.md` | 错误响应 envelope（仅结构，不含 idempotency header） |
| `MVP_Implementation_Readiness_Checklist.md` | P0 检查项 |

**激活 Impl：**

| 文件 | 本阶段关注点 |
|------|-------------|
| `Testing_Strategy.md` | Schema 测试部分 |

**交付标志：** 浏览器打开四栏布局，POST /api/tasks 可创建 TaskCard，workspace 文件树自动生成。

### Phase 1 → 2 对齐检查点

- [ ] Workspace_Conventions 中定义的路径体系是否与实际目录一致？
- [ ] TaskCard / RunJob / RunRecord 的 Zod schema 是否与 Minimal_Schemas 一致？
- [ ] API error envelope 是否够用？需要调整字段吗？
- [ ] Config 层级是否符合实际开发体验？
- [ ] **预读 Phase 2 spec**，标注与当前实现有冲突的地方，先修 spec 再写代码。

---

## Phase 2：执行闭环

**目标：** RunJob 可提交、sandbox 可执行、WebSocket 可推流、dummy job 可走完 submit → run → collect → RunRecord 全流程，Park/Resume 可工作。

**激活 Spec：**

| 文件 | 本阶段关注点 |
|------|-------------|
| `Execution_Jobs_Runs.md` | RunJob 状态机、执行模式、collect 流程、失败恢复 |
| `Sandbox_and_Executor.md` | 命令审计、路径策略、风险分级、资源限制 |
| `WebSocket_Protocol.md` | 事件 envelope、消息类型、断线重连、seq 单调性 |
| `Runner_Adapter_Contracts.md` | submit/status/cancel/collect 统一接口（实现 local_direct + local_job） |
| `Park_Resume_Design.md` | Park/Resume 状态流转 |
| `Idempotency_Concurrency_Locking_Spec.md` | collect 幂等、lock 文件、状态单调性 |
| `Workspace_Snapshot_And_Recovery_Spec.md` | TaskSnapshot schema、service restart recovery |

**激活 Impl：**

| 文件 | 本阶段关注点 |
|------|-------------|
| `Testing_Strategy.md` | 执行、WebSocket、Sandbox 测试部分 |

**交付标志：** dummy job submit → WebSocket 实时推流日志 → collect 生成 RunRecord → 服务重启后 watcher 可恢复。

### Phase 2 → 3 对齐检查点

- [ ] RunJob 状态机的实际转换是否与 spec 一致？有没有 spec 没覆盖的状态？
- [ ] WebSocket 事件类型是否够用？实际推送的 payload 是否与 spec 吻合？
- [ ] Runner adapter 的 collect result 是否需要额外字段？
- [ ] idempotency key 的拼接规则实际可行吗？
- [ ] Park/Resume 的 parked_state.yaml 结构需要调整吗？
- [ ] **预读 Phase 3 spec**，特别是 SHUD_Output_Variables 和 Artifact_Registry，确认与当前 runner/collect 的输出对接。

---

## Phase 3：科学运行

**目标：** 真实 SHUD tiny case 可编译运行、StackLock/DataProvenance 绑定、RunRecord 包含 numerical_health、Artifact 登记、HydrographChart 可展示。

**激活 Spec：**

| 文件 | 本阶段关注点 |
|------|-------------|
| `Data_Storage_Provenance.md` | DataProvenance schema、存储分层、raw 只读 |
| `Artifact_Registry_Spec.md` | Artifact 类型、metadata、evidence_usable、manifest |
| `SHUD_Output_Variables.md` | SHUD 二进制输出变量列表、单位、读取方式 |
| `Visualization_Data_Spec.md` | HydrographChart 数据结构、单位策略、canonical data API |

**激活参考：**

| 文件 | 用途 |
|------|------|
| `SHUD_Codebase_Report.md` | SHUD 编译/运行/输入输出格式 |
| `rSHUD_Codebase_Report.md` | read_output() / wb.all() 调用方式 |

**交付标志：** ccw tiny case 编译+运行 exit_code=0，water_balance_residual < 阈值，前端 HydrographChart 展示 rivqdown 过程线。

### Phase 3 → 4 对齐检查点

- [ ] Artifact 的实际类型是否覆盖了 SHUD 产出？需要增减 type 枚举吗？
- [ ] SHUD_Output_Variables 中列出的变量与 rSHUD read_output() 实际返回是否一致？
- [ ] visualization dataset 的 envelope 字段在真实数据上是否够用？
- [ ] DataProvenance 的 sources 结构是否需要扩展？
- [ ] numerical_health 的四个指标在实际 tiny run 上的值域是否合理？
- [ ] **预读 Phase 4 spec**，特别是 ParameterSet 映射和 batch 策略，确认与当前 RunJob/Artifact 的结构兼容。

---

## Phase 4：分析引擎

**目标：** AnalysisPlan(mode=sensitivity) 可创建、batch parameter runner 可并发执行多组参数、heatmap/参数表可展示、ChangeRequest + diff 可工作。

**激活 Spec：**

| 文件 | 本阶段关注点 |
|------|-------------|
| `Sensitivity_Calibration_Benchmark.md` | 三种分析模式边界、指标解读规则 |
| `Sensitivity_Calibration_Benchmark_Addendum.md` | batch 运行设计、BatchProgressGrid、cell 详情 |
| `Parameter_Set_And_Analysis_Run_Mapping.md` | ParameterSet ↔ RunJob ↔ RunRecord 映射、并发策略 |
| `Batch_Progress_View_Spec.md` | BatchProgressGrid 数据结构与前端规格 |
| `Research_Object_Model.md` | AnalysisPlan 在对象模型中的位置 |

**交付标志：** PI 指定 ksat × roughness 参数空间 → batch 自动运行 → 前端展示参数表 + 热力图 + 对比过程线，失败 cell 可见。

### Phase 4 → 5 对齐检查点

- [ ] AnalysisPlan 的 parameter_sets 和 batch_policy 字段在实际 batch 中是否足够？
- [ ] ParameterSet.status 从 RunJob 派生的逻辑是否稳定？
- [ ] 并发 batch 的目录隔离策略实际表现如何？
- [ ] heatmap excluded cells 的记录方式是否可行？
- [ ] stop_condition 的三种模式在实际场景中是否都需要？
- [ ] **预读 Phase 5 spec**，特别是 Report_Generation 和 Evidence_Lineage，确认 report 需要从 AnalysisPlan 拉取哪些数据。

---

## Phase 5：报告与治理

**目标：** EvidenceReport 可生成、Reviewer 检查链可工作、PI gate 审批可工作、Auth + 多用户角色可工作、审计链完整。

**激活 Spec：**

| 文件 | 本阶段关注点 |
|------|-------------|
| `Report_Generation_Spec.md` | 报告模板、language guard、evidence level、生成流程 |
| `Report_Review_And_Evidence_Lineage_Spec.md` | assertion 分类、lineage guard、reviewer checklist |
| `Report_Export_Spec.md` | standalone HTML、draft watermark、export manifest |
| `PI_Decision_Comments_Spec.md` | comment 必填规则、decision memory |
| `Auth_Permission_Design.md` | 角色/权限矩阵、PI gate 规则、Session 管理 |
| `User_Session_And_Audit_Schema.md` | User/Session/PermissionDecision/AuditEvent schema |

**交付标志：** 从 RunRecord → 生成 report → Reviewer 检查 → PI 在 Web 审批（含 comment）→ accepted report 可导出 HTML，审计链完整可查。

### Phase 5 → 6 对齐检查点

- [ ] ReportAssertion 的 7 种 assertion_type 是否都在实际 report 中出现？需要合并或增减吗？
- [ ] evidence_level 的 5 个级别是否实用，还是可以简化？
- [ ] language guard 的禁止词表在实际使用中的误报率如何？
- [ ] PI gate 的 comment_required 规则是否需要调整？
- [ ] Auth 的两种模式（local_single_user / small_team）是否都验证过？
- [ ] AuditEvent 的 action 枚举是否覆盖了所有实际操作？
- [ ] **预读 Phase 6 spec**，标注通知触发点、memory 写入点与当前系统的对接。

---

## Phase 6：运维体验与交付

**目标：** 通知可发、Memory/Skill 可用、成本可追踪、多用户并发、UI 精打磨、CI/CD 完整、可部署。

**激活 Spec：**

| 文件 | 本阶段关注点 |
|------|-------------|
| `Notification_Design.md` | 通知触发规则、dedupe、SMTP/SendGrid |
| `Memory_Skills_Lite.md` | MemoryNote 生命周期、Skill 加载、promotion 规则 |
| `Cost_Inference_Budget.md` | 三档预算、软监控、Dashboard 展示 |
| `Multiuser_Harness_Versioning.md` | 多用户并发 session、版本管理 |
| `Error_Handling_Spec.md` | 全局错误处理策略 |
| `Operational_UX_Addendum.md` | 运维体验综合设计 |
| `Data_Package_And_Retention_Spec.md` | evidence/debug/benchmark 打包、retention 策略、cleanup guard |
| `UI_Implementation_Spec.md` | 设计 tokens、组件规范、响应式 |
| `UX_Design_Spec.md` | 用户旅程、反馈模式、注意力管理 |
| `Frontend_State_Design.md` | 前端状态管理策略 |
| `Internationalization_Localization.md` | i18n 规范 |
| `Task_Playbooks.md` | 三个 Playbook 端到端验证 |

**激活 Impl：**

| 文件 | 本阶段关注点 |
|------|-------------|
| `CICD_Release.md` | 完整 CI pipeline、schema drift 强制检查 |
| `Deployment_Architecture.md` | 部署拓扑 |
| `DOD_and_Risks.md` | 完成定义、风险清单 |
| `Schema_Generation_And_Drift_Control.md` | Zod → JSON Schema → Markdown 自动化 |
| `Operational_UX_API_Contracts.md` | 运维体验 API 契约 |
| `Operational_UX_Testing_Addendum.md` | 运维体验测试 |

**交付标志：** 三个 Playbook（engineering / science-assist / ops）端到端可走通，PI 在浏览器中自然语言驱动全流程，CI 绿灯，可部署。

---

## 对齐检查点操作流程

每个阶段完成后、下一阶段开始前，执行以下操作：

### 1. 回顾（Diff）

```
问：这个阶段实际写出的代码和 spec 说的一样吗？
```

逐份检查本阶段激活的 spec：
- 字段名/类型/枚举值是否与 Zod schema 一致
- API 端点的 path/method/payload 是否与 Schemas_APIs_CLIs 一致
- 状态机的转换路径是否与 spec 一致
- 有没有 spec 没覆盖但代码里加了的东西

### 2. 修正（Fix Forward）

```
问：spec 和代码不一致的地方，谁错了？
```

- 如果代码有充分理由偏离 spec → **更新 spec**（记录原因）
- 如果代码是偷懒或遗漏 → **修复代码**
- 同步更新 CANONICAL_CONTRACTS.md 和 Minimal_Schemas.md（如涉及）

### 3. 预读（Preview）

```
问：下一阶段的 spec 在当前实现基础上还成立吗？
```

读下一阶段的所有激活 spec，标注：
- 依赖当前阶段输出的字段/接口是否存在
- 假设的数据结构是否与实际吻合
- 有没有"spec 写的时候还没写代码，现在发现不对"的地方

### 4. 调整（Adjust）

```
问：下一阶段的 spec 需要改什么？
```

- 修改下一阶段 spec 中与实现不符的部分
- **先改 spec，再写代码**——保持 spec 是权威源
- 在 spec 文件头部记录修改版本和原因

---

## 文档分布统计

| 阶段 | 激活 Spec | 激活 Impl | 新增激活 |
|------|--------:|--------:|--------:|
| 基座（全程） | 7 | — | 7 |
| Phase 1 骨架 | 4 | 2 | 6 |
| Phase 2 执行 | 7 | 1 | 8 |
| Phase 3 科学 | 4 | — | 4 |
| Phase 4 分析 | 5 | — | 5 |
| Phase 5 治理 | 6 | — | 6 |
| Phase 6 交付 | 12 | 6 | 18 |
| **合计** | **45** | **9** | **54** |

> 剩余 13 份文档（GAP_ANALYSIS、Spec_Gap_Audit、02_ARCHITECTURE × 8、01_CODEBASE × 4 中未直接用到的部分）为背景参考，不绑定阶段。
