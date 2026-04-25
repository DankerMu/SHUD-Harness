# Patch: Repository_Layout additions

**目标文件：** `docs/04_IMPLEMENTATION/Repository_Layout.md`

## 插入位置：packages/core/services 后

新增 service：

```text
artifact-registry.ts
idempotency-service.ts
lock-service.ts
snapshot-service.ts
notification-service.ts
runner-adapters/
  local-direct.ts
  local-job.ts
  docker-job.ts
  slurm.ts
config-service.ts
audit-service.ts
```

## 插入位置：frontend components 后

新增组件：

```text
BatchProgressGrid.tsx
BatchCellDetailPanel.tsx
ReportExportButton.tsx
PIDecisionPanel.tsx
NotificationStatus.tsx
ArtifactRef.tsx
```
