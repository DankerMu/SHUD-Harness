# Patch: Testing_Strategy additions

**目标文件：** `docs/04_IMPLEMENTATION/Testing_Strategy.md`

## 插入位置：Schema 测试后

新增测试类别：

```markdown
- Support schema tests: Artifact、PiGate、NotificationRecord、ReportExport、AnalysisProgressPayload、ErrorRecord、AuditEvent。
- Artifact registry tests: evidence_usable、retention_class、manifest integrity。
- Idempotency tests: collect/export/notification/PI decision 重复请求。
- Snapshot recovery tests: since_seq 过期、service restart、parked job recovery。
- Runner adapter tests: local_direct/local_job status mapping。
- API error tests: 400/403/409/422 envelope。
```
