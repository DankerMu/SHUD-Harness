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
- build_id: BUILD-20261102T090000-f6a7

### StackLock STACK-20261029T080000-a001

| Repository | Commit | Branch | Dirty | Dirty paths truncated |
| --- | --- | --- | --- | --- |
| SHUD | 1111111111111111111111111111111111111111 | main | false | false |
| rSHUD | 2222222222222222222222222222222222222222 | main | false | false |
| AutoSHUD | 3333333333333333333333333333333333333333 | main | false | false |

- base_url: https://second.invalid
- request_alias: second-alias
- response_model: second-stack-model
- build_id: BUILD-20261102T090000-a7b8

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

### ChangeRequest CHG-20261102T090000-b002

- change_id: CHG-20261102T090000-b002
- base_commit: 1111111111111111111111111111111111111111
- semantic_level: pure_engineering
- semantic_floor: pure_engineering
- risk: low
- files_changed[0]: docs/build.md
- files_changed[1]: scripts/build.sh
- floor_categories[0]: pure_engineering
- patch_path: patches/CHG-20261102T090000-b002.patch
- patch_sha256: ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
- status: proposed
- approval_ref: null

### ChangeRequest CHG-20261102T090000-a1b2

- change_id: CHG-20261102T090000-a1b2
- base_commit: 1111111111111111111111111111111111111111
- semantic_level: numerical_implementation
- semantic_floor: numerical_implementation
- risk: high
- files_changed[0]: Makefile
- files_changed[1]: src/Model/rhs.cpp
- floor_categories[0]: pure_engineering
- floor_categories[1]: numerical_implementation
- patch_path: patches/CHG-20261102T090000-a1b2.patch
- patch_sha256: ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
- status: approved
- approval_ref: call-change-submit-533

### VerificationCase VC-20261102T090000-b2c3

- vc_id: VC-20261102T090000-b2c3
- case_type: regression
- expected_result_source: baseline_regression
- pass_criteria: The two archived output SHA256 values are equal.
- base_run_id: RUN-20261102T090000-d4e5
- candidate_run_id: RUN-20261102T090000-e5f6
- base_build_id: BUILD-20261102T090000-f6a7
- candidate_build_id: BUILD-20261102T090000-a7b8
- observed.base_sha256: ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
- observed.candidate_sha256: 3333333333333333333333333333333333333333333333333333333333333333
- status: failed
- failure_reason: The candidate SHA256 differs from the serial baseline.
- reviewed_by: reviewer
- compatibility_verdict: incompatible
- reviewer_notes[0]: The hashes differ at N=1.
- reviewer_notes[1]: No parallel-correctness conclusion follows.

### VerificationCase VC-20261102T090000-a001

- vc_id: VC-20261102T090000-a001
- case_type: regression
- expected_result_source: baseline_regression
- pass_criteria: The two archived output SHA256 values are equal.
- base_run_id: RUN-20261102T090000-d4e5
- candidate_run_id: RUN-20261102T090000-e5f6
- base_build_id: BUILD-20261102T090000-f6a7
- candidate_build_id: BUILD-20261102T090000-a7b8
- observed.base_sha256: ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
- observed.candidate_sha256: ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
- status: passed
- failure_reason: null
- reviewed_by: reviewer
- compatibility_verdict: compatible
- reviewer_notes[0]: The hashes match at N=1.
- reviewer_notes[1]: No performance measurement was made.

### BuildRecord BUILD-20261102T090000-f6a7

- build_id: BUILD-20261102T090000-f6a7
- change_id: null
- source_commit: 1111111111111111111111111111111111111111
- rhs_openmp: false
- make_argv[0]: make
- make_argv[1]: shud
- make_argv[2]: SUNDIALS_DIR=/opt/sundials
- compiler: clang 18.1.8
- patch_sha256: null
- binary_sha256: ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad

### BuildRecord BUILD-20261102T090000-a7b8

- build_id: BUILD-20261102T090000-a7b8
- change_id: CHG-20261102T090000-a1b2
- source_commit: 1111111111111111111111111111111111111111
- rhs_openmp: true
- make_argv[0]: make
- make_argv[1]: shud
- make_argv[2]: SUNDIALS_DIR=/opt/sundials
- make_argv[3]: SHUD_ENABLE_OPENMP_RHS=1
- compiler: clang 19.0.0
- patch_sha256: ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
- binary_sha256: 2222222222222222222222222222222222222222222222222222222222222222

### BuildRecord BUILD-20261102T090000-f6a7

- build_id: BUILD-20261102T090000-f6a7
- change_id: null
- source_commit: 1111111111111111111111111111111111111111
- rhs_openmp: false
- make_argv[0]: make
- make_argv[1]: shud
- make_argv[2]: SUNDIALS_DIR=/opt/sundials
- compiler: clang 18.1.8
- patch_sha256: null
- binary_sha256: ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad

### BuildRecord BUILD-20261102T090000-a7b8

- build_id: BUILD-20261102T090000-a7b8
- change_id: CHG-20261102T090000-a1b2
- source_commit: 1111111111111111111111111111111111111111
- rhs_openmp: true
- make_argv[0]: make
- make_argv[1]: shud
- make_argv[2]: SUNDIALS_DIR=/opt/sundials
- make_argv[3]: SHUD_ENABLE_OPENMP_RHS=1
- compiler: clang 19.0.0
- patch_sha256: ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
- binary_sha256: 2222222222222222222222222222222222222222222222222222222222222222

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

本里程碑无指标 artifact；验证判定见 §3 VerificationCase 表。bitwise 一致只证明候选在 N=1 下与 serial baseline 输出一致，不构成并行正确性、性能或模型改进结论。

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
- VC-20261102T090000-b2c3: The candidate SHA256 differs from the serial baseline.

## 8. 需要 PI 判断的问题

Review this evidence?
{{header}} stays authored.

## 9. 建议下一步

下一步等待 PI 判断。

## 10. 附录：命令、日志、artifact manifest

### PI decision history

No PI decision recorded.

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
