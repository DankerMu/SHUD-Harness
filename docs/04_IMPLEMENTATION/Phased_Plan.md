# 8 周实施计划

## Week 1：CLI 与 Workspace

交付：

```text
- shud-harness init
- workspace 文件树
- TaskCard schema
- basic task create/list/show
- simple report skeleton
```

验收：能创建任务并生成空报告。

## Week 2：StackLock + DataProvenance

交付：

```text
- stack lock command
- repo commit capture
- runtime/harness version capture
- data register command
- checksum capture
```

验收：任意 task 能绑定 stack_id 和 data_id。

## Week 3：Sandbox + RunJob local

交付：

```text
- task workspace
- git worktree support
- command trace
- local job submit/status/collect
- stdout/stderr artifacts
```

验收：能运行一个 dummy long job，park 后 collect。

## Week 4：Tiny SHUD Loop

交付：

```text
- run-shud-tiny-case skill
- SHUD build/run 脚本
- RunRecord
- metrics summary
- water balance summary
```

验收：tiny case 可重复运行并生成 RunRecord。

## Week 5：rSHUD Roundtrip + Compatibility

交付：

```text
- rshud-roundtrip-test skill
- old-output fixture check
- ChangeRequest schema
- patch diff/bundle
```

验收：能发现 old-output reader 失败并写入 report。

## Week 6：Sensitivity Analysis

交付：

```text
- AnalysisPlan mode=sensitivity
- batch parameter runner
- sensitivity_results.parquet
- sensitivity report section
```

验收：PI 指定参数列表后，系统生成 sensitivity table 和图表。

## Week 7：Memory/Skills Lite + Cost Budget

交付：

```text
- MemoryNote
- note add/list
- skill loader
- inference budget tracking
- max model calls/cost cap
```

验收：任务报告显示 LLM cost，普通经验可保存 note。

## Week 8：End-to-end Demo + Recovery

交付：

```text
- engineering task demo: event diagnostics 或 reader fix
- science-assist task demo: peak underestimation sensitivity summary
- rollback test
- job failure recovery test
- final README/runbook
```

验收：PI 能用报告判断下一步，工程师能复盘每个 run。

## 不在 8 周内做

```text
- full Web dashboard
- Harness Optimizer
- multi-agent autonomous loop
- full HPC scheduler integration
- release gate platform
- complex memory review workflow
```
