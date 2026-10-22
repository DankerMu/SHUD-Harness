# Proposal

## Why

#279：raw-guard 的写判定只看原始命令文本（`packages/dsh-shud-raw-guard/src/decide.ts` 第一遍循环 `WRITE_VERBS.test(checked)`），而 mention 判定自 #260 起已经看去引号副本。所以动词中段被引号或转义拆开（`r"m" -rf <raw>`、`r\m`、`m"v"`、`c\p`）时，命令被判为「触及 raw 但不写」，落 `ask`；tar 解包选项不在 `tar` 后第一个参数（`tar -C <raw> -xf a.tar`、`--extract`、`--get`、旧式 `tar xf`）时同样落 `ask`。审批卡显示「读取原始数据，是否批准？」，PI 批准的实际是删除或覆盖 raw（bash 实测 `r"m" -rf v1` 删除 `v1`，`tar -C v3 -xf` 覆盖 `v3/f`）。这是 #245 问题 B（破坏性命令被降级为 ask、审批卡写着读取）的同类缺陷。dev/probe 形态下 raw 在 workspace 内，没有沙箱兜底。#273 的祖先判定同样只看原文，`r"m" -rf <祖先>` 落 next。属 Critical Paths #1/#2。

## What Changes

- `decide.ts`：
  - 写判定对原文和去引号副本取 OR（原文仍在候选中，只会新增 deny）；
  - 新增 tar 解包检测：同一命令段内（重定向里的 `&` 不分段）`tar`/`gtar` 之后任意位置的含小写 `x` 的短选项簇、`--extract`/`--get` 及其缩写，或旧式首个选项簇含 `x`；`x` 区分大小写（`-X` 是 exclude-from）；按段从第一个 `tar` 扫描，保持线性；
  - 祖先判定的 POSIX 破坏性动词同样对去引号副本取 OR；
  - 去引号操作提为 `unquote`，`texts` 构造改为调用它（行为不变）。
- 测试：issue 验收表、大小写行、资源行放在新文件 `decide-spelling.test.ts`（`decide.test.ts` 接近 1000 行上限）；祖先行加在 `decide.test.ts` 的 `ancestorCases`。
- 规范 `raw-data-guard`：MODIFIED "Shell write under raw is denied"（去引号副本、tar 解包位置规则与大小写、已接受误报，5 个场景）与 "Shell write to a raw ancestor is denied"（破坏性动词也对去引号副本判定，1 个场景）。

备选（issue 列出）：把拆分动词与非首位 tar 解包登记为已记录漏报，并把 ASK 审批卡文案改为中性。dev/probe 形态仍无兜底，且改审批卡文案牵动探针与手工验收（Critical Path #3/#6），不取。

## Triage

Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent（issue-scribe，Readiness implementation-ready）；触发词：策略门决策与 raw 保护（Critical Paths #1/#2）、ask→deny 收紧
Blast radius: 去引号副本让读命令的引号文本拼出写动词，判 deny（误报方向，需写明并钉住）；tar `x` 若不区分大小写，`-X excl` 读命令被误判；tar 检测若用跨段或回溯正则，长命令退化为平方复杂度；探针 T1–T5 必须不变
Selected risk packs: Public API / CLI / script entry; File IO / path safety; Auth / permissions / secrets; Legacy compatibility; Documentation / migration notes; Resource limits
Evidence floor: 新增 deny 行先红后绿，ask/next 钉住行改前改后都绿；既有全部行不变；30 项突变；`pnpm run check`；`pnpm run raw-guard:probes` 两次 T1–T5 PASS、md5 不变

## Capabilities

### Modified Capabilities

- `raw-data-guard`: "Shell write under raw is denied"、"Shell write to a raw ancestor is denied"。

## Impact

- 代码：`packages/dsh-shud-raw-guard/src/decide.ts`（约 25 行）、`decide.test.ts`、`decide-spelling.test.ts`（新）。
- 规范：`openspec/specs/raw-data-guard/spec.md` 两条 Requirement。
- 运行时：`lib/decide.js` 由 `pnpm run build` 产出；探针不改。
