# Spec Delta

## MODIFIED Requirements

### Requirement: DataProvenance record
DataProvenance SHALL 含且只含：`data_id`（品牌 `DataId`）、`basin`（非空字符串，等于本次运行的 `project`）、`event_window`（`start` 与 `end` 的 schema 类型均为非空字符串或 null；M3 生成器按 design D6 均写 null，不推算窗口）、`sources`（`input_root` 为原始 `input_dir` 的绝对路径；`files` 为 `{path, sha256, size_bytes}` 列表，`path` 为相对于输入副本根的 POSIX 相对路径，`size_bytes` 为非负整数字节数；`external_files` 为 `{path, sha256, size_bytes}` 列表，`path` 为输入副本外 forcing 文件的规范绝对路径，`sha256` 与 `size_bytes` 语义与 `files` 相同）、`preprocess`（SHALL 为 `null`）、`uncertainty_notes`（SHALL 为 `null`）。`sources.external_files` 在解析结果中 SHALL 恒为数组：输入缺少该键时（M3 写入的记录）SHALL 按 `[]` 解析，读取 SHALL NOT 因此改写该文件。原 `sources.terrain`、`sources.mesh`、`sources.forcing`、`sources.observations` 分类 SHALL NOT 出现；未知字段 SHALL 使解析失败。

#### Scenario: valid minimal provenance
- **WHEN** 解析 `basin: "ccw"`、`event_window: {start: null, end: null}`、`preprocess: null`、`uncertainty_notes: null`、`sources.files` 含 `{path: "ccw.sp.mesh", sha256: …, size_bytes: 1024}`、`sources.external_files: []` 的 DataProvenance
- **THEN** 解析成功

#### Scenario: provenance with external files parses
- **WHEN** 解析 `sources.external_files` 含 `{path: "/data/keliya/forcing.trimmed/X82.45Y36.25.csv", sha256: …, size_bytes: 40960}` 的 DataProvenance
- **THEN** 解析成功

#### Scenario: M3 provenance without external files stays readable
- **WHEN** 解析一个 M3 写入的、`sources` 不含 `external_files` 键而其它方面合法的 DataProvenance
- **THEN** 解析成功，`sources.external_files` 在解析结果中为 `[]`，文件字节与修改时间不变

#### Scenario: legacy categories rejected
- **WHEN** 解析 `sources` 含 `terrain` 或 `observations` 键、或 `files` 中某项 `size_bytes` 为 `-1` 的 DataProvenance
- **THEN** schema 解析失败

#### Scenario: relative or malformed external file rejected
- **WHEN** 解析 `sources.external_files` 中某项 `path` 为相对路径 `forcing.trimmed/a.csv`、`size_bytes` 为 `-1`，或缺少 `sha256` 的 DataProvenance
- **THEN** schema 解析失败并指出 `sources.external_files` 中的对应字段

### Requirement: Provenance generation at submission
每次 `shud_run` 提交 SHALL 在输入复制完成之后、首次写入 `run-job.json` 之前生成一份新的 DataProvenance：遍历运行目录内 `input/<project>/` 副本中的全部普通文件，逐个计算 sha256 与字节数，`files` SHALL 按 POSIX 相对路径排序。

生成 SHALL 在遍历副本之后解析副本中的 `<project>.tsd.forc`，确定输入副本外被引用的 forcing 文件。`tsd.forc` 的格式 SHALL 按如下解析：第 1 行的首个整数为站点数；第 2 行为 forcing 目录；第 3 行为表头；其后的非空行为数据行，列以制表符或空白分隔，最后一列为 `Filename`；数据行数 SHALL 等于第 1 行的站点数，否则视为解析失败。forcing 目录为相对路径时 SHALL 按运行目录解析（SHUD 以运行目录为 cwd），为绝对路径时按原值；随后取其规范路径（realpath）。

