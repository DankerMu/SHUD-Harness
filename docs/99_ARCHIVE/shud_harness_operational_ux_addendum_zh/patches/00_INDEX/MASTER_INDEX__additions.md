# Patch: MASTER_INDEX.md additions

**目标文档：** `docs/00_INDEX/MASTER_INDEX.md`  
**目的：** 将 v0.8.1 operational UX 新增文档加入索引。  
**合并方式：** 在 `03_SPEC/ — 规范` 表格和 `04_IMPLEMENTATION/ — 实施` 表格中追加条目。

## 插入位置 1

在 `### 03_SPEC/ — 规范` 表格中，建议插入到 `Report_Generation_Spec.md` 之后或 `Auth_Permission_Design.md` 之后。

### 新增内容

```markdown
| `Operational_UX_Addendum.md` | **v0.8.1 操作体验补充**: 通知、报告导出、批运行进度、PI 审批批注总览 |
| `Notification_Design.md` | **长任务通知**: Park/Resume 后 out-of-band email 通知、收件人解析、去重和失败策略 |
| `Report_Export_Spec.md` | **报告导出**: EvidenceReport standalone HTML / Markdown export、draft watermark、export manifest |
| `Batch_Progress_View_Spec.md` | **批运行进度视图**: ParameterSet × RunJob status grid、cell detail、progress payload |
| `PI_Decision_Comments_Spec.md` | **PI 审批批注**: decision comment、必填规则、audit log、MemoryNote(type=pi_decision) |
```

## 插入位置 2

在 `### 04_IMPLEMENTATION/ — 实施` 表格中，建议插入到 `Schemas_APIs_CLIs.md` 或 `Testing_Strategy.md` 之后。

### 新增内容

```markdown
| `Operational_UX_API_Contracts.md` | **Operational UX API**: report export、PI gate decision、analysis progress、notification events |
| `Operational_UX_Testing_Addendum.md` | **Operational UX 测试补充**: 通知、导出、批进度、PI comment 的 unit/integration/E2E 测试 |
```
