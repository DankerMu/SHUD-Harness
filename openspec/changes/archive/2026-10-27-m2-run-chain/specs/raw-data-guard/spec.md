## ADDED Requirements

### Requirement: shud_run is guarded
对 `shud_run` 工具，策略门 SHALL 用 session cwd（`shud_run` 没有 `workdir` 参数）与 `arguments.input_dir`（相对路径按 session cwd 解析）判定，路径解析与「Raw directory configuration」相同（realpath 与最近存在祖先）。运行目录目标为 `<session cwd>/runs/<run_id>`：判定时 `run_id` 尚未分配，SHALL 以其最近存在祖先的 realpath 拼接余段解析（`runs/` 存在时即 `runs/` 的 realpath，含其为符号链接的情形；否则为 session cwd 的 realpath）。该目标位于任一 raw 目录内或等于它时 SHALL 返回 `deny`，`code` 为 `raw-immutable`，`reason` 含 `immutable`；否则 `input_dir` 位于任一 raw 目录内或等于它时 SHALL 返回 `ask`，`reason` 为 provenance 文案常量；两者都不触及 raw 时 SHALL 委托下一个监听器。`input_dir` 缺失或不是字符串时 SHALL 只按运行目录目标判定，SHALL NOT 抛错。每条决策照常经「Decision audit」记录。

#### Scenario: input under raw asks
- **WHEN** 配置 `rawDirs: ["prot"]`，session cwd 为工作区根，调用 `shud_run`，`input_dir` 为 `prot/ccw`
- **THEN** 决策 `kind` 为 `ask`，`reason` 等于 provenance 常量

#### Scenario: session cwd under raw denied
- **WHEN** 配置 `rawDirs` 包含工作区 `prot` 的绝对路径，session cwd 为该 `prot/sub`，`input_dir` 为 raw 外的 `/tmp/ccw`（相对 raw 配置仍按当前 session cwd 解析，不锚定另一个工作区）
- **THEN** 决策 `kind` 为 `deny`，`code` 为 `raw-immutable`

#### Scenario: symlinked runs into raw denied
- **WHEN** 配置 `rawDirs: ["prot"]`，session cwd 为工作区根，其下 `runs` 是指向 `prot/out` 的符号链接，`input_dir` 为 `input/ccw`
- **THEN** 决策 `kind` 为 `deny`，`code` 为 `raw-immutable`

#### Scenario: raw is the runs directory
- **WHEN** 配置 `rawDirs: ["runs"]`（目录尚不存在），session cwd 为工作区根，`input_dir` 为 `input/ccw`
- **THEN** 决策 `kind` 为 `deny`

#### Scenario: unrelated paths pass through
- **WHEN** 配置 `rawDirs: ["prot"]`，session cwd 为工作区根，调用 `shud_run`，`input_dir` 为 `input/ccw`
- **THEN** 不作判定，返回 `next()` 的结果

#### Scenario: symlinked input into raw
- **WHEN** `input_dir` 为工作区内指向 `prot/ccw` 的符号链接
- **THEN** 决策 `kind` 为 `ask`
