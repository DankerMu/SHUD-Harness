## MODIFIED Requirements

### Requirement: Decision audit
每条 `deny` 或 `ask` 决策 SHALL 经 `ctx.logger('shud-raw-guard')` 输出一行 `<decision> <tool id> <reason code>`；SHALL NOT 使用 `console.*`；SHALL NOT 包含工具参数、路径、raw 文件内容或环境变量值。插件 dispose 时 SHALL 输出累计决策计数（deny/ask 各一）。决策的 session log 证据为 dsh 既有事件：deny → `tool/result` isError 含 `reason`；ask → `approval/asked{toolName, reason}` + `approval/decided{outcome}`。在钉版 dsh-v0.2.1-rc.2 的默认成功启动路径中，该 facade 的 logger 行仅为埋点，没有运维可读出口，SHALL NOT 将 logger 收到记录或内存 buffer 视为可读、持久审计证据；运维决策证据以本段列出的 session log 事件为准。#378 采用仅记录此边界的方案，不新增通用日志出口。

#### Scenario: deny is audited
- **WHEN** 一次 `write` 被 deny
- **THEN** logger 收到一行以 `deny write` 开头的记录，记录中不含 `file_path` 的值

#### Scenario: dispose reports counts
- **WHEN** 发生 2 次 deny、1 次 ask 后触发 dispose
- **THEN** logger 收到含 `deny=2` 与 `ask=1` 的一行
