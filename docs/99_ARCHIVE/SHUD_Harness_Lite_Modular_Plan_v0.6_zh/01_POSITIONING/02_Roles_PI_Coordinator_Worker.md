# 角色边界：PI 主导，Agent 协调执行

## 1. 角色总览

| 角色 | 定位 | 是否做科学判断 |
|---|---|---|
| PI / Researcher | 科学负责人 | 是 |
| Coordinator Agent | 执行协调员 | 否 |
| Worker Agent | 具体执行者 | 否 |
| Reviewer Agent | 工程/证据完整性检查者 | 否 |
| Data Support | 数据与 benchmark 维护者 | 部分，限数据质量 |

## 2. PI / Researcher

PI 负责：

```text
- 提出科学问题；
- 设定假设或任务目标；
- 决定是否需要校准、敏感性分析、补数据或改代码；
- 判断 evidence report 是否足以支持某个科学结论；
- 批准高风险变更：物理过程、默认参数、I/O 破坏性变化、benchmark baseline。
```

PI 不需要每天盯 dashboard。系统应通过报告和明确的下一步选项服务 PI。

## 3. Coordinator Agent

v0.6 建议把 “Commander Agent” 在文档中改称 **Coordinator Agent**，避免暗示它拥有科研指挥权。

Coordinator 负责：

```text
- 根据 PI 输入创建 TaskCard；
- 把任务拆成可执行步骤；
- 选择是否直接 bash、提交 RunJob、派 Worker；
- 管理任务预算和状态；
- 收集产物，生成报告；
- 提出“建议下一步”，但不做最终科学判断。
```

Coordinator 不负责：

```text
- 自主定义科学问题；
- 自主设计关键实验并推进多轮科研路线；
- 断言假设被证伪或验证；
- 决定模型结构是否正确；
- 自动合并高风险代码变更。
```

## 4. Worker Agent

Worker 是短期执行者，通常只活在一个 task 或 episode 内。

Worker 负责：

```text
- 运行 tiny case；
- 解析日志；
- 写脚本；
- 生成图表；
- 改一小段代码；
- 生成 patch bundle；
- 汇报失败原因。
```

Worker 不直接写长期 memory，不决定科学结论。

## 5. Reviewer Agent

Reviewer 不是 “科学 Critic”。v0.6 中它只做两类检查：

### A. 工程检查

```text
- 是否跑了指定 benchmark；
- patch 是否越界；
- 是否破坏旧输出；
- 日志和产物是否完整；
- 是否遗漏 StackLock / DataProvenance。
```

### B. 报告完整性检查

```text
- 是否明确 baseline；
- 是否列出 uncertainty；
- 是否把“观察”误写成“结论”；
- 是否有让 PI 判断的开放问题。
```

Reviewer 不判断“水文机制是否成立”。

## 6. 人机协作闭环

推荐闭环：

```text
PI: 提出任务 / 选择路线
Coordinator: 建 TaskCard + 执行计划
Worker/Job: 跑模型 / 改代码 / 产出报告
Reviewer: 检查工程和报告完整性
PI: 接受、修改、继续、终止
```

这比 “LLM Commander 自主科研” 更可信，也更符合小团队使用方式。
