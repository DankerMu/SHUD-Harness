# stack-lock

StackLock schema 与采集服务：以 submodule gitlink 作路径/代际 authority，记录四个实际 checkout 的 commit/branch/detached/dirty、runtime 版本占位、renv.lock 内容哈希、llm 块（ADR-0002 D9 `base_url` 必锁）、整体 fingerprint、`POST /api/stacks/lock` 与 `GET /api/stacks/:stackId`。权威源：[Minimal_Schemas §2](../../../../../docs/03_SPEC/Minimal_Schemas.md)、[Workspace_Conventions §1.4](../../../../../docs/03_SPEC/Workspace_Conventions.md)、[Schemas_APIs_CLIs §1](../../../../../docs/04_IMPLEMENTATION/Schemas_APIs_CLIs.md)（含例外批次 6 读端点）、[Phase_By_Phase_Test_Plan W2](../../../../../docs/04_IMPLEMENTATION/Phase_By_Phase_Test_Plan.md)（W2-SUB-001）、[ADR-0002](../../../../../docs/adr/0002-mvp-reality-anchoring.md) D9。

## ADDED Requirements

### Requirement: StackLock Zod schema

core-schemas SHALL 新增 StackLock schema：`stack_id`（格式 `STACK-<uuid>`，design D5 记录的对 canonical NNNN 示意格式的偏离）、`repos`（SHUD/rSHUD/AutoSHUD/zero 四键，各含实际 checkout 的 commit + branch + required `detached: boolean` + required `dirty: boolean`——design D5a 与 D7a；canonical 补正走任务 4.1a/#132）、`runtime`（os/r_version/python_version/sundials_version/gcc_version/gdal_version 占位值或 `unknown`；`r_packages_lock` 为 `{ path, sha256 } | null`——design D5a）、`harness`（version/cli_version/prompt_pack/skills_version，M2 采集口径见下方 requirement）、`llm`（provider/model_id/**base_url**/params_digest/prompt_pack_digest，全部 required）、`fingerprint`（sha256）、`created_at`。废弃字段 `runtime.container`/`limits`/`policy_version` MUST NOT 出现。

#### Scenario: llm 块缺 base_url 被拒

- **WHEN** 以缺 `llm.base_url` 的输入构造 StackLock
- **THEN** schema 校验失败（D9：第三方端点必锁，缺失即拒绝）

#### Scenario: 正例通过且废弃字段被拒

- **WHEN** 以含四 repo 实际 commit/branch/detached/dirty、runtime 占位、完整 llm 块的输入校验
- **THEN** 通过；含 `runtime.container` 的输入按 strict 模式拒绝

#### Scenario: 四 repo dirty 字段逐项必填

- **WHEN** 分别从 SHUD、rSHUD、AutoSHUD 或 zero revision 删除 `dirty`，或将其替换为非 boolean
- **THEN** 每个变体均被 strict schema 拒绝；四项完整 boolean 输入通过

#### Scenario: detached discriminator required and unambiguous

- **WHEN** 任一 repo revision 缺 `detached`，或分别输入 attached branch `detached` 与 detached HEAD
- **THEN** 缺字段被 strict schema 拒绝；两态均保留 `branch="detached"` 并由 required boolean 形成不同 public value

### Requirement: 四 repo 实际 checkout 状态只读发现（W2-SUB-001）

