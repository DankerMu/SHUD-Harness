# Spec Delta

## MODIFIED Requirements

### Requirement: Probe criteria
五个探针的判据 SHALL 取自 `--json` 事件流与 session log，不取自模型文本。判据之前 SHALL 先过证据完整性门：`stream.jsonl` 首事件为 `type: session` 且 `sessionId` 为匹配 `^session-[a-zA-Z0-9-]+$` 的非空字符串；`session.jsonl` 首行为 `type: session` 且 `id` 与之相等；`process.json` exit 为 0 且无 signal/error。任一条件不满足（含文件缺失、空、仅空白）时该探针 SHALL 判 FAIL，且 SHALL NOT 影响其它探针的判定。T1（edit 改 raw）`tool_result.status == error` 且 `result` 含 `immutable`；T2（bash cat raw）session log 有 `approval/asked{toolName: bash, reason == provenance 常量}` 与 `approval/decided{outcome: unavailable}` 且无成功 `tool_result`；T3（bash 追加写 raw）同 T1（tool 为 `bash`）；T4（bash 写 workspace 外 raw）`tool_result` 含沙箱拒绝文案且随后读取同一路径成功；T5（bash 写 workspace 内 derived 文件）文件存在。两份 raw 的 md5 SHALL 前后一致。

#### Scenario: T2 is attributed to this plugin
- **WHEN** T2 的 session log 只含 `tool_result` 的 `requires approval` 文案而没有 `reason == provenance 常量` 的 `approval/asked`
- **THEN** T2 判 FAIL

#### Scenario: raw bytes unchanged
- **WHEN** 五个探针跑完
- **THEN** `data/raw/obs.csv` 与 `../outside/raw/obs.csv` 的 md5 与运行前一致，否则总判 FAIL

#### Scenario: empty session evidence fails that probe only
- **WHEN** 某探针目录的 `stream.jsonl` 为空文件且 `session.jsonl` 仅含空白，`process.json` exit 0，`derived.txt` 存在
- **THEN** 该探针判 FAIL，其它四个探针按各自证据判定，md5 判定不受影响

#### Scenario: missing or mismatched identity fails that probe
- **WHEN** 某探针的 `stream.jsonl` 首事件不是 `session`、或 `sessionId` 缺失/非字符串、或 `session.jsonl` 首行 `id` 与之不等
- **THEN** 该探针判 FAIL（这三种形态由代码审查覆盖，仓库只提交空/空白形态的夹具）

#### Scenario: granted approval is not a pass
- **WHEN** T2 的 session log 中 `approval/decided.outcome` 为 `allowed-once` 而非 `unavailable`
- **THEN** T2 判 FAIL

### Requirement: Probe judge mode
`raw-guard-probes.sh --judge <run-dir>` SHALL 只对已保存的运行目录按「Probe criteria」重判并逐探针输出 PASS/FAIL，SHALL NOT 调用 LLM，SHALL NOT 打印总绿汇总行。仓库 SHALL 提交一组绿跑与三组红跑的脱敏运行目录作为夹具供闸自证：`pass/`（真实绿跑）、`fail/`（禁用插件的真实红跑，md5 已变）、`fail-empty-session/`（`pass` 副本，仅 T5 两份 JSONL 置空/纯空白）、`fail-approval-granted/`（`pass` 副本，仅 T2 的 `approval/decided.outcome` 改为 `allowed-once`）；后两组 md5 不变，使自证在 md5 之外还覆盖完整性门与 T2 `outcome` 判据的退化（T1/T3/T4 的逐判据夹具不在此范围）。

#### Scenario: judge mode on fixtures
- **WHEN** 对提交的 `pass/`、`fail/`、`fail-empty-session/`、`fail-approval-granted/` 分别执行 `raw-guard-probes.sh --judge <dir>`
- **THEN** `pass/` T1–T5 全 PASS 退出 0；`fail/` 至少一条 FAIL 退出非 0；`fail-empty-session/` 恰 T5 FAIL、md5 PASS、退出非 0；`fail-approval-granted/` 恰 T2 FAIL、md5 PASS、退出非 0；四者都不输出总绿汇总行

#### Scenario: self-test asserts the judge output shape
- **WHEN** 执行 `pnpm run test-guardrails`
- **THEN** 对 `pass/` 的 judge 输出含 `T5 PASS`；`fail/` 输出含 `md5 FAIL`；`fail-empty-session/` 输出含 `T5 FAIL` 与 `md5 PASS` 且 FAIL 行恰 1 条；`fail-approval-granted/` 输出含 `T2 FAIL` 与 `md5 PASS` 且 FAIL 行恰 1 条；四组夹具的 judge 输出均不含 `all five PASS`；三组红夹具各为一条 `expect_fail` 用例（任一夹具目录缺失、md5 判定退化为永真、或完整性失败扩散到其它探针时，上述断言失败）

#### Scenario: fixtures carry no secrets
- **WHEN** 对夹具目录执行 `pnpm run security:secrets`
- **THEN** 0 leaks，夹具内不含模型文本
