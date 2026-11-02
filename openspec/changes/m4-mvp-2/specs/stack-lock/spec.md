# Spec Delta

## MODIFIED Requirements

### Requirement: Stack fingerprint
`computeStackFingerprint(lock)` SHALL 返回 `sha256:` 加 64 位小写十六进制：对 lock 去掉 `stack_id`、`created_at`、`fingerprint` 与 `llm.response_model` 后的内容，在每一层按键名排序、无空白地序列化为 JSON，取其 UTF-8 字节的 SHA-256。`llm.response_model` 按 K4 只记录、不使 lock 失效，因此在排除集内。`build_id` 为 `null` 时 SHALL 一并从被哈希的内容中去掉，使指纹算法与输入与 M3 逐字节相同（M3 写入、按 `null` 解析的 lock 与本次无 build 采集的指纹仍可相等）；`build_id` 非 `null` 时 SHALL 保留在被哈希的内容中。指纹 SHALL 只由该内容决定：`stack_id`、`created_at`、`fingerprint`、`llm.response_model` 的值，`build_id` 键是缺失还是为 `null`，以及键的先后顺序 SHALL NOT 影响结果；内容中任一值变化（含 `repos.<name>.dirty_paths`、`dirty_paths_truncated`，以及 `build_id` 由 `null` 变为某个 id 或在两个 id 之间变化）SHALL 改变结果。

#### Scenario: clean to dirty changes the fingerprint
- **WHEN** 两个 lock 仅有一个 repo 的 `dirty` 分别为 `false` 与 `true`（`dirty_paths` 相应为空与非空）
- **THEN** 两者指纹不同

#### Scenario: dirty_paths change alters the fingerprint
- **WHEN** 两个 lock 的某个 repo 均为 `dirty: true`，仅 `dirty_paths` 分别为 `["a.txt"]` 与 `["b.txt"]`
- **THEN** 两者指纹不同

#### Scenario: build_id change alters the fingerprint
- **WHEN** 两个 lock 仅 `build_id` 不同（`null` 与 `"BUILD-20261102T080000-3f9c"`，或两个不同的 `BUILD-…` id）
- **THEN** 两者指纹不同

#### Scenario: null build_id keeps the M3 fingerprint
- **WHEN** 对同一份内容分别以 `build_id: null` 与不含 `build_id` 键（M3 形态）计算指纹
- **THEN** 两者指纹相同，且等于 M3 算法对该内容（不含 `build_id`）算出的值

#### Scenario: response model does not affect the fingerprint
- **WHEN** 两个 lock 仅 `llm.response_model` 不同
- **THEN** 两者指纹相同

#### Scenario: identity, time and key order do not matter
- **WHEN** 两个 lock 内容相同，仅 `stack_id`、`created_at`、`fingerprint` 的值或键顺序（含嵌套对象）不同
- **THEN** 两者指纹相同

#### Scenario: algorithm is pinned by a fixed vector
- **WHEN** 对测试中写死的一份符合当前 `StackLockSchema`、`build_id` 为 `null` 的 lock，以及同一内容但 `build_id` 为某个 `BUILD-…` id 的 lock 分别计算指纹
- **THEN** 前者等于测试中写死的、由 `shasum -a 256` 对其规范 JSON（已去掉排除集字段与 `build_id`）独立算出的值（与 M3 固定向量相同）；后者等于对保留 `build_id` 的规范 JSON 独立算出的值

### Requirement: StackLock schema alignment
`StackLockSchema` SHALL 为严格对象，恰含 `stack_id`、`repos`、`runtime`、`harness`、`llm`、`build_id`、`fingerprint`、`created_at`。`stack_id` SHALL 为品牌类型 `StackId`，格式 `STACK-YYYYMMDDTHHMMSS-xxxx`（UTC、精确到秒，`xxxx` 为 4 位小写十六进制），与 RunJob/RunRecord id 同一生成规则；旧格式 `STACK-0001`、`STACK-<UUID>` 与大写十六进制 SHALL 被拒绝。`build_id` SHALL 为品牌类型 `BuildId`（格式 `BUILD-YYYYMMDDTHHMMSS-xxxx`，同一生成规则）或 `null`；输入缺少该键时（M3 写入的 lock）SHALL 按 `null` 解析，读取 SHALL NOT 改写该文件。`llm` SHALL 恰为 `{ base_url, request_alias, response_model }` 三个非空字符串。`runtime` SHALL 恰为 `{ os, sundials_version, host_version }`：`os`、`host_version` 为非空字符串，`sundials_version` 为非空字符串或 `null`。`harness` SHALL 恰为 `{ version }`（非空字符串）。原 `llm.provider`、`llm.model_id`、`llm.params_digest`、`llm.prompt_pack_digest`，原 `runtime.r_version`、`runtime.r_packages_lock`、`runtime.python_version`、`runtime.gcc_version`、`runtime.gdal_version`，以及原 `harness.cli_version`、`harness.prompt_pack`、`harness.skills_version` SHALL 作为多余字段被拒绝，不以 nullable 形式保留。