采集服务 SHALL 在任何其他 producer 前把请求 `repositoryRoot` 物理规范化，以 no-follow directory observation 捕获其稳定 `(dev, ino)`，并使用相同最小非敏感 Git seam 执行 `git --no-lazy-fetch rev-parse --show-toplevel`；Git 报告 top-level 的物理规范路径 MUST 与请求根完全相等。pathname 与该目录对象身份 MUST 在 admission、每个 snapshot/producer 前后和 publication 前重验；同 pathname 被替换为不同目录对象 MUST 以 typed failure 拒绝且不得返回 partial result。nested directory 即使包含完整合法外观的 package/provider/`.gitmodules` 也必须在读取它们或执行 `ls-tree` 前以 typed failure 拒绝；真实 repository root 与 linked-worktree root 必须正常工作。采集服务随后 SHALL 以一个 bounded `git --no-lazy-fetch ls-tree -z --full-tree HEAD -- .gitmodules SHUD rSHUD AutoSHUD zero` inventory，把四个 gitlink commit 与 mode=`100644` 的 `.gitmodules` blob identity 绑定到同一个 superproject `HEAD` object generation；再以 fixed `git --no-lazy-fetch cat-file blob <exact-object-id>` 读取不超过 64 KiB 的精确 blob，解析 exact 四项声明（path 必须为 SHUD/rSHUD/AutoSHUD/zero；branch metadata 为 SHUD/rSHUD/AutoSHUD=`master`，zero=`development`）。这些声明只校验配置 generation，不是 `repos.*.branch` 的输出 authority。工作树 `.gitmodules`（包括 dirty 或 untracked bytes）MUST NOT 成为路径或 generation authority；missing/wrong-mode/oversized/malformed HEAD blob MUST typed fail。两次 cheap snapshot MUST 比较完整 authority identity（root path + `(dev, ino)`、四个 gitlink、`.gitmodules` object id、blob digest 与 declarations），不得把 schema 示例、gitlink 或声明 branch 冒充实际 checkout 状态。每个生产 Git command MUST 在 subcommand 前携带全局 `--no-lazy-fetch`；Git <2.45 不支持时 MUST 在首条 root-identity command fail closed，不得降级 dispatch `ls-tree`、`cat-file` 或 remote 操作。采集 MUST 使用最小非敏感 Git 子进程环境、禁用 lazy fetch/trace 写入，MUST NOT 修改任何 git 状态、联网抓取对象或执行 checkout/fetch/reset。现有 `renv.lock` SHALL 在已打开 regular-file descriptor 上执行 inclusive 16 MiB byte bound：恰好 16 MiB 成功，超限以 typed failure 拒绝且不返回 partial result。

四个 gitlink 与 `HEAD:.gitmodules` SHALL 仅作为 checkout 路径和采集代际 authority。每个 checkout admission MUST 先 no-follow 拒绝 symlink 再调用 realpath，并打开、持有 directory descriptor/cwd capability；capability 创建后 MUST 立即登记到 collection-scope owner，不得等外层 root postcondition 成功才取得 ownership。每个生产 Git command MUST 先在其已绑定 cwd 内核对 `(dev, ino)`，匹配后才运行，MUST NOT 重新解析原 checkout pathname 来选择 Git worktree。默认 runner MUST 在进入任一 repo cwd 前从 PATH 解析一次绝对 Git executable；PATH 的每个 component MUST 非空且为绝对路径，root 与 checkout 命令都 MUST 执行解析后的绝对 binary。cwd identity mismatch MUST 以专用 marker/remap 与 Git 自身同 exit code 失败区分。采集服务 MUST 对每个声明 checkout 读取实际 40-hex `HEAD`、实际 branch 与 required `detached`（detached HEAD = `branch="detached", detached=true`；attached 分支 `detached` = 同 branch 且 `detached=false`），以及覆盖 tracked + untracked + staged + nested submodule 的 `dirty`。dirty observation snapshot MUST 读取 main/linked/nested checkout 的 local、worktree-scope 与 include 后有效配置；Git boolean 采用大小写不敏感的 `true/yes/on/1` 与 `false/no/off/0`，valueless boolean 视为 true，invalid token typed fail。任何有效 `filter.*.clean` 或 `filter.*.process` MUST 在 observer 前 typed fail。snapshot MUST 身份稳定、bounded 地冻结 standalone/split index 及其 `sharedindex.<sha>` companion、正确的 index 时间戳、common `info/exclude`/`info/attributes`、local `core.excludesFile`/`core.attributesFile`、`core.autocrlf`/`core.eol` 与 safe core booleans；missing/replaced/oversized/drifting index dependency MUST typed fail。index discovery MUST 严格按 NUL record/header/path 解析 stage 0–3，保留 LF/U+2028/U+2029 pathname；stage 1/2/3 gitlink conflict 或未知/畸形 gitlink MUST 在任何 status/helper 前 fail closed，stage-0 path 按原字节去重。包含 exact nested Git top-level 的 initialized checkout 递归执行相同 snapshot/status 协议；无 `.git` 的 deinitialized stage-0 checkout 按 native clean gitlink 语义处理且 MUST NOT 向上发现 parent repo。真正 dirty observer MUST 仅消费该 snapshot，在不含 repository-controlled helper 配置的隔离 Git context 中以 `core.fsmonitor=false`、`--untracked-files=all`、`--ignore-submodules=all` 观察本层，再组合 initialized nested dirty；audit 返回后注入的 clean/process helper 也不得执行，repo-local `submodule.*.ignore=all` 不得隐藏 nested change。临时 Git context 的物理 parent MUST 位于被观察 checkout 外；checkout 内或其 symlink alias 的 `TMPDIR` MUST typed fail 且不得产生自污染或 residue。实际 HEAD 与 gitlink 不同是合法状态，必须记录实际值。四 checkout pipeline MUST 串行，或在失败时 cancel 并等待全部 settlement；collector 不得在已启动 sibling Git producer 仍活跃时返回。所有临时 Git context 与已登记 handle MUST bounded、no-follow 并在成功与所有 failure 路径释放；cleanup failure 不得覆盖 primary error，仅在没有 primary error 时成为 typed contract failure。

