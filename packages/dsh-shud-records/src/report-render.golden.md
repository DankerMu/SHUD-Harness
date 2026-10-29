# EvidenceReport: REPORT-20261027T080005-3f9c
DRAFT — not accepted by PI

## 1. 摘要

  Authored summary
{{facts}} stays authored.  

## 2. 任务与问题

Task: TASK-20261027T080005-1234

## 3. StackLock 与数据来源

### StackLock STACK-20261029T080000-b002

| Repository | Commit | Branch | Dirty | Dirty paths truncated |
| --- | --- | --- | --- | --- |
| SHUD | 1111111111111111111111111111111111111111 | topic&#124;&#96;edge&#96;&#10;## injected | true | true |
| rSHUD | 2222222222222222222222222222222222222222 | main | false | false |
| AutoSHUD | 3333333333333333333333333333333333333333 | main | false | false |

- SHUD dirty_path: src/a.cpp
- SHUD dirty_path: src/z.cpp
- base_url: https://first.invalid/?a=1&amp;b=2
- request_alias: first-alias
- response_model: first-stack-model

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

### DataProvenance DATA-20261029T080000-a001

- basin: ccw-failed
- event_window.start: 2026-01-01
- event_window.end: 2026-01-02
- input_root: /not-opened/failed-input

| Source path | SHA-256 | Bytes |
| --- | --- | --- |
| failed.mesh | second-digest | 9 |

## 4. 运行记录

| Run | Stack | Data | Status | Exit code | Exit class | Wall seconds | Response model | Model source | Artifact count | Artifact bytes | Stdout | Stderr |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| RUN-20261029T080000-b002 | STACK-20261029T080000-b002 | DATA-20261029T080000-b002 | succeeded | 0 | ok | 12.5 | run-model-b | response | 2 | 9007199254740993 | stdout.log | stderr.log |
| RUN-20261029T080000-a001 | STACK-20261029T080000-a001 | DATA-20261029T080000-a001 | failed | 19 | cvode | unknown (null) | run-model-a | configured | 1 | 7 | stdout.log | stderr.log |

| Run | Water balance residual | CVODE failures | Negative state count | Max solver dt | Peak memory MB |
| --- | --- | --- | --- | --- | --- |
| RUN-20261029T080000-b002 | unknown (null) | unknown (null) | unknown (null) | unknown (null) | unknown (null) |
| RUN-20261029T080000-a001 | unknown (null) | unknown (null) | unknown (null) | unknown (null) | unknown (null) |

## 5. 指标与图表

本里程碑无指标 artifact，见 limitations

## 6. 观测与解释限制

First observation
{{summary}} stays authored.

Second observation.

No scientific metrics measured.
Do not infer model improvement.

单流域/单事件指标提升不等于模型改进
校准结果不等于结构验证
不得宣称模型机制已验证
不得宣称普遍改进

## 7. 风险和失败项

- RUN-20261029T080000-a001: cvode

## 8. 需要 PI 判断的问题

Review this evidence?
{{header}} stays authored.

## 9. 建议下一步

下一步等待 PI 判断。

## 10. 附录：命令、日志、artifact manifest

### Run RUN-20261029T080000-b002

- argv[0]: shud
- argv[1]: ccw
- argv[2]: --label
- argv[3]: {{summary}}&#124;&#96;x&#96;&#13;&#10;next&#92;end
- stdout: stdout.log
- stderr: stderr.log
- shud_output: output

| Artifact path | Bytes |
| --- | --- |
| output/z.dat | 9007199254740991 |
| output/a.dat | 2 |

### Run RUN-20261029T080000-a001

- argv[0]: shud
- argv[1]: ccw-failed
- stdout: stdout.log
- stderr: stderr.log
- shud_output: output

| Artifact path | Bytes |
| --- | --- |
| output/failure.dat | 7 |

DRAFT — not accepted by PI
