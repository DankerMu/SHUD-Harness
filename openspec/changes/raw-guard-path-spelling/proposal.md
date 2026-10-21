# Proposal

## Why

#247：shell 分支的"提及 raw"判定只拿配置原文 `raw` 和 realpath 后的 `root` 做字面匹配，命令文本不做规范化。`data/./raw`、`data//raw`，以及 macOS 默认大小写不敏感 APFS 上的 `DATA/RAW`，都不含原文，于是写 raw 落 `next()`：既不 deny 也不弹审批卡；读同样绕过 provenance 的 `ask`。文件工具分支先 `canonical()` 再比较，没有这个问题。dev/probe 场景 raw 在 workspace 内、沙箱不兜底，这是未声明的边界（Critical Paths #1/#2）。

## What Changes

- `packages/dsh-shud-raw-guard/src/decide.ts`：mention 判定改为**加法**——原文匹配 **或** 规范化后匹配。规范化：命令文本折叠连续 `/`、去掉 `/.` 段（`data/./raw` → `data/raw`，`data//raw` → `data/raw`）。大小写：对每个 raw 根做一次探测——`realpathSync.native(root 的另一种大小写拼写)`（含小写字母取全大写，否则取全小写）能解析回 `root` 则该根所在文件系统大小写不敏感，mention 正则加 `i`；根不存在、探测失败或根中无字母 → 视为大小写敏感（不误伤）。每次判定重新探测，不缓存（缓存会把「根不存在」永久记成敏感）。探测函数 `caseInsensitiveRoot` 导出供测试直接断言。既有行为（原文、realpath 绝对路径、边界字符 `(?![A-Za-z0-9._-])`、workdir 包含）不变。
- `decide.test.ts`：`rm -rf data/./raw`、`rm -rf data//raw` → deny；`cat data/./raw/x` → ask；大小写变体在临时目录上按独立手段（`existsSync(大写拼写)`）判定的文件系统敏感性分支断言：不敏感 → deny/ask，敏感 → next，敏感 FS 上另建同名异例目录仍 next；探测函数另有隔离的 mock 测试（全大写根的小写回退、解析到不同路径、抛错）与无字母根断言；既有边界行（`rm protectedx/x` → next、`echo ok > derived.txt` → next）不变。
- 规范 `raw-data-guard` "Shell command touches raw"：等价写法与大小写变体条款 + 三个场景；`..` 回溯写法登记为已记录漏报（Non-goal）。

## Triage

Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent（issue-scribe 产出；Readiness implementation-ready，a/b 二选一——本 change 取 a，b 属放宽规范需 ADR）；触发词：策略门决策、file IO / path safety、auth/permissions
Blast radius: 规范化过宽 → 误把兄弟路径当 raw（`data/raw-x`、`data/rawx` 仍须 next）；大小写探测误判 → 大小写敏感 FS 上误伤同名异例目录，或不敏感 FS 上漏报
Selected risk packs: Public API / CLI / script entry; File IO / path safety; Auth / permissions / secrets; Legacy compatibility; Documentation / migration notes
Evidence floor: 新 deny/ask 行先红后绿；全部既有行不变；`pnpm run check`；`pnpm run raw-guard:probes` T1–T5 PASS、md5 不变

## Capabilities

### Modified Capabilities

- `raw-data-guard`: "Shell command touches raw" 的触及定义。

## Impact

- 代码：`packages/dsh-shud-raw-guard/src/decide.ts`（规范化函数 + 大小写探测 + mention 判定）、`decide.test.ts`、新增 `case-probe.test.ts`。
- 规范：`openspec/specs/raw-data-guard/spec.md` 一条 Requirement。
- 运行时：bash 与 pwsh 共用判定，两者同时受益；`lib/decide.js` 由 build 产出。
