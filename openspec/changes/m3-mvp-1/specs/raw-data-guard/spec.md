# Spec Delta

## MODIFIED Requirements

### Requirement: shud_run is guarded
对 `shud_run` 工具，策略门 SHALL 用 session cwd（`shud_run` 没有 `workdir` 参数）与 `arguments.input_dir`（相对路径按 session cwd 解析）判定，路径解析与「Raw directory configuration」相同（realpath 与最近存在祖先）。所有提交写入根 SHALL 纳入判定：`<session cwd>/runs`、`<session cwd>/stacks`、`<session cwd>/provenance`；运行与证据 id 尚未分配时，SHALL 以各根最近存在祖先的 realpath 拼接余段解析（根已存在时使用其 realpath，含符号链接；否则使用 session cwd 的 realpath）。任一写入根位于任一 raw 目录内或等于它时 SHALL 返回 `deny`，`code` 为 `raw-immutable`，`reason` 含 `immutable`，SHALL NOT 提供写审批路径；否则 `input_dir` 位于任一 raw 目录内或等于它时 SHALL 返回 `ask`，`reason` 为 provenance 文案常量；两者都不触及 raw 时 SHALL 委托下一个监听器。`input_dir` 缺失或不是字符串时 SHALL 只按三个写入根判定，SHALL NOT 抛错。输出拒绝 SHALL 先于输入读取审批，不依赖 rawDirs 的顺序；每条决策照常经「Decision audit」记录。M3 仅扩展既有 raw-guard 决策，不在 jobs/records 中复制 raw 策略。

#### Scenario: input under raw asks
- **WHEN** 配置 `rawDirs: ["prot"]`，session cwd 为工作区根，调用 `shud_run`，`input_dir` 为 `prot/ccw`，三个写入根均在 raw 之外
- **THEN** 决策 `kind` 为 `ask`，`reason` 等于 provenance 常量

#### Scenario: session cwd under raw denied
- **WHEN** 配置 rawDirs 包含工作区 prot 的绝对路径，session cwd 为该 prot/sub，input_dir 为 raw 外的 /tmp/ccw
- **THEN** 决策 `kind` 为 `deny`，`code` 为 `raw-immutable`

#### Scenario: symlinked runs into raw denied
- **WHEN** 配置 rawDirs 为 prot，工作区 runs 为指向 prot/out 的符号链接，input_dir 为 input/ccw
- **THEN** 决策 `kind` 为 `deny`，`code` 为 `raw-immutable`

#### Scenario: raw is the runs directory
- **WHEN** 配置 `rawDirs: ["runs"]`，该目录尚不存在，input_dir 为 input/ccw
- **THEN** 决策 `kind` 为 `deny`

#### Scenario: unrelated paths pass through
- **WHEN** 配置 rawDirs 为 prot，input_dir 为 input/ccw，三个写入根均不在 raw 内
- **THEN** 不作判定，返回 next 的结果

#### Scenario: symlinked input into raw
- **WHEN** input_dir 为工作区内指向 prot/ccw 的符号链接，三个写入根均在 raw 之外
- **THEN** 决策 `kind` 为 `ask`

#### Scenario: capture roots configured as raw are immutable
- **WHEN** rawDirs 配置为 stacks 或 provenance，分别覆盖该写入根已存在与尚不存在的情形，调用真实注册的 shud_run
- **THEN** 工具在执行前被拒绝，不请求审批、不调用 producer，不创建运行目录、证据文件或索引条目，已有受保护内容不变

#### Scenario: capture-root aliases retain raw containment
- **WHEN** 已存在的 stacks 或 provenance 写入根经符号链接或本机大小写别名指向配置的 raw 根，或 session cwd 使用符号链接别名
- **THEN** 仍为 raw-immutable deny；兄弟前缀 stacks-input 或 provenance-input 不被当作同一写入根

#### Scenario: capture write denial precedes raw input approval
- **WHEN** 一个 rawDir 覆盖输入，另一个覆盖 stacks 或 provenance，或 input_dir 缺失/类型错误
- **THEN** 只要写入根受保护就 deny，不因输入审批或参数错误跳过输出保护；rawDirs 顺序不改变结果
