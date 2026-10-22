# Proposal

## Why

#277：`normalizeRawDirs`（`packages/dsh-shud-raw-guard/src/decide.ts:86`）只去结尾 `/`，前导 `./` 原样保留。shell 分支提及判定的配置侧文本是 `[raw, normalizeCommandPaths(raw), root]`，而 `normalizeCommandPaths` 刻意保留前导 `./`。所以配置写成 `["./sub/raw"]` 时，命令用最自然的 `sub/raw/...` 相对写法执行 `rm`/`mv`/重定向写入落 `next()`，读取也不弹 provenance 审批卡。#273 的祖先推导同样从配置原文取祖先，得到 `./sub`，`rm -rf sub` 也漏。文件工具分支走 `canonical`，不受影响。默认配置 `["data/raw"]` 不触发；风险在部署期用户覆写 `rawDirs` 时写成 `./...`。属 Critical Path #2。

## What Changes

- `normalizeRawDirs`：每项配置原文先折叠 `//`、去除 `/.` 段（后接 `/` 或结尾），再去一个前导 `./`（后面还有字符时），再去结尾 `/`。不复用命令侧的 `normalizeCommandPaths`：它把 `/.` 后接 shell 边界字符也当作段，会把 `a/. b` 改写成另一条路径。所有消费者（提及判定、祖先推导、`canonical`）看到同一规范文本。单点改动，无新配置项，现有不带 `./` 的配置零行为变化。
- `decide.test.ts`：issue 验收表入表，加 `normalizeRawDirs` 单测与祖先行。
- 规范 `raw-data-guard` "Raw directory configuration"：写明规范化规则，加五个场景。

备选：只在提及判定配置侧追加一份去 `./` 的文本——#273 祖先推导要另改，同一规范化散落两处，不取。对 `./` 前缀 fail-loud 拒绝——让合法配置启动失败（破坏 userspace），不取。

## Triage

Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent（issue-scribe，Readiness implementation-ready）；触发词：path safety、raw 保护（Critical Path #2）、next→deny/ask 收紧
Blast radius: 规范化过宽会改变既有配置语义（`..`、`.raw`、绝对路径必须不变）；`./` 被处理成空串会变成 `/`，把整个文件系统当 raw（fail-closed 但不可用）；探针 T1–T5 用默认配置，必须不变
Selected risk packs: Config / project setup; File IO / path safety; Auth / permissions / secrets; Legacy compatibility; Documentation / migration notes
Evidence floor: 新增 deny/ask 行与单测先红后绿，next 反例与文件工具行改前改后都绿；既有全部行不变；11 项突变；`pnpm run check`；`pnpm run raw-guard:probes` 两次 T1–T5 PASS、md5 不变

## Capabilities

### Modified Capabilities

- `raw-data-guard`: "Raw directory configuration"。

## Impact

- 代码：`packages/dsh-shud-raw-guard/src/decide.ts`（`normalizeRawDirs` 返回值，约 10 行）、`decide.test.ts`。
- 规范：`openspec/specs/raw-data-guard/spec.md` 一条 Requirement。
- 运行时：`lib/decide.js` 由 `pnpm run build` 产出；探针不改。
