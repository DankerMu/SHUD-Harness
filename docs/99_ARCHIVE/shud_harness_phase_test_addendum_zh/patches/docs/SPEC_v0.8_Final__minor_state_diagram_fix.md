# Patch: SPEC_v0.8_Final.md — minor state diagram fix

**目标文档：** `docs/SPEC_v0.8_Final.md`  
**插入位置：** `## 6. Coordinator 行为规格 / 6.1 状态机`。  
**问题：** `TaskCard.status` canonical enum 不包含 `revision_requested`；`revision_requested` 是 EvidenceReport.status / PI decision 结果，不应出现在 TaskCard.status 状态图中。

---

## 建议替换

将状态图中的：

```text
awaiting_pi ├──→ revision_requested → running
```

替换为：

```text
awaiting_pi ├──→ planned        # PI request_revision；旧 report.status=revision_requested，TaskCard 回到 planned
```

完整建议：

```text
TaskCard.status 流转:
created ──→ planned ──→ running ──→ reporting ──→ awaiting_pi ──→ done
                    │                                        ├──→ planned    # PI request_revision
                    ├──→ parked ──→ running ──→ reporting     ├──→ cancelled
                    └──→ blocked (error/no-progress/workspace corruption)

EvidenceReport.status 流转:
draft → reviewed → awaiting_pi → accepted | revision_requested | rejected → archived(optional)
```

## 原因

这与 `Minimal_Schemas.md` 的 canonical TaskCard 粗粒度状态机保持一致，并避免前端 reducer 误把 `revision_requested` 当作 TaskCard.status。
