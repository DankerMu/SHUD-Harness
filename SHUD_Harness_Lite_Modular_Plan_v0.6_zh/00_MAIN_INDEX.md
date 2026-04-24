# SHUD-Harness Lite v0.6 主索引

主文档只放索引、边界和阅读路径；具体设计拆到子文档。

---

## 0. v0.6 一句话定义

**SHUD-Harness Lite 是一个 PI 主导、CLI-first、bash-first、job-aware 的 SHUD 科研工程助手。**

它负责：

```text
把 PI 的科研/工程意图
  → 转成可执行任务卡
  → 在受控工作区运行 SHUD/rSHUD/AutoSHUD
  → 管理长任务、日志、产物、数据来源和版本锁
  → 生成报告、补丁、验证摘要和待 PI 判断的问题
```

它不负责：

```text
- 独立提出科学结论；
- 独立判断水文机制是否成立；
- 自主推进多轮科研路线；
- 以 LLM 审查 LLM 的方式替代 PI；
- 在 MVP 阶段构建大而全 Web 平台。
```

---

## 1. 子文档目录

### 01_POSITIONING：项目定位与角色边界

- `01_Project_Positioning_MVP.md`  
  定义 Lite 版本边界：PI 主导、工程助手、MVP 可落地范围。

- `02_Roles_PI_Coordinator_Worker.md`  
  重新定义 PI、Coordinator Agent、Worker Agent、Reviewer 的职责边界。

- `03_Interaction_Model_CLI_First.md`  
  明确日常交互入口：CLI-first、Markdown report、可选轻量 Web。

### 02_ARCHITECTURE：架构与 ZeRo 决策

- `01_Minimal_Runtime_Kernel.md`  
  极简 runtime kernel：Brief → Plan → Execute/Submit → Park/Collect → Report → Ask PI。

- `02_Zero_Reference_Decision.md`  
  明确路线：不 fork ZeRo 做 MVP；以 ZeRo 为参考实现。

- `03_Module_Status_RMN_Matrix.md`  
  每个模块标注 [R] / [M] / [N]，区分可参考、需修改、必须新增。

### 03_DOMAIN：轻量领域对象与 SHUD 专项能力

- `01_Lightweight_Object_Model.md`  
  将 ~20 个对象压缩为 8 个核心对象 + 字段维度。

- `02_Data_Storage_and_Provenance.md`  
  数据存储策略、大文件管理、DataProvenance 设计。

- `03_Execution_Job_Run_Records.md`  
  长任务、Job、RunRecord、失败恢复和增量运行。

- `04_Sensitivity_Calibration_Benchmark.md`  
  把参数敏感性分析升为一等能力，同时区分 calibration 与 scientific claim。

### 04_RUNTIME：运行治理、记忆技能、成本和协作

- `01_Sandbox_Trace_Recovery.md`  
  沙箱、trace、回滚、死循环防护、垃圾清理。

- `02_Memory_and_Skills_Lite.md`  
  轻量 memory / skill：少审批、少对象、以工程判断为主。

- `03_Cost_and_Inference_Budget.md`  
  LLM API 成本预算、调用上限、模式切换和降级策略。

- `04_Multiuser_and_Harness_Versioning.md`  
  多用户、多 session、Harness 自身版本锁和 prompt/skill 版本管理。

### 05_IMPLEMENTATION：实现方案

- `01_File_Tree.md`  
  MVP 文件树与数据目录。

- `02_CLI_API_Schemas.md`  
  CLI 命令、轻量 API、核心 YAML schema。

- `03_8_Week_Implementation_Plan.md`  
  面向 1 名工程师的 8 周实施计划。

- `04_Definition_of_Done.md`  
  验收标准、删减清单和风险控制。

### 99_APPENDICES：附录

- `A_Minimal_Schemas.md`  
  可直接复制的 YAML schema 草案。

- `B_Zero_Reference_Pointers.md`  
  ZeRo 可参考实现点。

- `C_Task_Playbooks.md`  
  三类任务 playbook：工程任务、科学辅助任务、运维任务。

---

## 2. v0.6 的核心取舍

| 问题 | v0.6 决策 |
|---|---|
| 对象膨胀 | 从约 20 个对象压缩为 8 个核心对象 |
| Commander 角色错位 | Commander 改名/定位为 Coordinator，负责执行协调，不负责科学决策 |
| Memory/Skill 官僚化 | proposal 流程只保留给高价值结论；普通经验直接写 draft note |
| 科学计算时间尺度 | 引入 Park/Collect/Resume，长任务不是 agent loop 的同步步骤 |
| 工程任务与科学任务混淆 | 使用 TaskCard.type 区分 engineering / science-assist / ops |
| 敏感性分析缺失 | 增加 SensitivityPlan 作为一等能力，但不做重对象治理 |
| 成本盲区 | 每个任务有 InferenceBudget，Critic 默认关闭 |
| 交互模型模糊 | CLI-first，报告-first，Web 最小化 |
| ZeRo 路线摇摆 | MVP 不 fork ZeRo；独立实现 Lite runtime；ZeRo 只作参考 |
| 数据存储/失败恢复/增量运行 | 作为 MVP 硬需求写入 runtime 和 domain 文档 |

---

## 3. 最小成功标准

8 周内，系统应能稳定完成：

```text
PI 创建任务
  → Coordinator 生成任务卡和执行计划
  → Worker 在隔离 workspace 中运行 tiny case 或工程改动
  → Job/RunRecord 记录版本、数据、日志和产物
  → 系统生成 Markdown 报告和 patch bundle
  → PI 判断是否接受、继续、校准、补敏感性分析或放弃
```

第一阶段不要求 autonomous research，不要求多 agent 自我进化，不要求完整 Web Console。
