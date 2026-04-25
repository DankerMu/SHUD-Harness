# Patch: Workspace_Conventions.md additions

**目标文档：** `docs/03_SPEC/Workspace_Conventions.md`  
**目的：** 增加 notification、report export、analysis progress 的文件路径约定。  
**合并方式：** 在 workspace 目录结构 / artifact 命名章节追加。

## 新增内容

```markdown
## Operational UX artifact paths

### Report export

```text
artifacts/reports/REPORT-001.md
artifacts/reports/REPORT-001.standalone.html
artifacts/reports/REPORT-001.export_manifest.yaml
```

### Notification records

```text
workspace/notifications/NOTIFY-001.yaml
workspace/notifications/by_task/TASK-001/NOTIFY-001.yaml
```

NotificationRecord 不保存完整邮件正文，只保存 subject、body_preview、recipient、trigger、status、dedupe_key 和 error。

### Analysis progress

```text
artifacts/analysis/PLAN-001/progress.json
artifacts/analysis/PLAN-001/parameter_set_table.json
artifacts/analysis/PLAN-001/heatmap.json
```

### PI decision records

```text
tasks/TASK-001/pi_gates/GATE-001.decision.yaml
tasks/TASK-001/audit/AUDIT-001.yaml
memory/pi_decisions/NOTE-001.yaml
```

### Path safety

Standalone HTML export 不得写出 workspace 根目录。Export 中引用的 artifact path 应使用相对路径或 artifact id，不使用敏感绝对路径。
```
