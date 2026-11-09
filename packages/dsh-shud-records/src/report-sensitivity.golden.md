# EvidenceReport: REPORT-20261027T080005-3f9c
DRAFT — not accepted by PI

## 1. 摘要

Four parameter sets were run relative to one baseline.

## 2. 任务与问题

Task: TASK-20261027T080005-1234

## 3. StackLock 与数据来源

### StackLock STACK-20261029T080000-a001

| Repository | Commit | Branch | Dirty | Dirty paths truncated |
| --- | --- | --- | --- | --- |
| SHUD | 1111111111111111111111111111111111111111 | main | false | false |
| rSHUD | 2222222222222222222222222222222222222222 | main | false | false |
| AutoSHUD | 3333333333333333333333333333333333333333 | main | false | false |

- base_url: https://second.invalid
- request_alias: second-alias
- response_model: second-stack-model

### DataProvenance DATA-20261029T080000-b002

- basin: ccw
- event_window.start: unknown (null)
- event_window.end: unknown (null)
- input_root: /not-opened/input&amp;&lt;ccw&gt;

| Source path | SHA-256 | Bytes |
| --- | --- | --- |
| ccw.mesh | first-digest | 17 |

## 4. 运行记录

| Run | Stack | Data | Status | Exit code | Exit class | Wall seconds | Response model | Model source | Artifact count | Artifact bytes | Stdout | Stderr |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| RUN-20261108T100000-0001 | STACK-20261029T080000-a001 | DATA-20261029T080000-b002 | succeeded | 0 | ok | unknown (null) | fixture-model | configured | 1 | 64 | stdout.log | stderr.log |
| RUN-20261108T100000-0002 | STACK-20261029T080000-a001 | DATA-20261029T080000-b002 | failed | 19 | cvode | unknown (null) | fixture-model | configured | 1 | 64 | stdout.log | stderr.log |
| RUN-20261108T100000-0004 | STACK-20261029T080000-a001 | DATA-20261029T080000-b002 | failed | 19 | cvode | unknown (null) | fixture-model | configured | 1 | 64 | stdout.log | stderr.log |
| RUN-20261108T100000-0005 | STACK-20261029T080000-a001 | DATA-20261029T080000-b002 | succeeded | 0 | ok | unknown (null) | fixture-model | configured | 1 | 64 | stdout.log | stderr.log |
| RUN-20261108T100000-0006 | STACK-20261029T080000-a001 | DATA-20261029T080000-b002 | succeeded | 0 | ok | unknown (null) | fixture-model | configured | 1 | 64 | stdout.log | stderr.log |

| Run | Water balance residual | CVODE failures | Negative state count | Max solver dt | Peak memory MB |
| --- | --- | --- | --- | --- | --- |
| RUN-20261108T100000-0001 | unknown (null) | unknown (null) | unknown (null) | unknown (null) | unknown (null) |
| RUN-20261108T100000-0002 | unknown (null) | unknown (null) | unknown (null) | unknown (null) | unknown (null) |
| RUN-20261108T100000-0004 | unknown (null) | unknown (null) | unknown (null) | unknown (null) | unknown (null) |
| RUN-20261108T100000-0005 | unknown (null) | unknown (null) | unknown (null) | unknown (null) | unknown (null) |
| RUN-20261108T100000-0006 | unknown (null) | unknown (null) | unknown (null) | unknown (null) | unknown (null) |

## 5. 指标与图表

| Run | Metrics status | peak_flow_m3d | peak_day | total_runoff_m3 | water_balance_residual | cvode_failures | negative_state_count | max_solver_dt | water_balance_residual verdict | cvode_failures verdict | negative_state_count verdict | Metrics path | SHA256 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| RUN-20261108T100000-0001 | ok | 185185.18349999998 | 40 | 0 | 0.004 | 0 | 0 | null (not_observable_in_pinned_shud) | pass | pass | pass | runs/RUN-20261108T100000-0001/metrics.json | 26b40fb2e055ed3ffc61749d1b3af3b6b4a8be4a4d0f8499bfb887587f8c5fb3 |
| RUN-20261108T100000-0002 | not_available | not_available | not_available | not_available | not_available | not_available | not_available | not_available | not_available | not_available | not_available | not_available | not_available |
| RUN-20261108T100000-0004 | not_available | not_available | not_available | not_available | not_available | not_available | not_available | not_available | not_available | not_available | not_available | not_available | not_available |
| RUN-20261108T100000-0005 | ok | 123456.789 | 43 | 52.5 | 0.0008 | 0 | 0 | null (not_observable_in_pinned_shud) | pass | pass | pass | runs/RUN-20261108T100000-0005/metrics.json | 08c4bc0730da585c50ac1047652c0f847c0d7d93eb56666b81b05c6d63789c34 |
| RUN-20261108T100000-0006 | ok | 210000.5 | null (no_rising_limb) | 1.5e-7 | 0.02 | 0 | 0 | null (not_observable_in_pinned_shud) | warn | pass | pass | runs/RUN-20261108T100000-0006/metrics.json | d3bcfd6a0dc989e54b6b36e813bf88709f1377f7f7394a32332c54b4b0bd75ce |

