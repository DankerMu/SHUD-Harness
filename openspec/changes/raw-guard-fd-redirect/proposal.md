# Proposal

## Why

#255：`WRITE_VERBS` 的重定向子式 `(^|[^<])>{1,2}\s*[^&]` 用 `[^&]` 一次排除了所有 `>&`，本意是放过 `2>&1`、`>&2` 这类 fd 复制。但 bash 中 `>&word` 在 `word` 既不是纯数字也不是 `-` 时是文件重定向（等价于 `&>word`，写 stdout+stderr 到文件；bash 5.3.15 scratch 实测 `echo hi >&f1`、`>& f3`、`1>&f2` 都会建文件）。于是 `echo x >&<raw>/b` 落 `ask`（PI 看到「读取原始数据，是否批准？」的卡，Allow 后真的写入）而不是 spec 要求的 `deny`。PR #256 白盒审查补充：`(^|[^<])` 同时排除了读写重定向 `<>`/`N<>`（O_RDWR|O_CREAT，可新建或原地覆写；实测 `echo XY 1<>p/a` 把 `hello` 改为 `XY\nlo`），`echo XY 1<><raw>/a`、`exec 3<><raw>/new` 也落 `ask`。#248 的 `/dev/null` 剥除又让 `cat <raw>/a 2>/dev/null >&<raw>/b` 由偶然的 deny 变为 ask。属 Critical Paths #1/#2 的 under-deny（仍经审批卡、workspace 外 raw 有沙箱兜底，不是 `next` 绕过）。

## What Changes

- `packages/dsh-shud-raw-guard/src/decide.ts`：
  - `WRITE_VERBS` 增加两支：`(^|[^<])>&\s*(?!(?:[0-9]+-?|-)(?=['"`]*(?:$|[\s;&|()<>}])))\S`（`>&`/`N>&` 后的 `word` 不是「纯数字、纯数字加 `-`（fd 移动）或 `-`，且其后（可隔若干引号）就是 shell 词边界」时算写）与 `<>\s*\S`（读写重定向）。原 `(^|[^<])>{1,2}\s*[^&]` 不改。
  - `DISCARD_REDIRECT` 扩为 `(?:&?>{1,2}|>&|<>)\s*\/dev\/null(?![A-Za-z0-9._/-])`：`>&/dev/null`、`<>/dev/null` 同样是丢弃型，剥除后仍为读（与 #248 一致）。
- `decide.test.ts`：issue 期望表与补充行入表（deny：`>&<raw>/b`、`>& <raw>/b`、`1>&<raw>/b`、`cat <raw>/a >&out.txt`、`>&2x`、`1<><raw>/a`、`: <><raw>/new`、`exec 3<><raw>/new`、`cat <raw>/a 0<><raw>/b`、两条 `2>/dev/null` 组合形态、`>&/dev/nullx`；ask：`2>&1`、`>&2`、`>& 2`、`1>&-`、`2>&1-`、`3>&1-`、`2>&1 | wc -l`、`2>&1;`、`sh -c '... >&2'`、`>&/dev/null`、`3<>/dev/null`、`<`、`<(...)`、`<<EOF`）。#248 与既有全部行不变。
- 规范 `raw-data-guard` "Shell write under raw is denied"：写动词清单补 `>&word`/`N>&word` 与 `<>word`/`N<>word`，丢弃型列表补 `>&`、`<>`；加两个场景。

## Triage

Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent（issue-scribe，Readiness implementation-ready）；触发词：策略门决策（Critical Paths #1/#2）、auth/permissions（ask→deny 方向）
Blast radius: 收得过宽 → fd 复制 `2>&1`（模型极常用）被判 deny，M1「bash 读 raw 弹审批卡」被盖掉；收得过窄 → 漏判留存；`<>` 作为 SQL 不等号会 deny 方向误报（spec 接受）；探针 T2（`cat` 读 → ask）、T3（`>>` 写 → deny）必须不变
Selected risk packs: Public API / CLI / script entry; File IO / path safety; Auth / permissions / secrets; Legacy compatibility; Documentation / migration notes; Resource limits（新正则无回溯爆炸）
Evidence floor: 新增 deny 行先红后绿、新增 ask 行改前改后都绿；`pnpm run check`；`pnpm run raw-guard:probes` T1–T5 PASS、md5 不变

## Capabilities

### Modified Capabilities

- `raw-data-guard`: "Shell write under raw is denied" 的重定向条款。

## Impact

- 代码：`packages/dsh-shud-raw-guard/src/decide.ts`（`WRITE_VERBS` 两支、`DISCARD_REDIRECT` 一处）、`decide.test.ts`。
- 规范：`openspec/specs/raw-data-guard/spec.md` 一条 Requirement。
- 运行时：`lib/decide.js` 由 `pnpm run build` 产出；探针不改。
