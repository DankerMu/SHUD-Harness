# Proposal

## Why

#273：raw-guard 的 shell 分支判断"命令是否触及 raw"时，只看命令里是否出现 raw 路径本身，或 workdir 是否在 raw 内（`packages/dsh-shud-raw-guard/src/decide.ts` 中 `decideRawAccess` 的 shell 分支）。对 raw 的祖先目录做递归写操作，例如 `rm -rf data`、`mv data x`、`chmod -R 000 data`，会被判为与 raw 无关，直接落 `next()`。

实际后果分两种形态：
- dev/probe 形态下 raw 在 workspace 内，没有沙箱兜底，这类命令会真的删掉或移走整个 raw 树。
- 部署形态下 raw 在 workspace 外，Seatbelt 只读兜底，raw 内容不会被改写。但这类写操作走的是通用升权卡，卡面不提 raw。

自 #211 起就存在这个问题，正式规范的已记录漏报清单里也没有它。属 Critical Paths #1/#2。

PI 决策（2026-10-21，见 #273 评论）：
- 改代码；
- 只读祖先放行；
- 祖先只查 3 级；
- 只有破坏性动词才触发祖先规则（PR #278 第 1 轮审查后补充）。

## What Changes

- `decide.ts`：新增 `RAW_ANCESTOR_LEVELS = 3`、`rawAncestors`、祖先前后边界常量、切换目录操作数剥离正则，以及专用决策 `ANCESTOR_DENY`（code `raw-ancestor-write`）。命令不触及任何 raw、但按严格边界点名某个 raw 的 1–3 级祖先，并且含破坏性动词（rm/rmdir/unlink/mv/chmod/chown/chgrp/shred/rsync/-delete/--remove-files/git clean，pwsh Remove-Item/Move-Item/Rename-Item 及别名）时，判 `deny`。祖先从配置原文、规范根、按 cwd 字面拼接的绝对路径三处各取一份。只读与非破坏性写入仍为 next。这是纯收紧：在原 rawDirs 循环之后加第二遍判定，第一遍不变。
- `decide.test.ts`：新增 `ancestorCases` 表，覆盖 deny、已接受误报、只读、反例、级数上限、`..` 排除、已记录漏报。
- 规范 `raw-data-guard`：
  - MODIFIED "Shell command touches raw"：不触及时的委托改为"除命中祖先写入规则外"；已记录漏报由四处增为五处，新增一处：第 4 级以上祖先、隐式写法、`~`/变量展开。
  - ADDED "Shell write to a raw ancestor is denied"：附 9 个场景。

## Triage

Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent（issue-scribe 判为 needs-triage，PI 已决策）；触发词：策略门决策与 raw 保护（Critical Paths #1/#2）、next→deny 收紧
Blast radius:
- 祖先边界过宽 → workspace 内普通 `data/…` 写入被误判为 deny。必须用左边界和"`/` 后接普通名不算"两条防住，并用测试钉住。
- 绝对路径祖先会命中 workspace 根和它的父目录：`rm -rf <ws>` 判 deny 是有意行为。
- 若任意写都算，默认配置下 heredoc/`python -c`/`Rscript -e`/`echo … >> notes` 里出现单词 `data` 就会 deny（PR #278 第 1 轮 usability 审查）；因此只认破坏性动词。剩余误报：含破坏性动词的命令即使删的是别处也判定（如 `mv x.csv data`、`chmod -R g+w data`），已接受并写入 spec；代价是 `cp`/`tar -x` 覆盖祖先内文件、解释器一行程序删除祖先登记为漏报。
- workspace 根是默认 raw 的第 2 级绝对祖先：若不处理，`cd <ws> && <任意写>` 会全部 deny。切换目录（`cd`/`pushd`/`Set-Location`）的操作数因此不算点名；代价是 `cd data && rm -rf raw` 归入隐式写法漏报。
- 配置为 `../outside/raw` 时，祖先 `..` 必须排除，否则 `mv x ..`、`cp f ..` 会被误判。
- 切换目录剥离不判断命令位置：任何单独出现的 `cd`/`pushd`/`sl` 词都会吃掉后一个词（如 `rm -rf cd data`），写入漏报清单；其选项子模式不得越过 `;&|()<>`，否则 `cd -P&&rm -rf data` 会放行。
- 探针 T1–T5 必须不变。
Selected risk packs: Public API / CLI / script entry; File IO / path safety; Auth / permissions / secrets; Legacy compatibility; Documentation / migration notes; Resource limits
Evidence floor: 新增 deny 行先红后绿，next 行改前改后都绿；既有全部行不变；22 项突变；`pnpm run check`；`pnpm run raw-guard:probes` 两次 T1–T5 PASS、md5 不变

## Capabilities

### Modified Capabilities

- `raw-data-guard`："Shell command touches raw"（MODIFIED）；"Shell write to a raw ancestor is denied"（ADDED）。

## Impact

- 代码：`packages/dsh-shud-raw-guard/src/decide.ts`（约 25 行）、`decide.test.ts`。
- 规范：`openspec/specs/raw-data-guard/spec.md` 改一条 Requirement、加一条 Requirement。
- 运行时：`lib/decide.js` 由 `pnpm run build` 产出；探针不改。
