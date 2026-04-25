# Patch: CICD_Release additions

**目标文件：** `docs/04_IMPLEMENTATION/CICD_Release.md`

## 插入位置：CI 阶段后

新增检查：

```text
validate .gitmodules
link check docs
schema generate + drift check
secret scan docs and sample artifacts
support schema tests
artifact manifest tests
idempotency tests
```

## 插入位置：文档检查后

新增：

```markdown
文档链接检查必须确认 `MASTER_INDEX.md` 中列出的每个文件存在。`SPEC_v0.7_Final.md` 若保留，必须标注 superseded。
```