每个 checkout 的 no-follow 物理目录身份与完整 `commit/branch/detached/dirty` MUST 纳入两次 cheap snapshot。第二次 renv producer、schema validation 与 result freeze 后 MUST 以第二 snapshot capability 按固定顺序执行完整 first-sweep，再执行完整 second-sweep；成功只证明两个 map 彼此相等并等于待发布 snapshot。所有 sweep 完成后 MUST 统一复核 repository root 与四个 canonical checkout pathname identity。first-sweep 中早序 repo 在下一 sibling 邻接边界的漂移由 second-sweep 兜底。该协议没有一个三字段共同的原子 final observation：`commit` 的边界是该 repo 最后一次 `rev-parse HEAD` 返回，`branch/detached` 的边界是最后一次 branch command 返回，`dirty` 的边界是最后一次 frozen status 加 initialized-nested 组合返回；任一字段在自己的 second-sweep final observation 之后发生的 mutation、最后 pathname identity 观察之后的 mutation，以及 observation 间完整发生并恢复的 ABA 均不保证捕获。该协议不承诺强原子 snapshot、return-time contemporaneity 或任一 sweep 的 next-sibling mutation 必然失败；可观测 drift MUST fail，且 replacement target MUST NOT 重定向 Git 读取或被发布。

#### Scenario: 四个 submodule commit 均可读取

- **WHEN** 在本仓库执行采集
- **THEN** 返回四个 repo 各自的实际 40 位 HEAD commit；在 canonical checkout 中 zero 等于 pin `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`

#### Scenario: 实际 checkout HEAD 可偏离 gitlink

- **WHEN** SHUD checkout 在 superproject gitlink 之后产生本地 commit 或切换到其他 branch
- **THEN** `repos.SHUD.commit/branch` 记录实际 checkout 状态，gitlink 仍只参与代际一致性检查；不拒绝、不回退到 gitlink

#### Scenario: dirty 与 detached 状态完整记录

- **WHEN** 任一 checkout 有 tracked 修改、untracked 文件，或处于 detached HEAD
- **THEN** 前两者 `dirty=true`，干净 sibling 为 false；detached checkout 为 `branch="detached", detached=true`，同名 attached branch 为 `branch="detached", detached=false`

#### Scenario: checkout 状态跨快照漂移

- **WHEN** 任一 checkout 的 HEAD、branch、detached、dirty 或物理目录身份在两次 snapshot 间、后续 hash/schema/freeze 窗口、任一完整 publication sweep 或最终统一 identity 复核中发生可观测变化
- **THEN** 以 `collection_state_changed` 拒绝且不发布任何 partial StackLock content

#### Scenario: checkout 路径不可信

- **WHEN** 任一声明 checkout 缺失、不是目录、是 nested Git path、是 symlink leaf/ancestor，或 admission 后被同路径替换
- **THEN** admission 缺陷以 `collection_contract_invalid` 拒绝，admission 后漂移以 `collection_state_changed` 拒绝；不得读取或修改外部 target，不返回 partial result

#### Scenario: checkout HEAD/branch 输出或进程失败

- **WHEN** 任一 checkout 的 HEAD/branch 输出为空、未终止、多行、非 UTF-8、超过 64 KiB，或 Git 超时/失败
- **THEN** malformed/oversized output 以 `git_output_invalid` 拒绝，进程失败以 `git_read_failed` 拒绝；错误不回显 stdout/stderr、绝对路径、credential 或 trace sink

#### Scenario: checkout dirty 语义与 helper 隔离

- **WHEN** 隔离 observer 返回空字节、一个或多个 porcelain record，或 main/linked/nested 的 worktree config/include 声明 clean/process helper，或 helper 在 audit 后被外部 writer 注入
- **THEN** 空输出映射 `dirty=false`；一个或多个记录均映射 `dirty=true`；repo-local fsmonitor 不执行，`submodule.*.ignore=all` 不能隐藏 nested submodule change；预存 helper 在 observer 前 typed fail，post-audit helper 即使注入也不执行；仅非 UTF-8、超过 64 KiB 或进程失败按 `git_output_invalid`/`git_read_failed` 拒绝

