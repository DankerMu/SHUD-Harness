# Patch: WebSocket_Protocol additions

**目标文件：** `docs/03_SPEC/WebSocket_Protocol.md`

## 插入位置：断线重连后

新增：

```markdown
snapshot_required 后的 snapshot schema、event retention、replay gap 处理和服务重启恢复见 `Workspace_Snapshot_And_Recovery_Spec.md`。
```

## 插入位置：事件持久化后

新增：

```markdown
WebSocket event 不得作为 EvidenceReport 的 evidence source。报告只能引用 RunRecord、Artifact、PiGateDecision、DataProvenance 等持久化对象。
```