#### Scenario: aligned lock parses
- **WHEN** 解析 `stack_id: "STACK-20261027T080000-3f9a"`、三 repo 完整、`runtime: { os: "Darwin 25.6.0", sundials_version: null, host_version: "0.2.1-rc.2" }`、`harness: { version: "0.9.0" }`、`llm: { base_url: "https://www.dmxapi.cn", request_alias: "deepseek-flash-guan", response_model: "deepseek-flash-guan" }`、`build_id: null` 的 StackLock
- **THEN** 解析成功

#### Scenario: lock referencing a build parses
- **WHEN** 其它方面同上，`build_id: "BUILD-20261102T080000-3f9c"`
- **THEN** 解析成功

#### Scenario: M3 lock without build_id stays readable
- **WHEN** 解析一个 M3 写入的、不含 `build_id` 键而其它方面合法的 StackLock
- **THEN** 解析成功，`build_id` 在解析结果中为 `null`，文件字节与修改时间不变

#### Scenario: malformed build_id rejected
- **WHEN** 以 `build_id: "BUILD-0001"`、`"BUILD-20261102T080000-3F9C"`（大写十六进制）或 `"RUN-20261102T080000-3f9c"` 解析 StackLock
- **THEN** 解析失败并指出 `build_id`

#### Scenario: legacy stack ids rejected
- **WHEN** 以 `stack_id: "STACK-0001"`、`"STACK-0b6f4c2e-1d2a-4e5f-9a8b-7c6d5e4f3a2b"` 或 `"STACK-20261027T080000-3F9A"` 解析 StackLock
- **THEN** 解析失败并指出 `stack_id`

#### Scenario: legacy llm, runtime and harness fields rejected
- **WHEN** 在其它方面合法的 StackLock 上分别加入 `llm.model_id`、`runtime.r_version` 或 `harness.cli_version`
- **THEN** 每一种情形解析均失败

#### Scenario: missing llm field rejected
- **WHEN** StackLock 的 `llm` 缺 `request_alias`，或 `response_model` 为空字符串
- **THEN** 解析失败并指出对应 `llm` 字段

### Requirement: Deterministic capture at shud_run submission
每次 `shud_run` 提交 SHALL 在输入复制完成之后、`run-job.json` 首次写入之前确定性地采集 StackLock，不经 LLM：`repos.{SHUD,rSHUD,AutoSHUD}` 为对 `shud-jobs` 行配置 `stackRepos.{SHUD,rSHUD,AutoSHUD}`（绝对路径）逐一执行「Read-only repository revision collection」的结果；`runtime.os` 为 `os.type()` 加一个空格加 `os.release()`；`runtime.sundials_version` 为 `shud-jobs` 行可选配置 `sundialsRoot` 下 `include/sundials/sundials_config.h` 中 `SUNDIALS_VERSION` 的值，未配置 `sundialsRoot` 或该文件不存在时为 `null`；`runtime.host_version` 为 `shud-jobs` 行配置 `hostVersion`；`harness.version` 为本仓库根 `package.json` 的 `version`；`llm.base_url`、`llm.request_alias` 为 `shud-jobs` 行配置 `llm.base_url`、`llm.request_alias`；`llm.response_model` 为本次 `shud_run` 记入 RunJob `llm.response_model` 的同一已配置模型 id（`response_model_source` 不进 StackLock）；`build_id` 为 `null`。`stackRepos` 的三个键、`hostVersion`、`llm.base_url`、`llm.request_alias` 是 `shud-jobs` 行的必填配置，缺失或为空时该行 apply SHALL 失败并指明配置键，SHALL NOT 回退默认值。

本次提交提供 `build_id` 时（BuildRecord 的解析与二进制校验见 shud-run-jobs，在输入复制之后、StackLock 采集之前完成），采集 SHALL 只改变以下两处，其余字段与无 build 时相同：`build_id` 为该 id；`repos.SHUD` 取自该 BuildRecord 的构建源，即 `{ commit: source_commit, branch: source_branch, dirty: dirty_paths 非空, dirty_paths: BuildRecord 的 dirty_paths（构建时观测的 dirty 列表）, dirty_paths_truncated: false }`，SHALL NOT 再采集 `stackRepos.SHUD`；`repos.rSHUD`、`repos.AutoSHUD` 仍按上段采集。由此得到的 lock SHALL 通过 `StackLockSchema`，否则本次采集失败。未提供 `build_id` 时采集结果除 `build_id: null` 外 SHALL 与 M3 逐字段相同。

