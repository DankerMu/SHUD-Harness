# Patch: DOD_and_Risks additions

**目标文档**：`docs/04_IMPLEMENTATION/DOD_and_Risks.md`  
**插入位置**：完成定义与风险表后。

## 新增 Definition of Done

开发阶段 DoD 增加：

- [ ] 新功能关联至少一个 `FR-*` 或 `NFR-*`。
- [ ] P0/P1 requirement 有测试 ID。
- [ ] 新 endpoint 有 latency expectation 或明确豁免。
- [ ] 新长任务行为有 structured log 和 ErrorRecord。
- [ ] 新 artifact 类型进入 Artifact registry。
- [ ] 新运维风险进入 Runbook 或 AlertRule。
- [ ] 新依赖进入 DependencyLock 或说明无需锁定。

## 新增风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 无 health endpoint | 部署后无法判断服务是否可接收任务 | W1 实现 live/ready |
| 性能目标缺失 | UI/API 在开发后期才发现不可用 | W1 建 perf smoke |
| 运维手册缺失 | 真实长任务失败后恢复混乱 | W3 前合并 Operations_Runbook |
| lockfile 漂移 | schema/runtime 行为不稳定 | frozen install + dependency check |
| 需求无编号 | 测试和 release gate 无法追踪 | Requirements_Catalog + Traceability |
