# Patch: Report_Generation_Spec additions

**目标文件：** `docs/03_SPEC/Report_Generation_Spec.md`

## 插入位置：Artifact 引用后

新增：

```markdown
报告中关键陈述应建立 evidence lineage。ReportAssertion、assertion_type、evidence_level 和 lineage guard 见 `Report_Review_And_Evidence_Lineage_Spec.md`。
```

## 插入位置：Reviewer 检查清单

新增 checklist：

```markdown
- [ ] 每个关键指标有 source_ref。
- [ ] 每个图表观察有 figure/timeseries artifact ref。
- [ ] PI comment 没有被自动写成科学事实。
- [ ] report 没有引用 tmp 路径。
```