采集结果 SHALL 按「Stack fingerprint」计算指纹，并与会话 cwd 下 `stacks/` 中已有的 StackLock 文件比较：存在指纹相等的文件时 SHALL 复用其 `stack_id`，SHALL NOT 改写该文件（因此其中记录的 `llm.response_model` 可能与本次调用的已配置模型 id 不同）；指纹相等的文件不止一份（如两次并发的首次提交各写了一份）时 SHALL 复用 `stack_id` 码点序最小的那一份，其余文件保留不动、仍然有效。不存在时 SHALL 分配新 `stack_id` 并以排他创建（`wx` 标志）写入 `<session cwd>/stacks/<stack_id>.json`——lock 只新建、从不改写，排他创建即其不覆盖保证；创建以 `EEXIST` 失败时 SHALL 重新分配 `stack_id` 再试，连同首次至多 3 次，3 次均 `EEXIST` 时 SHALL 以指明 `stacks/` 冲突的错误使本次采集失败，SHALL NOT 覆盖已有文件。`stacks/` 目录与其中文件的路径安全遵循 task-cards「TaskCard workspace file」的工作区文件安全规则。读取 `stacks/` 中的已有文件 SHALL 经 `StackLockSchema` 校验，校验失败或不可读的文件 SHALL 使本次采集失败，SHALL NOT 改写或跳过该文件。任一 repo 路径不是 git 仓库（含未初始化的 submodule 空目录）、采集抛错或 StackLock 写入失败时，`shud_run` SHALL 返回说明原因的工具错误、SHALL NOT 提交作业，并 SHALL NOT 留下运行目录；SHALL NOT 以 `null` 或占位值代替无法采集的仓库版本。采集得到的 `stack_id` SHALL 写入同一次提交的 RunJob（见 run-records）。

#### Scenario: first submission writes a new lock
- **WHEN** 会话 cwd 下没有 `stacks/` 目录，三个 `stackRepos` 均为干净的 git 仓库，不传 `build_id` 提交一次 `shud_run`
- **THEN** 出现唯一文件 `stacks/<stack_id>.json`，其内容通过 `StackLockSchema`，`build_id` 为 `null`，`llm.request_alias` 等于 `shud-jobs` 行 `llm.request_alias`，`run-job.json` 的 `stack_id` 等于该 `stack_id`

#### Scenario: unchanged environment reuses the lock
- **WHEN** 环境不变时再提交一次 `shud_run`（两次均不传 `build_id`，或两次传同一 `build_id`）
- **THEN** `stacks/` 中文件数量不变，已有文件字节与修改时间不变，新 `run-job.json` 的 `stack_id` 与前一次相同

#### Scenario: M3 lock is still reused
- **WHEN** `stacks/` 中有一份 M3 写入、不含 `build_id` 键的 lock，环境与其记录一致，不传 `build_id` 提交 `shud_run`
- **THEN** 新 `run-job.json` 的 `stack_id` 为该 M3 lock 的 `stack_id`，`stacks/` 不新增文件，该文件字节与修改时间不变

#### Scenario: environment change produces a new lock
- **WHEN** 在某个 `stackRepos` 仓库中新建一个未被忽略的文件后再提交 `shud_run`
- **THEN** `stacks/` 中新增一个文件，其该 repo 的 `dirty` 为 `true` 且 `dirty_paths` 含该文件，新 `run-job.json` 的 `stack_id` 指向新文件

#### Scenario: base build records its clean source
- **WHEN** 以一个 `change_id: null`、`source_commit` 为 `9a422e5…`（完整 id）、`dirty_paths: []` 的 BuildRecord 的 `build_id` 提交 `shud_run`
- **THEN** 新 lock 的 `build_id` 为该 id，`repos.SHUD` 为 `{ commit: <source_commit>, branch: <source_branch>, dirty: false, dirty_paths: [], dirty_paths_truncated: false }`，`repos.rSHUD`、`repos.AutoSHUD` 与不传 `build_id` 时的采集结果相同

#### Scenario: candidate build records its dirty paths
- **WHEN** 以一个关联已批 ChangeRequest、`dirty_paths` 为 `["Makefile", "src/Model/MD_rhs_core.cpp"]` 的 BuildRecord 的 `build_id` 提交 `shud_run`
- **THEN** 新 lock 的 `repos.SHUD` 为 `dirty: true`、`dirty_paths: ["Makefile", "src/Model/MD_rhs_core.cpp"]`、`dirty_paths_truncated: false`

#### Scenario: base and candidate runs get distinct locks
- **WHEN** 同一工作区先以 base 构建的 `build_id`、再以 candidate 构建的 `build_id` 各提交一次 `shud_run`
- **THEN** `stacks/` 中新增两个 lock，二者 `build_id` 互异、指纹互异，两个 `run-job.json` 的 `stack_id` 分别指向它们

