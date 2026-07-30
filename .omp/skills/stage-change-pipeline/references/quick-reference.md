# Stage Change Pipeline — 快速参考

> 从 SKILL.md 快速参考节下推的用时估算与最小命令集。依赖清单与跳过策略仍在 SKILL.md。

**完整流水线用时**：约 30-60 分钟（取决于 capability 数量和 subagent 审核耗时）

**最小命令集**：
```bash
# Stage 2
openspec new change "<name>"
openspec status --change "<name>" --json
openspec instructions <artifact> --change "<name>" --json

# Stage 3：用编排器原生并行 subagent 同时 spawn 3 个 reviewer subagent
#   review-design-consistency / review-spec-completeness / review-tasks-executability

# Stage 4.5：spawn 独立 verifier 核销 P0/P1，未清且 < 3 轮则回 Stage 4
#   verify-review-fixes

# Stage 5
gh label create ...
gh issue create --title "..." --label "..." --body "..."
```
