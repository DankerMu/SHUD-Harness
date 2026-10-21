# Proposal

## Why

M1 收口复审（#245）发现 raw-guard 决策核的 shell 文本判定比正式规范窄：规范把"触及 raw"定义为命令文本**包含** raw 目录原文或其绝对路径，实现却要求原文后紧跟 `[/\s'";|&<>()]` 或行尾，于是 `rm -rf <raw>*`、`rm -rf {<raw>,x}`、`cat <raw>*` 全部 `next()`——默认/探针口径下可以不经审计删除或读取 raw。写动词识别只接受裸动词且动词表不全，`/bin/rm`、`\rm`、`unlink`、`rmdir`、`find <raw> -delete`、pwsh `Remove-Item` 落入 `ask`，审批卡却显示"读取原始数据"。两者都在 Critical Paths #1/#2 上，M2 `shud_run` 依赖 raw-guard 之前必须修。

## What Changes

- `packages/dsh-shud-raw-guard/src/decide.ts`："提及 raw"的后继边界由白名单字符类改为**非路径名字符**（`(?![A-Za-z0-9._-])`），glob / brace / 反引号等 shell 元字符一律算提及（fail-closed）；兄弟目录 `<raw>x`、`<raw>.bak`、`<raw>_old` 仍不算。
- 写动词：允许可选路径前缀与反斜杠转义（`/bin/rm`、`\rm`），动词可位于管道末尾（`| xargs rm`），动词表补 `unlink`、`rmdir`、`shred`，破坏性标志 `-delete`、`--remove-files`（任意动词携带即 deny），pwsh cmdlet `Remove-Item`/`Move-Item`/`Copy-Item`/`Rename-Item`/`New-Item`/`Set-Content`/`Add-Content`/`Clear-Content`/`Out-File` 与别名 `del`/`erase`/`ri`/`rd`（不区分大小写）。比 raw 原文更短的 glob 前缀（`protecte*`）登记为已知漏报，与 persistent `cd` 同级。
- `decide.test.ts` 为 #245 列出的每条复现命令补负例；保留 `rm protectedx/x` → `next` 等既有用例。
- 规范 `raw-data-guard` 的 "Shell command touches raw" 与 "Shell write under raw is denied" 两条 Requirement 同步改写，新增场景。
- 不改 `index.ts` 适配层、探针脚本、profile。

## Triage

Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent（issue 由 issue-scribe 产出，无 fixture 字段）；按 issue-risk-contract 的 auth/permissions + path safety 触发词取 expanded
Blast radius: 判定过窄 → raw 被不经审计读写；判定过宽 → 只读命令被多问一次审批或被 deny（已接受方向），不会丢数据
Selected risk packs: Auth / permissions; File IO / path safety; Legacy compatibility; Documentation / migration notes
Evidence floor: `pnpm vitest run packages/dsh-shud-raw-guard`（含每条 #245 复现行的负例）；`pnpm run check`；`pnpm run raw-guard:probes` T1–T5 PASS + md5 不变

## Capabilities

### Modified Capabilities

- `raw-data-guard`: shell "触及 raw" 的提及边界与写动词集合。

## Impact

- 代码：`packages/dsh-shud-raw-guard/src/{decide.ts,decide.test.ts}`（唯一决策实现，仓库内无第二份）。
- 规范：`openspec/specs/raw-data-guard/spec.md` 两条 Requirement。
- 运行时：默认 profile 的 bash/pwsh 判定更严；`cp`/重定向方向误报与 persistent `cd` 漏报保持原状（已接受，见 Non-goals）。
