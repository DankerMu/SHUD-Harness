# 附录 A：模块状态矩阵（速查版）

| 模块 | 状态 | 备注 |
|---|---|---|
| Agent loop kernel | [R] | ZeRo 可直接参考 |
| Task closure | [R]/[M] | 需科研特化 |
| Roles | [M] | 通用角色需改成 SHUD 角色 |
| Bash tool | [M] | 需升级为科研 sandbox |
| Sub-agent tools | [R] | 可直接映射 Worker/Critic |
| Scheduler | [R] | 但不等于 executor |
| Skills loader | [R]/[M] | 需加 validator/lifecycle |
| Memory store | [M] | proposal-only 必改 |
| Web control plane | [R]/[M] | IA 必须重构 |
| ResearchChangeSet | [N] | 必须新增 |
| ExperimentSpec | [N] | 必须新增 |
| JobSpec / Executor | [N] | 必须新增 |
| StackLock / EnvLock | [N] | 必须新增 |
| DatasetManifest | [N] | 必须新增 |
| ObservationManifest | [N] | 必须新增 |
| PreprocessRecipe | [N] | 必须新增 |
| CalibrationSpec | [N] | 必须新增 |
| HoldoutPolicy | [N] | 必须新增 |
| OutputContract | [N] | 必须新增 |
| CompatibilitySuite | [N] | 必须新增 |
| BenchmarkPolicy | [N] | 必须新增 |
| Human Gate / ReleaseGate | [N] | 必须新增 |
| ArtifactManifest / Warehouse | [N] | 必须新增 |
| Harness Optimizer | [N] | P2 再做 |
