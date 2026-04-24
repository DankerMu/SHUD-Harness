# 交互模型：CLI-first，报告-first，Web later

## 1. 日常入口

MVP 的主要交互入口应是 CLI，而不是 Web dashboard。

原因：

```text
- PI 不会每天盯 dashboard；
- 工程师更容易把 CLI 接进现有脚本、Git 和服务器；
- SHUD 的核心活动是运行、报告、patch，而不是实时聊天；
- Web UI 会快速吞掉 1 名工程师的开发时间。
```

## 2. 推荐 CLI

```bash
# 初始化项目
shud-harness init

# 创建任务
shud-harness task create --type engineering "add event diagnostics to SHUD output"
shud-harness task create --type science-assist "summarize peak underestimation for Cache Creek storm"

# 查看任务
shud-harness task list
shud-harness task show TASK-0001

# 运行 tiny benchmark
shud-harness run tiny --task TASK-0001

# 提交长任务
shud-harness job submit --task TASK-0001 --plan plans/sensitivity_cache_creek.yaml

# 收集作业结果
shud-harness job collect JOB-0007

# 生成报告
shud-harness report TASK-0001

# 打 patch 包
shud-harness patch bundle TASK-0001
```

## 3. PI 交互方式

PI 不需要理解所有对象。PI 面向的是报告和选项：

```text
任务摘要
已完成运行
关键图表
主要失败/风险
建议选项：
  A. 补跑敏感性分析
  B. 接受工程 patch
  C. 修改任务范围
  D. 终止该方向
```

## 4. Markdown report 是第一 UI

每个任务最终生成：

```text
reports/TASK-0001_report.md
```

报告应包含：

```text
- 任务目标
- 代码/环境版本
- 数据来源
- 运行清单
- 指标摘要
- 图表链接
- 失败和不确定性
- patch 摘要
- 下一步选项
```

## 5. Web UI 最小化

MVP 只需要一个轻量 Web 或静态 index：

```text
- task list
- job status
- latest reports
- run artifacts
```

不做：

```text
- 复杂 evidence graph；
- 10 个导航页面；
- 实时多 agent dashboard；
- memory promotion 工作流页面。
```

## 6. 可选 Chat 入口

可以提供：

```bash
shud-harness ask "帮我解释 TASK-0001 报告里 old-output compatibility 为什么失败"
```

但 chat 是 report/query 辅助，不是主工作流。
