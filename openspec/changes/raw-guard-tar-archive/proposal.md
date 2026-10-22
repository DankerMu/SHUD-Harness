# Proposal

## Why

#283：raw-guard 只把 tar 解包当作写。`tar -c/-r/-u/-A/--delete -f <raw>/a.tar` 会新建、截断、追加、更新或删除 raw 内的归档文件，却被判为"触及 raw 但不写"，落 `ask`；审批卡显示「读取原始数据，是否批准？」。macOS 的 `tar` 就是 `bsdtar`，但 `TAR_COMMAND` 的前一字符排除让 `bsdtar` 不被识别，`bsdtar -xf a.tar -C <raw>` 同样落读审批卡。本机实测 `-c` 新建、`-u`/`-r` 改变 `prot/a.tar` 的 md5、`bsdtar -xf … -C prot` 解包进 `prot/`。与 #245 问题 B、#279 同类。属 Critical Paths #1/#2。

## What Changes

- `decide.ts`：
  - `TAR_COMMAND` 命令名加 `bsdtar`（解包与写归档两处同时生效）；
  - 新增写归档检测：同一命令段内出现写归档模式（短选项簇或旧式首簇含 `c`/`r`/`u`/`A`，或 `--create`/`--append`/`--update`/`--catenate`/`--concatenate`/`--delete` 及缩写），取其归档操作数（第一个 `f` 后的 `-f WORD`、`-cfWORD`、`--file[=]WORD`、旧式 `cf WORD`；`-` 除外），按 workdir 解析后位于任一 raw 下时判 `deny`；
  - 提出 `tarArguments`，`tarExtracts` 与新检测共用（按段、从第一个 tar 起，线性）。
- 测试：写归档、bsdtar、workdir、ask/next 钉住、资源行，放 `decide-spelling.test.ts`。
- 规范 `raw-data-guard`：MODIFIED "Shell write under raw is denied"（bsdtar、写归档规则，3 个场景）。

备选（issue 列出）：写归档模式加任意 raw 提及一律 deny，不解析操作数。会把 #279 钉住的 `tar -cf o.tar <raw>`（把 raw 打包到别处，正常读流程）改成 deny，需要 PI 决定，不取。

## Triage

Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent（issue-scribe，Readiness implementation-ready）；触发词：策略门决策与 raw 保护（Critical Paths #1/#2）、ask→deny 收紧
Blast radius: 操作数解析错会把 raw 作为打包源的读判成 deny，或漏掉写 raw 归档；模式字母若不区分大小写，`-C` 会被当作写模式；`-` 若不排除，workdir 在 raw 内时 `tar -cf - x` 误判；探针 T1–T5 必须不变
Selected risk packs: Public API / CLI / script entry; File IO / path safety; Auth / permissions / secrets; Legacy compatibility; Documentation / migration notes; Resource limits
Evidence floor: 新增 deny 行先红后绿，ask/next 钉住行改前改后都绿；既有全部行不变；24 项突变；`pnpm run check`；`pnpm run raw-guard:probes` 两次 T1–T5 PASS、md5 不变

## Capabilities

### Modified Capabilities

- `raw-data-guard`: "Shell write under raw is denied"。

## Impact

- 代码：`packages/dsh-shud-raw-guard/src/decide.ts`（约 30 行）、`decide-spelling.test.ts`。
- 规范：`openspec/specs/raw-data-guard/spec.md` 一条 Requirement。
- 运行时：`lib/decide.js` 由 `pnpm run build` 产出；探针不改。
