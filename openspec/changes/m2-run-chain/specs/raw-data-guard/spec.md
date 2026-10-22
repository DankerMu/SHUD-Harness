## ADDED Requirements

### Requirement: shud_run is guarded
对 `shud_run` 工具，策略门 SHALL 用调用的有效工作目录（`arguments.workdir` 不存在时取 session cwd）与 `arguments.input_dir`（相对路径按有效工作目录解析）判定，路径解析与「Raw directory configuration」相同（realpath 与最近存在祖先）：有效工作目录位于任一 raw 目录内或等于它时（运行目录 `runs/` 会写进 raw）SHALL 返回 `deny`，`code` 为 `raw-immutable`，`reason` 含 `immutable`；否则 `input_dir` 位于任一 raw 目录内或等于它时 SHALL 返回 `ask`，`reason` 为 provenance 文案常量；两者都不触及 raw 时 SHALL 委托下一个监听器。`input_dir` 缺失或不是字符串时 SHALL 只按有效工作目录判定，SHALL NOT 抛错。每条决策照常经「Decision audit」记录。

#### Scenario: input under raw asks
- **WHEN** 配置 `rawDirs: ["prot"]`，在工作区根调用 `shud_run`，`input_dir` 为 `prot/ccw`
- **THEN** 决策 `kind` 为 `ask`，`reason` 等于 provenance 常量

#### Scenario: workdir under raw denied
- **WHEN** 配置 `rawDirs: ["prot"]`，有效工作目录为 `prot/sub`，`input_dir` 为工作区外的 `/tmp/ccw`
- **THEN** 决策 `kind` 为 `deny`，`code` 为 `raw-immutable`

#### Scenario: unrelated paths pass through
- **WHEN** 配置 `rawDirs: ["prot"]`，在工作区根调用 `shud_run`，`input_dir` 为 `input/ccw`
- **THEN** 不作判定，返回 `next()` 的结果

#### Scenario: symlinked input into raw
- **WHEN** `input_dir` 为工作区内指向 `prot/ccw` 的符号链接
- **THEN** 决策 `kind` 为 `ask`
