# Patch: Visualization_Data_Spec additions

**目标文件：** `docs/03_SPEC/Visualization_Data_Spec.md`

## 插入位置：通用数据集 envelope 后

新增：

```markdown
每个 visualization dataset 必须登记为 Artifact 或引用已有 Artifact。图表数据不可直接从任意文件读取，必须通过 `Artifact_Registry_Spec.md` 中的 metadata 和 source_refs 校验。
```

## 插入位置：Exportable static figure requirements 后

新增：

```markdown
导出图表的 PNG/SVG artifact 必须包含 alt text、caption、generation parameters、source_ref 和 sha256。
```
