# Proposal

## Why

#241：`raw-guard-probes.sh --judge` 对已保存运行目录重判时，`stream.jsonl` 与 `session.jsonl` 同为空（或仅空白）会让身份校验 `events[0]?.sessionId !== log[0]?.id` 在 `undefined === undefined` 上静默通过，T5 只看 `derived.txt` 存在，于是一份丢了会话证据的归档仍能整体判 PASS。同一 issue 的补充评论指出闸自证只有一份 `fail` 夹具且其 md5 已变，`judge()` 单靠 md5 项就返回 false——T1–T4 判据退化成永远 PASS 也测不出（`test-guardrails.sh:3` 自己定义的 phantom enforcement）。两者都让"证据即真相"的 M1 验收口径有漏洞。

## What Changes

- `scripts/runtime/raw-guard-probes.sh` 的 `judge()`：在任何探针判据之前加**最低证据完整性门**——`stream.jsonl` 首事件须为 `type: session` 且 `sessionId` 为非空合法字符串（复用 live 模式的 `/^session-[a-zA-Z0-9-]+$/`）；`session.jsonl` 首行须为 `type: session` 且 `id` 与之相等；`process.json` 须 exit 0 且无 signal/error。文件缺失、空、仅空白、首行不是 session、身份缺失或不一致 → 该探针 FAIL（`Incomplete probe`），不影响其它探针。T5 的"文件存在"业务判据不变。
- 夹具：保留 `pass/`、`fail/`（禁用插件真实红跑，md5 已变）；新增 `fail-empty-session/`（`pass` 副本，仅 T5 两份 JSONL 置空/纯空白，md5 不变）与 `fail-approval-granted/`（`pass` 副本，仅 T2 的 `approval/decided.outcome` 改为 `allowed-once`，md5 不变）。后者使自证在 md5 之外至少能分辨 T2 `outcome` 判据的退化；T1/T3/T4 的逐判据夹具不在本 change（Non-goals）。
- `scripts/guardrails/test-guardrails.sh`：新增两条 `expect_fail`；judge 模式输出断言"无总绿汇总行、有逐探针行"。
- 规范 `raw-data-guard` 的 "Probe criteria" 与 "Probe judge mode" 同步：完整性前置条件、夹具分类。
- 不改 live 采集路径、不改 T1–T5 业务判据、不改 raw-guard 插件、不把 `test-guardrails` 接入 CI（另议）。

## Triage

Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent（issue-scribe 产出；Readiness needs-triage，本 change 以"先完整性再判据"裁定规范意图）；触发词 script entry + file IO
Blast radius: 过严 → 真实绿跑被误判 FAIL（可由 `pass/` 夹具与一次 live 跑验证）；过松 → 维持现状漏洞
Selected risk packs: Public API / CLI / script entry; File IO / path safety; Legacy compatibility; Error handling; Documentation / migration notes
Evidence floor: `pnpm run test-guardrails` 含 4 条 raw-guard judge 用例全 PASS（pass 绿、三种 fail 红、无汇总行）；`pnpm run check`；`pnpm run raw-guard:probes` live 5/5 PASS

## Capabilities

### Modified Capabilities

- `raw-data-guard`: 探针判据的证据完整性前置条件；judge 夹具集。

## Impact

- 代码：`scripts/runtime/raw-guard-probes.sh`（`judge()` 内联 node）、`scripts/guardrails/test-guardrails.sh`、`scripts/runtime/fixtures/raw-guard-probes/{fail-empty-session,fail-approval-granted}/**`。
- 规范：`openspec/specs/raw-data-guard/spec.md` 两条 Requirement。
- 运行时：live 模式行为不变（live 本就在 `sessionLog()` 校验身份）。
