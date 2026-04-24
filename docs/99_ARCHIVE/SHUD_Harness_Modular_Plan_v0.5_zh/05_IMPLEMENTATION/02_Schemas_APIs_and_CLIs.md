# I-02 Schemas、APIs 与 CLIs

## 模块状态标签
- **独立实现**：必须支持
- **ZeRo 参考实现**：弱参考
- **[R] 已实现可复用**：部分 HTTP / WebSocket / CLI 启动骨架
- **[M] 需修改后复用**：control plane endpoints
- **[N] 必须新增**：research-object APIs、stacklock/job/dataset/calibration/benchmark CLI

## 1. Schema 优先
所有一级对象都必须先有 schema，再写 store、API、UI：
- RCS
- ExperimentSpec
- JobSpec
- RunManifest
- EvidencePacket
- ChangeSpec
- ValidationReport
- StackLock / EnvLock
- DatasetManifest / ObservationManifest / PreprocessRecipe
- CalibrationSpec / HoldoutPolicy
- OutputContract / CompatibilitySuite
- BenchmarkPolicy / ReleaseGate

## 2. CLI 最小集合
```text
harness rcs create / show / list
harness stacklock snapshot / verify / diff
harness dataset register / verify / freeze / diff
harness job submit / watch / collect / cancel
harness run show
harness evidence show / promote
harness calibration create / run / analyze
harness benchmark run / diff / promote-baseline
harness gate approve / reject
```

## 3. API 最小集合
```text
POST   /api/rcs
GET    /api/rcs/:id

POST   /api/stacklocks/snapshot
GET    /api/stacklocks/:id
GET    /api/stacklocks/:id/diff/:other

POST   /api/datasets/register
POST   /api/datasets/:id/verify
POST   /api/datasets/:id/freeze

POST   /api/jobs
GET    /api/jobs/:id
POST   /api/jobs/:id/cancel
POST   /api/jobs/:id/collect

POST   /api/calibration/specs
POST   /api/calibration/specs/:id/run
GET    /api/calibration/runs/:id

POST   /api/benchmarks/run
GET    /api/benchmarks/reports/:id
POST   /api/benchmarks/promote-baseline

POST   /api/gates/:id/approve
POST   /api/gates/:id/reject
```

## 4. Store 最小接口
所有 store 至少支持：
- create
- get by id
- list / query
- update status
- link related object ids

## 5. WebSocket 事件建议
```text
session.updated
episode.updated
job.updated
validation.updated
gate.updated
memory_proposal.updated
skill_proposal.updated
```

## 6. 与 ZeRo 的关系
ZeRo 的 web backend 与 server bootstrap 可做 HTTP/WebSocket 骨架参考；  
但这些 research APIs 本身需要 SHUD-Harness 新增。

## 7. V1 最低要求
- schemas 可独立 validate
- CLI 至少覆盖 stacklock/job/dataset/benchmark 四类对象
- API 至少覆盖 RCS、jobs、benchmarks、gates
