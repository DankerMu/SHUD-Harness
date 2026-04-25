# SHUD-Harness v0.8.1 规格缺口审查与补充包

本包用于合并到 `DankerMu/SHUD-Harness` 当前 v0.8.1 文档体系。文件名和路径保持英文；正文为中文。

## 生成目的

当前仓库已经完成 v0.8.1 的主体设计：Web-first、PI-led、RunRecord-first、Park/Resume、Operational UX、UI/UX、WebSocket、权限、测试与 CI/CD 均已覆盖。本包不推翻当前设计，只补齐工程开工前仍会造成实现漂移的“机器契约层”缺口。

重点补充：

1. `SPEC_v0.8_Final.md` 与 `Minimal_Schemas.md` 的 canonical 同步。
2. Support schema 的统一定义：Artifact、PiGate、PiGateDecision、NotificationRecord、ReportExport、AnalysisProgressPayload、ErrorRecord、AuditEvent 等。
3. Artifact registry、evidence lineage、report export、retention 与分享边界。
4. 幂等、锁、并发、恢复、snapshot、event replay。
5. User/Session/Audit、config/secrets、runner adapter 与 API error/idempotency contract。
6. 文档链接、schema generation、CI drift check 与开工 readiness checklist。

## 推荐合并顺序

1. 先读 `docs/00_INDEX/Spec_Gap_Audit_v0_8_1.md`。
2. 再读 `docs/00_INDEX/Spec_Gap_Merge_Map.md`。
3. 先新增 `docs/03_SPEC/Support_Schema_Contracts.md`、`Artifact_Registry_Spec.md`、`Idempotency_Concurrency_Locking_Spec.md`。
4. 再按 `patches/` 逐个把补丁片段并入现有文档。
5. 最后用 `docs/04_IMPLEMENTATION/MVP_Implementation_Readiness_Checklist.md` 做开工前检查。

## 包内文件类型

- `docs/`：建议新增的正式规范文档。
- `patches/`：对现有文档的补充片段，标明插入位置和合并动作。
- `MANIFEST.md`：文件清单与用途。

## 不包含内容

本包不包含运行时代码、不修改仓库文件、不包含真实数据、不包含 secrets。
