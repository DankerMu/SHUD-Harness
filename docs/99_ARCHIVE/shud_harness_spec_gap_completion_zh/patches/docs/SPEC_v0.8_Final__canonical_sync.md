# Patch: SPEC_v0.8_Final canonical sync

**目标文件：** `docs/SPEC_v0.8_Final.md`  
**目的：** 该文件被索引标为自包含实施基准，但目前仍可出现旧字段/旧状态。应与 `Minimal_Schemas.md` 同步。

## 需要替换的部分

### 1. TaskCard

将 status 改为：

```text
created | planned | running | parked | reporting | awaiting_pi | done | cancelled | blocked
```

新增：

```yaml
runtime_phase: null | running_local | submitted_job | waiting_for_job | collecting
```

### 2. EvidenceReport

将旧状态：

```text
draft | pi_reviewed | accepted | rejected
```

替换为：

```text
draft | reviewed | awaiting_pi | accepted | revision_requested | rejected | archived
```

### 3. Coordinator 状态机

将 `running_local`、`submitted_job`、`collecting` 从 TaskCard.status 中移除，改为 runtime_phase。

### 4. harness version

StackLock 示例中的 `harness.version` 改为 `0.8.1` 或 `0.8.x`，不要保留 `0.7.0`。

### 5. Operational UX

在运行时章节增加：

```text
report export、notification、batch progress、PI decision comments 均为 support schema，不改变 8 个核心对象。
```

## 验收标准

- [ ] SPEC 中无 `pi_reviewed`。
- [ ] SPEC 中无 TaskCard.status=`revised`。
- [ ] SPEC 明确 runtime_phase 只是辅助字段。
- [ ] SPEC 的 EvidenceReport status 与 Minimal_Schemas 一致。
