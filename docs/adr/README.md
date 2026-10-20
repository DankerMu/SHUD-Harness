# Decision records（四区生命周期）

长期架构/流程决策的账本。三门槛：难回退 + 无背景会困惑 + 真实权衡。机械校验：`pnpm run adr:check`（`scripts/adr/verify.sh`）。

## 区

| 区 | 含义 | 允许的 `status` |
|---|---|---|
| `proposed/` | 草稿，等待 PI 决定 | `proposed` |
| `implemented/` | 已接受、后续工作引用的决策 | `accepted` |
| `rejected/` | 明确否决、仍能阻止某个诱人错误的记录 | `rejected` |
| `archived/` | 冻结，永不编辑；哈希登记在 `manifest.yaml` | `archived` `superseded` `deprecated` |

## 规则

1. **文件名** `NNNN-slug.md`，id 四位全库唯一；新记录写进 `proposed/`，取下一个 id。
2. **frontmatter** 必含 `status` 与 `kind`；`kind` ∈ `architecture | process | testing | bug-fix | feature | simplification`，按"决定了什么"分类。
3. **note-required**：非平凡变更在同一 PR 内附决策记录；机械/局部修改免。
4. **取代**：先搜活跃记录；完全被取代的记录移入 `archived/` 并在新记录链接；部分取代只交叉链接，绝不把记录改成另一个决策。
5. **归档冻结**：移入 `archived/` 时把 `sha256` 写进 `manifest.yaml`；此后任何编辑被 `adr:check` 判红，想改就写新 `proposed/`。
6. **GC 按未来决策价值**，不按年龄或配额：周期性审计 `archived/` 与 `rejected/`，留下仍能引导未来工作的记录。
7. **一处指针**：AGENTS.md 只在拥有该时刻的段落放一行指针，程序不复制。

## 归档操作

```bash
git mv docs/adr/implemented/NNNN-slug.md docs/adr/archived/
printf '  docs/adr/archived/NNNN-slug.md: %s\n' "$(shasum -a 256 docs/adr/archived/NNNN-slug.md | cut -d' ' -f1)" >> docs/adr/manifest.yaml
pnpm run adr:check
```