`Filename` SHALL 允许路径型值；每个引用 SHALL 按 SHUD 的目录 + `/` + `Filename` 拼接语义逐项物理解析，保留 `..` 的实际遍历语义，不使用 rSHUD 的目录回退搜索、tilde 展开或将 `Filename` 前导 `/` 作为覆盖目录的规则。每个被经过的引用路径组件 SHALL 经过 `lstat` 检查，不得跟随符号链接（包括中间目录链接），最终引用 SHALL 是普通文件。forcing 目录本身仍按上段 realpath 规范化；目录别名不等于允许其后的引用组件绕过链接检查。

外部归类 SHALL 对每个引用的规范绝对文件路径与输入副本的规范根比较，而非仅判断 forcing 目录。位于输入副本内的引用由 `files` 覆盖，SHALL NOT 重复列入 `external_files`；位于副本外的引用 SHALL 计算 sha256 与实际字节数，按规范绝对路径去重并按码点升序写入 `external_files`。只有全部引用均位于副本内或引用集合为空时，`external_files` 才为 `[]`。目录中未被 `tsd.forc` 引用的文件 SHALL NOT 列入；重复引用不改变站点数按原始非空数据行计数的规则。

forcing 目录不存在、任一引用缺失或不是普通文件（含路径组件链接与特殊文件），或 `tsd.forc` 缺失或解析失败（含第 1 行无整数站点数、数据行数与站点数不等）时，`shud_run` SHALL 返回说明原因的工具错误，提交 SHALL 中止并经既有提交回滚移除运行目录与索引条目，SHALL NOT 降级为空或部分 `external_files`。这一检查同样适用于位于副本内的引用。生成 SHALL 只读访问 forcing 文件，SHALL NOT 写入、复制或修改外部文件，也 SHALL NOT 因外部 forcing 目录发起审批。

同一输入目录的多次提交 SHALL 各自生成新的 `data_id` 与文件。生成 SHALL 确定：相同的副本内容与相同的外部 forcing 文件内容产生相同的 `files` 与 `external_files` 列表。该过程 SHALL NOT 调用 LLM。

#### Scenario: provenance covers copied input
- **WHEN** 以 `SHUD/input/ccw` 提交 `shud_run`
- **THEN** `provenance/<data_id>.json` 的 `files` 恰好列出运行目录 `input/ccw/` 下每个普通文件一次，各项 `sha256` 与 `size_bytes` 等于对该副本文件独立计算的值，`path` 按字典序排列，`input_root` 为原始 `input_dir` 的绝对路径，`basin` 为 `ccw`

#### Scenario: forcing inside the copy yields no external files
- **WHEN** 以 `SHUD/input/ccw` 提交 `shud_run`，其 `ccw.tsd.forc` 第 2 行为 `./input/ccw/`
- **THEN** 每个实际引用的文件按运行目录解析后均位于输入副本内，`sources.external_files` 为 `[]`

#### Scenario: absolute external forcing directory is hashed
- **WHEN** 以回放工作区的 `input/keliya` 提交 `shud_run`，其 `keliya.tsd.forc` 第 2 行为工作区外 `forcing.trimmed/` 的绝对路径
- **THEN** `forcing.trimmed/` 目录共 34 项，`sources.external_files` 恰为 `keliya.tsd.forc` 32 个数据行引用的 32 个文件各一项，未被引用的 2 项（`Prcp_Correction.csv`、`Rawdata_CMFD_TS.png`）不出现；各项 `path` 为 `forcing.trimmed/` 规范路径拼接 `Filename` 的绝对路径并按码点升序排列，`sha256` 与 `size_bytes` 等于对该文件独立计算的值，该目录内文件字节与修改时间不变

#### Scenario: missing external forcing file aborts submission
- **WHEN** `tsd.forc` 第 2 行指向运行目录外的目录，而其表格引用的某个文件在该目录中不存在
- **THEN** `shud_run` 返回指出该文件的工具错误，`runs/` 下不留下本次运行目录，活动索引不含本次作业，`provenance/` 不新增文件

#### Scenario: missing external forcing directory aborts submission
- **WHEN** `tsd.forc` 第 2 行的绝对路径指向不存在的目录
- **THEN** `shud_run` 返回工具错误，不留下运行目录，`sources.external_files` 不以 `[]` 代替

