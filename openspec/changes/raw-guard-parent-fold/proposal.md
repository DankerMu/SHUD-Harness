# Proposal

## Why

#263：raw-guard shell 分支的「提及」判定把 `..` 当字面文本（`packages/dsh-shud-raw-guard/src/decide.ts:98-101` `normalizeCommandPaths` 注释 "`./x` and `..` stay as written"）。`rm -rf data/x/../raw`、`cat data/x/../raw/f` 既不 deny 也不 ask，直接落 `next()`：写 raw 不被拒，读 raw 也不弹 provenance 审批卡；dev/probe 形态下 raw 在 workspace 内，沙箱不兜底。文件工具分支经 `canonical()`（realpath）已正确处理 `..`，两分支不一致。正式规范把它登记为第四处已记录漏报中的「`..` 回溯写法」。属 Critical Paths #1/#2。

## What Changes

- `decide.ts`：新增 `foldParentSegments(text)`：按 shell 词边界（空白与 `;&|()<>'"` 反引号）切词，词内按 `/` 分段，用栈把 `..` 与其前一个普通段（非空、非 `.`、非 `..`）相消，再按原分隔符拼回。候选文本在每份 `normalizeCommandPaths` 副本之后再加一份折叠副本。纯加法：匹配模式、raw 侧文本、写动词判定、workdir 判定都不变。
- `decide.test.ts`：issue 验收表入表（deny/ask/反例/不回归/残留），`decide.test.ts` 中默认配置 `data/x/../raw` 的 next 钉住行改为 deny。
- 规范 `raw-data-guard` "Shell command touches raw"：加入 `..` 词法折叠触及条款；已记录漏报中的 `..` 条目收窄为「经符号链接回溯」「被消去段含引号或转义的空白/元字符」与「相对工作目录的前导 `..`」；新增场景 "parent traversal spelling is touching"；原场景 "parent traversal spelling is a documented gap" 保留名称（openspec 不允许 MODIFIED 块丢弃现有场景，故有意偏离 issue 验收中的改名写法），内容收窄为符号链接回溯与前导 `..`。

## Triage

Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent（issue-scribe，Readiness implementation-ready）；触发词：策略门决策与 raw 保护（Critical Paths #1/#2）、next→deny/ask 收紧
Blast radius: 折叠过宽 → 兄弟名或无关路径误判为触及（deny/ask 方向，需写明并钉住，如链接后回溯 s1）；折叠不得替换已有候选（`<raw>/../other` 仍须由原文命中，保持 deny/ask）；切词不当会跨词相消（`cat sub/a b/../raw` 必须仍是 next）；折叠须线性，不能用不动点反复替换（1e6 字符对抗输入）；探针 T1–T5 不含 `..`，必须不变
Selected risk packs: Public API / CLI / script entry; File IO / path safety; Auth / permissions / secrets; Legacy compatibility; Documentation / migration notes; Resource limits
Evidence floor: 新增 deny/ask 行先红后绿，反例、不回归、残留行改前改后都绿；既有全部行不变（`data/x/../raw` 钉住行除外，按 issue 由 next 改 deny）；`pnpm run check`；`pnpm run raw-guard:probes` 两次 T1–T5 PASS、md5 不变

## Capabilities

### Modified Capabilities

- `raw-data-guard`: "Shell command touches raw"。

## Impact

- 代码：`packages/dsh-shud-raw-guard/src/decide.ts`（新函数约 10 行，`texts` 构造 1 行）、`decide.test.ts`。
- 规范：`openspec/specs/raw-data-guard/spec.md` 一条 Requirement。
- 运行时：`lib/decide.js` 由 `pnpm run build` 产出；探针不改。
