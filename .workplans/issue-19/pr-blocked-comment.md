PR #46 当前状态：已推送实现与多轮修复，但最终 gate 未通过，暂不合并。

最新 head：`4074cf423796f35dce3b38f906d707de2a7161f3`

本地验证已通过：
- `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/data-raw-write-rule.test.ts`
- `pnpm --package=bun@1.2.19 dlx bun run check`
- `openspec validate m1-foundation --strict --no-interactive`
- `git diff --check`
- `git -C zero diff --quiet && git -C zero rev-parse --short HEAD`

但最终六路 comprehensive review + independent verifier 确认仍有 merge-blocking 问题：
- F1 executable/interpreter payload writes
- F2 pipeline/stdin/dataflow execution
- F3 dynamic write-target operands and curl/wget traversal
- F4 shell dynamic state/budget/dynamic symlink creation
- F5 pre-existing symlink/hardlink/workDir alias boundary
- F6 raw-read compatibility / fail-closed false positives

结论：这已经不是继续补几条命令规则能稳定收口的问题。当前纯 pre-exec static scanner 无法同时满足“任意 bash 写入 `data/raw/**` 前置拒绝”和“合法 raw 读取兼容”，且 OpenSpec 又明确不做 full shell parser。按 subagent-workflow gate，PR #46 在当前 SHA 不可 merge；下一步应先重审 policy gate enforcement boundary（ADR/OpenSpec），再决定是引入执行层 realpath/inode/sandbox enforcement，还是调整 #19 的契约边界。