#### Scenario: publication first-sweep 由 second-sweep 兜底

- **WHEN** 任一早序 checkout 在 first-sweep 已读取后、下一 sibling 开始时发生 commit/branch/dirty/identity 漂移
- **THEN** second-sweep 或最终统一 identity 复核观察到变化并返回 `collection_state_changed`；不返回 partial repo map

#### Scenario: publication 公开排除边界

- **WHEN** 任一早序 checkout 的 commit 在 second-sweep 最后一次 `rev-parse HEAD` 后、branch/detached 在最后一次 branch command 后，或 dirty 在最后一次 frozen status/nested 组合后发生 mutation，且后续命令没有观察到其他字段或 pathname identity 漂移
- **THEN** collector 可以返回两个相等的已完成 map；每个 mutation 均位于该字段自己的 final-observation 排除边界，不得把最后一次 status 称为三字段共同观察或声称结果与 return time 同时；同 pathname replacement 仍不能重定向任何 Git 读取

#### Scenario: 不可信 PATH 与 Git exit 码

- **WHEN** PATH 含 `.`、空或其他相对 component，或可信 Git 自身以与 identity remap 相同的数值 exit code 失败
- **THEN** 不执行 checkout-local binary；不可信 PATH 以 `git_read_failed` fail closed，可信 Git 失败仍为 `git_read_failed`，只有带专用 identity marker 的 mismatch 映射 `collection_state_changed`

#### Scenario: nested directory 不是仓库根

- **WHEN** 以仓库内 nested directory 调用采集，即使其中放置完整合法外观的固定配置文件
- **THEN** Git 报告 top-level 与请求物理根不等，采集在其他 producer 前以不泄露路径的 `repository_root_invalid` 拒绝且不返回 partial result

#### Scenario: 同 pathname 的仓库目录对象被替换

- **WHEN** admission 后以 rename 在相同 `repositoryRoot` pathname 安装不同 `(dev, ino)` 的合法仓库，无论替换发生在首次真实或 injected Git root observation、两次 snapshot 之间、package/provider/renv producer 邻接窗口或 publication 前
- **THEN** 采集以不泄露路径的 `collection_state_changed` 拒绝，不返回原仓库或替换仓库的 partial result

#### Scenario: .gitmodules 只绑定路径与 generation

- **WHEN** `HEAD:.gitmodules` 声明 canonical branch，而稳定 dirty 工作树 `.gitmodules` 声明不同 branch；或 HEAD 根本不含 `.gitmodules` 但工作树存在 untracked canonical 文件
- **THEN** 前者仍返回每个实际 checkout 的 branch，HEAD 声明只参与 generation 校验；后者以 `gitmodules_invalid` 拒绝；不得把工作树 bytes、HEAD 声明或 gitlink 冒充 `repos.*.commit/branch`

#### Scenario: HEAD .gitmodules object 非法或跨 snapshot 漂移

- **WHEN** HEAD inventory 中 `.gitmodules` missing/wrong-mode，精确 blob malformed/超过 64 KiB，或两次 snapshot 观察到不同 object id/blob generation
- **THEN** 非法对象以 typed non-disclosing failure 拒绝，合法 generation transition 以 `collection_state_changed` 拒绝，均不返回 partial result

#### Scenario: renv.lock inclusive byte bound

- **WHEN** 仓库根 regular `renv.lock` 恰好 16 MiB，随后以 16 MiB+1 重试
- **THEN** 前者返回独立可校验的 sha256，后者以 `renv_lock_invalid` 拒绝且不读取超限内容

### Requirement: renv.lock 内容哈希采集（grill 定案 2）

lock 采集 SHALL 读取仓库根 `renv.lock`：存在时记录 `{ path, sha256 }` 到 `runtime.r_packages_lock`；缺失时置 `null` 并在 lock 响应 `degraded[]` 中包含 `renv_lock_missing`（`degraded` 为响应级载体，形态见「lock 与读取端点」）。

#### Scenario: renv.lock 缺失显式降级

- **WHEN** 仓库根无 `renv.lock` 时调用 lock
- **THEN** 创建成功，`runtime.r_packages_lock = null`，响应 `degraded` 含 `renv_lock_missing`；不静默