### Sensitivity summary

- path: reports/REPORT-20261027T080005-3f9c.sensitivity.json
- sha256: e43b6e7bb2366586f75eed8be503ed5a7bdb65a806abcf304ffc857194a15c74

| parameter_set_id | label | baseline | key | multiplier | job_id | run_id | status | exit_code | exit_class | peak_flow_m3d | peak_day | total_runoff_m3 | water_balance_residual | water_balance_residual verdict | delta_peak_flow_pct | delta_peak_day | delta_total_runoff_pct |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PSET-1 | baseline | true | null | null | JOB-20261108T100000-0001 | RUN-20261108T100000-0001 | succeeded | 0 | ok | 185185.18349999998 | 40 | 0 | 0.004 | pass | null (baseline_row) | null (baseline_row) | null (baseline_row) |
| PSET-2 | half&#124;KSATH | false | GEOL_KSATH | 0.5 | JOB-20261108T100000-0005 | RUN-20261108T100000-0005 | succeeded | 0 | ok | 123456.789 | 43 | 52.5 | 0.0008 | pass | -33.33333333333333 | 3 | null (zero_baseline) |
| PSET-3 | null | false | GEOL_KSATH | 2 | JOB-20261108T100000-0004 | RUN-20261108T100000-0004 | failed | 19 | cvode | null (run_failed) | null (run_failed) | null (run_failed) | null (run_failed) | null | null (run_failed) | null (run_failed) | null (run_failed) |
| PSET-4 | null | false | LC_ROUGH | 2 | JOB-20261108T100000-0006 | RUN-20261108T100000-0006 | succeeded | 0 | ok | 210000.5 | null (no_rising_limb) | 1.5e-7 | 0.02 | warn | 13.400271031942475 | null (metric_null) | null (zero_baseline) |

## 6. 观测与解释限制

Section 5 lists stored per-run metrics and relative deltas.

Authored sensitivity limitation.

仅在 ccw 单流域、90 天窗口、相对 baseline 测试了 GEOL_KSATH×0.5, GEOL_KSATH×2, LC_ROUGH×2；未覆盖其它参数、取值与窗口

参数范围为 agent 建议值，未经 PI 确认

max_solver_dt 在钉版 SHUD 中不可观测（PrintFinalStats 未被调用），各运行该项恒为 null，不作判定

运行 RUN-20261108T100000-0006 的 water_balance_residual 判定为 warn，值或原因为 0.02

参数集 PSET-3 的运行 RUN-20261108T100000-0004 失败（exit_code: 19，exit_class: cvode），该 cell 不参与相对 baseline 的比较

单流域/单事件指标提升不等于模型改进
校准结果不等于结构验证
不得宣称模型机制已验证
不得宣称普遍改进

## 7. 风险和失败项

- RUN-20261108T100000-0002: cvode
- RUN-20261108T100000-0003: no RunRecord (job_id: JOB-20261108T100000-0003, terminal_state: cancelled)
- RUN-20261108T100000-0004: cvode

## 8. 需要 PI 判断的问题

Review the stored sensitivity facts?

## 9. 建议下一步

下一步等待 PI 判断。

## 10. 附录：命令、日志、artifact manifest

### PI decision history

No PI decision recorded.

### Run RUN-20261108T100000-0001

- argv[0]: shud
- argv[1]: ccw
- stdout: stdout.log
- stderr: stderr.log
- shud_output: output

| Artifact path | Bytes |
| --- | --- |
| output/ccw.rivqdown.dat | 64 |

### Run RUN-20261108T100000-0002

- argv[0]: shud
- argv[1]: ccw
- stdout: stdout.log
- stderr: stderr.log
- shud_output: output

| Artifact path | Bytes |
| --- | --- |
| output/ccw.rivqdown.dat | 64 |

### Run RUN-20261108T100000-0004

- argv[0]: shud
- argv[1]: ccw
- stdout: stdout.log
- stderr: stderr.log
- shud_output: output

| Artifact path | Bytes |
| --- | --- |
| output/ccw.rivqdown.dat | 64 |

### Run RUN-20261108T100000-0005

- argv[0]: shud
- argv[1]: ccw
- stdout: stdout.log
- stderr: stderr.log
- shud_output: output

| Artifact path | Bytes |
| --- | --- |
| output/ccw.rivqdown.dat | 64 |

### Run RUN-20261108T100000-0006

- argv[0]: shud
- argv[1]: ccw
- stdout: stdout.log
- stderr: stderr.log
- shud_output: output

| Artifact path | Bytes |
| --- | --- |
| output/ccw.rivqdown.dat | 64 |

DRAFT — not accepted by PI
