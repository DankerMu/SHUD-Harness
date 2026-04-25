# Data Package 与 Retention 规范

**状态：** v0.8.1 P2 补充规范  
**适用范围：** EvidenceReport export、collaboration package、artifact retention、workspace cleanup、accepted reports。  
**目标：** 明确哪些数据可分享、哪些数据仅保留引用、哪些数据可清理，避免误删证据或泄露大文件/secrets。

## 1. Package 类型

| 类型 | 用途 | 内容 |
|---|---|---|
| `report_export` | PI 分享/离线读 | standalone HTML / Markdown + manifest 摘要 |
| `evidence_package` | 合作者复核 | report、metrics、figures、RunRecord yaml、DataProvenance 摘要 |
| `debug_package` | 工程师排查 | logs、toolcalls、error records、env redacted summary |
| `benchmark_package` | baseline 复盘 | StackLock、DataProvenance、RunRecord、metrics、selected outputs |

## 2. 不应打包的内容

- secrets；
- raw large raster/netCDF；
- full SHUD binary output，除非明确请求；
- 本地绝对敏感路径；
- 未脱敏 stdout/stderr；
- 用户私有 notes，除非 PI 明确选择。

## 3. EvidencePackage manifest

```yaml
evidence_package:
  package_id: PKG-001
  task_id: TASK-001
  report_id: REPORT-001
  included:
    reports: [REPORT-001]
    run_records: [RUN-001]
    metrics_artifacts: [METRICS-001]
    figures: [FIG-001]
    data_provenance: DATA-001
    stack_lock: STACK-001
  excluded:
    - artifact_id: LOG-001
      reason: large_log
  created_at: ...
```

## 4. Retention policy

| 对象 | 默认保留 | 删除条件 |
|---|---:|---|
| accepted reports | 永久 | PI 手动归档/删除 |
| report exports | 永久或跟随 report | report archived 后可保留 |
| metrics artifacts | 至少 task 生命周期 | task archived 后按 policy |
| failed run logs | 14 天 | accepted report 不引用时可清理 |
| raw data refs | 不由 Harness 删除 | 只能由 PI gate |
| benchmark baselines | 永久 | PI gate |
| tmp/scratch | 可自动清理 | 不得被 report 引用 |

## 5. Cleanup guard

清理前必须检查：

```text
artifact referenced by accepted report? yes → deny
artifact retention_class == benchmark? yes → require PI gate
artifact in tmp and not referenced? yes → allow
```

## 6. 验收标准

- [ ] 清理不会删除 accepted report 依赖的 artifact。
- [ ] EvidencePackage manifest 列出 included/excluded。
- [ ] report_export 不包含 full raw output。
- [ ] benchmark baseline 删除或替换需要 PI gate。