### Requirement: harness 块与 llm digest 的 M2 采集口径（design D7a）

采集服务 SHALL 按以下确定性来源填充 `harness` 块：`version` = 仓库根 `package.json` 版本；`cli_version` = 占位常量 `"unknown"`（领域 CLI 属后续里程碑，语义见 Domain_CLI_Spec §5）；`prompt_pack` = 占位 id `"promptpack-unset"`；`skills_version` = 占位 id `"skills-unset"`（均为与 runtime 同型的显式占位允许，各随对应机制落地的里程碑升级）。`llm.params_digest` SHALL 为当前生效采样参数集的 canonical JSON sha256（M2 无参数存储 → 对空参数集 `{}` 哈希，显式记录）；`llm.prompt_pack_digest` SHALL 为 prompt pack 实际内容 sha256（M2 无 prompt pack 对象 → 对空字节串哈希占位）。两 digest 语义源不同，MUST NOT 取同一份配置文件哈希。

#### Scenario: harness 块占位可断言

- **WHEN** 在本仓库执行采集
- **THEN** `harness.version` 等于仓库根 package.json 版本；cli_version/prompt_pack/skills_version 等于上述占位常量

#### Scenario: 两个 digest 确定且互不相同

- **WHEN** 两次采集并比较 `llm.params_digest` 与 `llm.prompt_pack_digest`
- **THEN** 各字段两次值相同（确定性），且两字段值互不相同

### Requirement: fingerprint 确定性

`fingerprint` SHALL 是对 StackLock **内容字段**（`repos`，含四项实际 commit/branch/detached/dirty；`runtime`/`harness`/`llm`）canonical JSON（键排序）的 sha256；计算域 MUST 显式排除 `stack_id`、`created_at` 与 `fingerprint` 自身——canonical 用途是「快速比对」（Minimal_Schemas §2），同一环境两次 lock 必须比对相等，随机 `stack_id` 不得进入计算域。同内容 MUST 得同 fingerprint；合法 attached 分支 `detached` 与 detached HEAD 必须产生不同 fingerprint input。

#### Scenario: 同一环境两次 lock 同 fingerprint

- **WHEN** 在同一环境连续两次 `POST /api/stacks/lock`
- **THEN** 两条记录 `stack_id` 不同、`fingerprint` 相同

#### Scenario: 内容变化改变 fingerprint

- **WHEN** 改动 `llm.base_url`，或任一 repo 从 clean 变 dirty / dirty 变 clean 后再次 lock
- **THEN** fingerprint 与此前不同

### Requirement: lock 与读取端点

后端 SHALL 提供 `POST /api/stacks/lock`（执行采集、经 schema 校验、以既有 record store 权威持久化到 `workspace/stacks/`）与 `GET /api/stacks/:stackId`（读取；不存在返回 404 canonical envelope）。POST 响应形态 SHALL 为 `{ stack: <StackLock 记录>, degraded: string[] }`——`degraded` 是响应级载体，MUST NOT 进入 StackLock 记录 schema（strict）或落盘；GET 返回裸记录（沿 M1 `POST /api/tasks` 裸记录先例，读侧无 degraded）。llm 块 MUST 从 provider 配置读取，MUST NOT 在任何响应或日志中泄露 api key 值（只允许 `api_key_ref`）。

#### Scenario: lock 后可读取

- **WHEN** `POST /api/stacks/lock` 成功后 `GET /api/stacks/:stackId`
- **THEN** GET 返回与响应 `stack` 字段一致的同一记录，完整保留四 repo 实际 commit/branch/detached/dirty、llm.base_url 与 fingerprint；记录本体不含 `degraded`

#### Scenario: 不存在的 stack 返回 404

- **WHEN** `GET /api/stacks/STACK-nonexistent`
- **THEN** 404 与 canonical error envelope，不泄露文件系统路径

### Requirement: 重复提交语义（非幂等，显式裁决）

`POST /api/stacks/lock` SHALL 为非幂等操作：不纳入 Idempotency_Concurrency_Locking_Spec §4「必须幂等的操作」清单（清单不变，与 proposal 表述一致），不受理 `Idempotency-Key`；重复调用各产生独立记录，跨记录的环境等价性比对由 `fingerprint` 承担。

#### Scenario: 重复 lock 各得独立记录

- **WHEN** 同一环境连续两次调用 `POST /api/stacks/lock`
- **THEN** 产生两条各自可 GET 的独立记录（`stack_id` 不同、`fingerprint` 相同），无去重、无 409
