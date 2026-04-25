# 数据存储与 DataProvenance

## 1. 为什么必须单独设计数据存储

SHUD 输出可能非常大：

```text
多时步 × 多单元 × 多变量 × 多案例 × 多参数组合
```

因此不能把数据塞进 memory，也不能把所有产物提交进 Git。

## 2. 存储分层

```text
shud-workspace/
  data/
    raw/             # 原始数据，只读，不由 agent 修改
    processed/       # 预处理产物，可按 data_id 管理
  runs/              # 每次模型运行的大文件输出
  artifacts/         # 日志、图表、patch、报告、指标摘要
  warehouse/         # DuckDB / Parquet 指标索引
  tasks/             # TaskCard
  reports/           # Markdown reports
```

### Artifact Registry

所有 `artifacts/` 下可被 EvidenceReport、Visualization、ReportExport 或 RunRecord 引用的文件，都必须登记为 Artifact。Artifact schema、manifest、retention_class 和 evidence_usable 规则见 [Artifact_Registry_Spec.md](Artifact_Registry_Spec.md)。

## 3. Git 策略

进入 Git：

```text
- YAML metadata；
- scripts；
- small fixtures；
- reports；
- benchmark definitions；
- checksums。
```

不进入 Git：

```text
- 大型 NetCDF；
- 全量 SHUD 输出；
- 大型栅格；
- 批量运行中间文件；
- stdout/stderr 全量历史。
```

## 4. DataProvenance 必须回答的问题

```text
1. 数据从哪里来？
2. 文件在哪里？checksum 是什么？
3. 观测站/事件窗口/单位是什么？
4. 预处理脚本和参数是什么？
5. 输出数据目录是什么？
6. 哪些不确定性需要 PI 注意？
```

## 5. 指标仓库

推荐使用 DuckDB + Parquet：

```text
warehouse/
  run_index.parquet
  event_metrics.parquet
  water_balance.parquet
  solver_health.parquet
  sensitivity_results.parquet
  benchmark_results.parquet
```

这使 Agent 可以通过简单 SQL 汇总结果：

```sql
SELECT parameter_set, peak_flow_error, water_balance_residual
FROM sensitivity_results
WHERE task_id = 'TASK-0002'
ORDER BY peak_flow_error;
```

## 6. Retention policy

MVP 必须有清理策略：

```text
- failed runs: 默认保留 14 天；
- successful tiny runs: 保留摘要，原始输出可清理；
- accepted reports: 永久保留；
- benchmark baseline runs: 保留，除非 PI 批准替换；
- batch sensitivity raw outputs: 可按需归档。
```

### 数据包与清理边界

Report export、evidence package、debug package 和 benchmark package 的打包边界见 [Data_Package_And_Retention_Spec.md](Data_Package_And_Retention_Spec.md)。清理策略必须先检查 artifact 是否被 accepted report 或 benchmark baseline 引用。

## 7. Agent 不得修改 raw data

规则：

```text
raw data mount = read-only
processed data = 只有预处理脚本可写
runs/artifacts = agent 可写
```

任何删除 raw data 或覆盖 baseline 的动作都必须失败或请求 PI 批准。