#### Scenario: non-regular external file aborts submission
- **WHEN** 外部 forcing 目录中被引用的某个文件名是符号链接或目录
- **THEN** `shud_run` 返回工具错误，不留下运行目录，链接目标不被读取为 forcing 证据

#### Scenario: unparsable tsd.forc aborts submission
- **WHEN** 输入副本中缺少 `<project>.tsd.forc`，或该文件少于 3 行、第 2 行为空
- **THEN** `shud_run` 返回指出 `tsd.forc` 的工具错误，不留下运行目录

#### Scenario: station count mismatch aborts submission
- **WHEN** `tsd.forc` 第 1 行的站点数为 `32`，而表头之后的非空数据行只有 31 行（或第 1 行没有首个整数）
- **THEN** `shud_run` 返回指出 `tsd.forc` 解析失败的工具错误，不留下运行目录，`sources.external_files` 不以部分列表或 `[]` 代替

#### Scenario: repeated submission yields new provenance
- **WHEN** 以同一 `input_dir` 连续提交两次 `shud_run`
- **THEN** 产生两个不同的 `data_id` 与两份 `provenance/` 文件，二者 `files` 与 `external_files` 相同

#### Scenario: path-valued filename escapes an internal forcing directory
- **WHEN** forcing 目录位于输入副本内，但一个 `Filename` 经普通目录及 `..` 指向副本外的普通文件
- **THEN** 该文件以规范绝对路径、sha256 与字节数出现在 `external_files`，不能因 forcing 目录在副本内而遗漏

#### Scenario: external forcing directory references an internal copied file
- **WHEN** forcing 目录位于副本外，而一个路径型 `Filename` 实际解析到副本内的普通文件
- **THEN** 该引用由 `files` 覆盖，不重复写入 `external_files`

#### Scenario: nested ordinary references and canonical duplicates
- **WHEN** 表格引用嵌套普通目录中的文件，并以含 `.` 或 `..` 的另一条合法路径再次引用同一规范文件，站点数等于原始行数
- **THEN** 每个路径组件均通过检查，外部清单中该规范路径只出现一次，未引用文件不出现

#### Scenario: intermediate reference symlink is rejected
- **WHEN** `Filename` 的中间组件是指向其它目录的链接，包括其后带 `..` 的拼写
- **THEN** 生成拒绝该路径，不通过词法归一化跳过检查，不读取链接目标作为 forcing 证据，不发布 provenance

#### Scenario: missing internal forcing reference is not an empty external inventory
- **WHEN** forcing 目录位于副本内，但某个引用文件不存在
- **THEN** 生成指出该文件并失败，不以 `external_files: []` 冒充有效输入

### Requirement: DataProvenance generated projection
DataProvenance 的 Zod schema SHALL 位于 `packages/dsh-shud-core/src/schemas/` 并登记进 schema 生成注册表，经 `pnpm run schema:generate` 投影到 `docs/generated/`；`pnpm run schema:check` SHALL 在二者不一致时失败。`docs/03_SPEC/Minimal_Schemas.md` 的 DataProvenance 段 SHALL 与本 spec 一致，并写明处置：id 格式改为品牌格式；`sources` 分类改为 `input_root` + `files` + `external_files`（输入副本外被 `tsd.forc` 引用的 forcing 文件，规范绝对路径；M3 记录缺该键按 `[]` 解析）；`event_window` 两端、`preprocess`、`uncertainty_notes` 为 `null`。

#### Scenario: drift detected
- **WHEN** 修改 DataProvenance 的 Zod 字段而未重新生成
- **THEN** `pnpm run schema:check` 以非 0 退出

#### Scenario: projection regenerated
- **WHEN** 执行 `pnpm run schema:generate`
- **THEN** `docs/generated/` 下的 DataProvenance 投影含 `sources.input_root`、`sources.files` 与 `sources.external_files`，不含 `sources.terrain`
