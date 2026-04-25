# Patch: Data_Storage_Provenance additions

**目标文件：** `docs/03_SPEC/Data_Storage_Provenance.md`

## 插入位置：存储分层后

新增 Artifact Registry 引用：

```markdown
所有 `artifacts/` 下可被 EvidenceReport、Visualization、ReportExport 或 RunRecord 引用的文件，都必须登记为 Artifact。Artifact schema、manifest、retention_class 和 evidence_usable 规则见 `Artifact_Registry_Spec.md`。
```

## 插入位置：Retention policy 后

新增：

```markdown
Report export、evidence package、debug package 和 benchmark package 的打包边界见 `Data_Package_And_Retention_Spec.md`。清理策略必须先检查 artifact 是否被 accepted report 或 benchmark baseline 引用。
```
