# 测试策略

**状态：** P2 实施规范  
**适用范围：** schema、API、WebSocket、executor、SHUD fixture、report、UI  
**目标：** 用分层测试保证 v0.8 端到端闭环可复盘。

## 1. 测试分层

| 层级 | 测试对象 |
|---|---|
| unit | Zod schema、reducers、path policy、metric functions |
| integration | API + filesystem、WebSocket、Sandbox Executor |
| fixture | ccw tiny 或 dummy SHUD run |
| report | EvidenceReport 生成和 language guard |
| e2e | Web UI 创建 task、运行 job、生成 report |

## 2. Schema 测试

必须测试：

- TaskCard；
- StackLock；
- DataProvenance；
- RunJob；
- RunRecord；
- AnalysisPlan；
- EvidenceReport；
- ChangeRequest；
- WebSocket event envelope。

## 3. WebSocket 测试

测试场景：

- seq 单调递增；
- event 去重；
- reconnect with `since_seq`；
- snapshot fallback；
- job.log streaming；
- PI gate action 权限失败。

## 4. Sandbox 测试

测试：

- workspace 内命令成功；
- workspace 外写入被拒绝；
- timeout；
- stdout/stderr 分片；
- high risk command 被 gate；
- env secrets redaction。

## 5. Fixture 测试

MVP 推荐两个 fixture：

| fixture | 作用 |
|---|---|
| dummy runner | 快速测试 job/collect/report，不依赖 SHUD |
| ccw tiny | 测试真实 SHUD/rSHUD 闭环 |

ccw tiny 验收：

- SHUD 编译成功；
- 30 天运行 exit_code=0；
- 生成 RunRecord；
- water_balance_residual 达阈值；
- HydrographChart 可加载 `rivqdown`。

## 6. Report 测试

应包含 language guard：

- 禁止“模型机制已验证”；
- 禁止“普遍改进”；
- 必须包含 limitations；
- 必须包含 PI questions；
- artifact 引用存在。

## 7. UI 测试

E2E 流程：

```text
打开 workspace
→ 创建 task
→ 提交 dummy job
→ 查看日志流
→ collect RunRecord
→ 打开 ResultsPanel
→ 生成 report
→ PI approve/revision
```

## 7.1 Operational UX tests

### Notification tests

- [ ] RunRecord/report/analysis completed 后创建 NotificationRecord。
- [ ] SMTP mock 成功后状态为 `sent`。
- [ ] SMTP mock 失败后状态为 `failed`，不回滚任务主流程。
- [ ] 同一 dedupe_key 不重复发送。
- [ ] 无收件人时状态为 `skipped`。
- [ ] 邮件正文不包含 secrets、完整日志或 raw output。

### Report export tests

- [ ] `GET /api/reports/:id/export?format=html` 返回 standalone HTML。
- [ ] draft report HTML 有可见 watermark。
- [ ] accepted report HTML 不显示 draft watermark。
- [ ] export manifest 记录 included/excluded artifacts。
- [ ] 缺失图表时导出仍成功，并标注 missing artifact。

### Batch progress tests

- [ ] AnalysisPlan 创建后 progress total 等于 parameter_sets 数量。
- [ ] job.status 更新能更新对应 cell。
- [ ] failed cell 不从 grid/table/report 中消失。
- [ ] `GET /api/analysis/:id/progress` 聚合计数正确。
- [ ] RuntimeTerminal 不把完整日志塞入 React state。

### PI decision comment tests

- [ ] 普通 approve report 可无 comment。
- [ ] reject 无 comment 返回 400。
- [ ] request_revision 无 comment 返回 400。
- [ ] high-risk approve 无 comment 返回 400。
- [ ] agent 身份调用 PI decision endpoint 返回 403。
- [ ] 成功 decision 写 audit log、MemoryNote 和 report decision history。
- [ ] MemoryNote(type=pi_decision) 的 `generalization_allowed=false`。

### 补充测试类别

- **Support schema 测试**：Artifact、PiGate、NotificationRecord、ReportExport、AnalysisProgressPayload、ErrorRecord、AuditEvent 的 Zod 校验。
- **Artifact registry 测试**：evidence_usable 判定、retention_class 约束、manifest integrity 校验。
- **Idempotency 测试**：collect / export / notification / PI decision 重复请求不产生冲突对象。
- **Snapshot recovery 测试**：since_seq 过期时走 snapshot_required 流程、service restart 后 parked job 恢复。
- **Runner adapter 测试**：local_direct / local_job 的 status mapping 和 collect result 格式。
- **API error 测试**：400 / 403 / 409 / 422 统一 envelope 返回。

## 8. 验收标准

- [ ] CI 跑 schema/unit/integration 测试。
- [ ] 本地可手动跑 ccw tiny fixture。
- [ ] WebSocket reconnect 有自动测试。
- [ ] 报告 language guard 有负例测试。
- [ ] Sandbox path policy 有越界测试。
