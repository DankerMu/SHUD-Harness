# R-03 Observability、Artifacts 与 Jobs

## 模块状态标签
- **独立实现**：必须支持
- **ZeRo 参考实现**：强参考（logs/metrics/traces）
- **[R] 已实现可复用**：logs、metrics、trace、heartbeat、session DB
- **[M] 需修改后复用**：trace schema、artifact wiring、operator views
- **[N] 必须新增**：ArtifactManifest、Run warehouse、job event schema、evidence completeness checks

## 1. 观测系统的目标
系统不是只要“能跑”，而是必须做到：
- 可追溯
- 可回放
- 可审计
- 可汇总
- 可支持 Critic / Human review

## 2. Trace 层级
### 2.1 Session trace
- user messages
- commander decisions
- gate requests
- final summaries

### 2.2 Episode trace
- bash
- job events
- file diffs
- proposals
- worker / critic outputs

### 2.3 Tool trace
- tool name
- input summary
- output summary
- duration
- error flag

## 3. ArtifactManifest
所有重要产物必须注册成 ArtifactManifest。  
最小字段：
- artifact_id
- type
- path / uri
- sha256
- created_by
- input references
- provenance
- size
- mime type

## 4. Run Warehouse
建议至少维护以下表：
```text
run_index.parquet
metrics.parquet
water_balance.parquet
solver_health.parquet
event_metrics.parquet
validation_results.parquet
benchmark_history.parquet
job_events.parquet
```

## 5. JobEvent
```yaml
job_event_id: JE-2026-019
job_id: JOB-2026-0081
kind: running
timestamp: 2026-04-23T16:20:00Z
resources:
  cpu_pct: 630
  mem_mb: 1840
note: collected stdout tail
```

## 6. Observation Normalization
不是所有 stdout / stderr 都要原样喂回 Agent。  
应提取：
- failure class
- last model time
- cvode failures
- negative state count
- water balance availability
- artifact links
- recommended next actions

## 7. Evidence Completeness Check
在 EvidencePacket 升级前，系统应显式检查：
- StackLock 是否存在
- DatasetManifest 是否存在
- ObservationManifest 是否存在
- PreprocessRecipe 是否存在
- RunManifest 是否存在
- ValidationReport 是否存在

## 8. ZeRo 映射
### [R] 可借
- observe/logs/metrics/traces
- heartbeat
- sessions DB

### [M] 需改
- trace schema 要加入 job events / artifact refs / proposals
- Web 里不应只看 message log，而应能看对象链路

### [N] 必须新增
- ArtifactManifest store
- warehouse schema
- run / job / validation 联动
- evidence completeness checker

## 9. V1 最低要求
- 100% episode 有 trace
- 100% bash / job 有 output summary
- 100%关键产物有 manifest
- 100% validation 可定位到 input stack / dataset / preprocess / run
