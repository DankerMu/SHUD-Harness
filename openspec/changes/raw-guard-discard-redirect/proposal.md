# Proposal

## Why

#248：`WRITE_VERBS` 的重定向子式 `(^|[^<])>{1,2}\s*[^&]` 只看 `>`/`>>` 后不是 `&` 就当写，不看目标。模型经常给只读命令加 `2>/dev/null`/`>/dev/null`，于是 `head <raw>/obs.csv 2>/dev/null` 落 `deny`（"Raw data is immutable"）而不是 `ask`——M1 承诺的"bash 读 raw 弹 PI 审批卡"流程被盖掉，PI 看不到卡，模型被引导改用 read 工具。规范 `raw-data-guard` "Shell read under raw asks for approval" 要求触及 raw 且无写动词 → `ask`；丢弃到 `/dev/null` 的重定向不写任何文件，不是写动词。方向是 fail-closed，不是安全漏洞，是不符合 spec 的可用性缺陷。

## What Changes

- `packages/dsh-shud-raw-guard/src/decide.ts`：在对命令文本跑 `WRITE_VERBS` 之前，先剥掉目标为 `/dev/null` 的丢弃型重定向（`>`、`>>`、`N>`、`N>>`、`&>`、`&>>`，目标后不能再跟路径名字符或 `/`；只剥 `&?>` 起的部分，不吞前导 fd 数字，`bzip2>/dev/null <raw>/x` 仍 deny），剩余文本照旧过 `WRITE_VERBS`。"提及 raw" 判定与 `PWSH_WRITES` 仍看原文。通用重定向子式不改。
- `decide.test.ts`：issue 期望表全部入表——`ask`：`head <raw>/obs.csv 2>/dev/null`、`ls <raw> >/dev/null`、`cat <raw>/x 2>/dev/null | wc -l`、`ls <raw> &>/dev/null`、`head <raw>/a 1>/dev/null 2>&1`、`head <raw>/a >>/dev/null`；`deny`：`echo bad >> <raw>/x`、`cat <raw>/x | sort > out.txt`、`cat <raw>/a 2>/dev/null > <raw>/b`、`head <raw>/a > /dev/nullx`、`head <raw>/a > /dev/null/x`、`head <raw>/a >/dev/null; rm <raw>/a`、`bzip2>/dev/null <raw>/x`；默认 `data/raw` 配置下 `echo bad >> data/raw/obs.csv` 仍 `deny`（探针 T3）。PR #246 全部既有行不变。
- 规范 `raw-data-guard` "Shell write under raw is denied"：`>`/`>>` 重定向条目加"丢弃型 `/dev/null` 重定向除外"，并澄清"raw 仅作为源的重定向也 deny"针对的是写到真实文件的重定向；加两个场景。

## Triage

Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent（issue-scribe 产出，Readiness implementation-ready）；触发词：策略门决策（Critical Paths #1/#2）、auth/permissions（deny→ask 方向变化）
Blast radius: 剥得过宽 → 真写被 `/dev/null` 掩盖（`2>/dev/null > <raw>/b` 必须仍 deny）；剥得过窄 → 误报留存；探针 T3（`>> data/raw/obs.csv`）必须仍 deny
Selected risk packs: Public API / CLI / script entry; File IO / path safety; Auth / permissions / secrets; Legacy compatibility; Documentation / migration notes
Evidence floor: `decide.test.ts` 新增 ask/deny 行先红后绿；`pnpm run check`；`pnpm run raw-guard:probes` T1–T5 PASS、md5 不变

## Capabilities

### Modified Capabilities

- `raw-data-guard`: "Shell write under raw is denied" 的重定向条款。

## Impact

- 代码：`packages/dsh-shud-raw-guard/src/decide.ts`（一处常量 + 一行替换）、`decide.test.ts`。
- 规范：`openspec/specs/raw-data-guard/spec.md` 一条 Requirement。
- 运行时：`lib/decide.js` 由 `pnpm run build` 产出；探针不改。
