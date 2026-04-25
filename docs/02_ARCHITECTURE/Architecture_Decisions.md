# 项目定位：SHUD-Harness Lite MVP

## 1. 定位调整

v0.6 不再把系统定位成“科研 Agent Runtime 平台”，而是：

> **PI 主导的 SHUD 科研工程助手。**

它的核心价值是把 PI 和工程师日常已经在做的工作结构化、自动化、可复盘：

```text
运行模型、查日志、生成脚本、做对比、保存版本、写报告、打 patch、提醒风险。
```

## 2. 目标团队假设

本方案按以下团队配置设计：

```text
- 1 名 PI：提出问题、设定实验方向、判断结论；
- 1 名研究软件工程师：实现 runtime、工具链、脚本、验证流程；
- 0.5 名数据支持：维护 benchmark 数据、观测数据和预处理脚本。
```

因此任何需要专职平台团队、复杂审批流或大量 UI 工作的设计都降级到后续阶段。

## 3. MVP 只做三类任务

### A. 工程任务

例如：

```text
- 给 SHUD 添加诊断输出；
- 修复 rSHUD reader 对旧输出格式的兼容性；
- 更新 AutoSHUD 报告阶段；
- 添加 tiny benchmark 脚本。
```

这类任务可以由 Agent 较强地执行，但必须有 sandbox、patch 和 validation。

### B. 科学辅助任务

例如：

```text
- 按 PI 指定假设跑参数敏感性分析；
- 对某次洪峰偏低做指标和图表汇总；
- 把模型输出与观测数据做事件级对比；
- 草拟 evidence report 供 PI 判断。
```

这类任务中，Agent 只能辅助整理证据，不得替 PI 做科学结论。

### C. 运维/复盘任务

例如：

```text
- 记录某次失败原因；
- 清理旧 runs；
- 生成本周任务报告；
- 检查环境版本漂移。
```

这类任务不需要 heavy governance。

## 4. 非目标

MVP 不做：

```text
- 全自动科研；
- 自主演化的 Harness Optimizer；
- 复杂平台级 Web Console（MVP 做 Web-first 四栏科研工作台的最小可运行版本）；
- 多层 memory 审批；
- 大规模 HPC 平台；
- 复杂 release gate；
- 把每个治理关切都建成顶级对象。
```

## 5. v0.6 成功标准

```text
少对象、少页面、少 agent、少审批；
强 trace、强 run record、强报告、强回滚、强版本锁。
```

这比“制度正确”更重要。