#### Scenario: build reference still collects other repositories
- **WHEN** 提供 `build_id` 提交 `shud_run`，而 `stackRepos.rSHUD` 指向一个未初始化 submodule 的空目录
- **THEN** 工具返回指明该路径的错误，不提交作业，不留下运行目录，`stacks/` 不新增文件

#### Scenario: no build keeps the M3 capture
- **WHEN** 不传 `build_id` 提交 `shud_run`
- **THEN** `repos.SHUD` 为对 `stackRepos.SHUD` 执行仓库修订采集的结果，lock 除 `build_id: null` 外与 M3 的采集规则逐字段一致

#### Scenario: fingerprint-equal duplicates reuse the smallest id
- **WHEN** `stacks/` 中有两份指纹与本次环境相等的 lock，`stack_id` 分别为 `STACK-20261027T080001-b000` 与 `STACK-20261027T080001-a000`，提交一次 `shud_run`
- **THEN** 新 `run-job.json` 的 `stack_id` 为 `STACK-20261027T080001-a000`，两份文件的字节与修改时间均不变，`stacks/` 不新增文件

#### Scenario: id collision on create is retried
- **WHEN** 新分配的 `stack_id` 对应的文件在排他创建时已存在（`EEXIST`），而重新分配的第二个 id 不冲突
- **THEN** 采集以第二个 id 写入新 lock 并成功，已存在的那份文件字节不变

#### Scenario: repeated collisions fail the capture
- **WHEN** 连续 3 次分配的 `stack_id` 排他创建均以 `EEXIST` 失败
- **THEN** `shud_run` 返回指明 `stacks/` 冲突的工具错误，不提交作业、不留下运行目录，已有文件字节不变

#### Scenario: sundials version is optional
- **WHEN** `shud-jobs` 行未配置 `sundialsRoot`，或其下没有 `include/sundials/sundials_config.h`
- **THEN** 采集成功，`runtime.sundials_version` 为 `null`

#### Scenario: uninitialized submodule fails the submission
- **WHEN** `stackRepos.rSHUD` 指向一个未初始化 submodule 的空目录时调用 `shud_run`
- **THEN** 工具返回错误结果并指明该路径，不提交作业，`runs/` 下没有新运行目录，`stacks/` 不新增文件

#### Scenario: corrupt existing lock fails closed
- **WHEN** `stacks/` 中有一个不能通过 `StackLockSchema` 的文件时调用 `shud_run`
- **THEN** 工具返回错误结果，不提交作业、不留下运行目录，该文件字节不变

#### Scenario: missing capture configuration fails apply
- **WHEN** 以缺少 `hostVersion` 或 `stackRepos.SHUD` 的配置 apply `shud-jobs` 行
- **THEN** apply 抛错且错误消息含该配置键，注册表不注册

### Requirement: StackLock generated projection
StackLock 的 Zod schema SHALL 位于 `packages/dsh-shud-core/src/schemas/`，经 `pnpm run schema:generate` 投影到 `docs/generated/schema/stack-lock.md` 与 `docs/generated/json-schema/stack-lock.json`；`pnpm run schema:check` SHALL 在二者不一致时失败。`docs/03_SPEC/Minimal_Schemas.md` 的 StackLock 段 SHALL 与本 spec 一致，并逐项写明相对原文的处置：`stack_id` 改为 `STACK-YYYYMMDDTHHMMSS-xxxx`；`llm` 收窄为 `base_url`/`request_alias`/`response_model`，`response_model` 排除出指纹；`repos.<name>` 新增 `dirty_paths` 与 `dirty_paths_truncated`；`runtime` 最小化为 `os`/`sundials_version`/`host_version`，删除 `r_version`、`r_packages_lock`、`python_version`、`gcc_version`、`gdal_version`；`harness` 只保留 `version`，删除 `cli_version`、`prompt_pack`、`skills_version`；新增 nullable `build_id`（品牌 `BuildId`，仅在非 `null` 时进入指纹，`null` 时指纹与 M3 相同；引用 build 时 `repos.SHUD` 记构建源；M3 lock 缺该键按 `null` 解析）。

#### Scenario: projection reflects the aligned schema
- **WHEN** 执行 `pnpm run schema:generate`
- **THEN** `docs/generated/json-schema/stack-lock.json` 的 `llm` 属性恰为 `base_url`、`request_alias`、`response_model`，`runtime` 属性恰为 `os`、`sundials_version`、`host_version`，repo 修订对象含 `dirty_paths` 与 `dirty_paths_truncated`，顶层含 `build_id` 且其模式拒绝 `BUILD-0001`、接受 `null`

#### Scenario: drift detected
- **WHEN** 修改 StackLock 的 Zod 字段而未重新生成
- **THEN** `pnpm run schema:check` 以非 0 退出
