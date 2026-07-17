# stack-lock

StackLock schema 与采集服务：submodule commit 只读发现、runtime 版本占位、renv.lock 内容哈希、llm 块（ADR-0002 D9 `base_url` 必锁）、整体 fingerprint、`POST /api/stacks/lock` 与 `GET /api/stacks/:stackId`。权威源：[Minimal_Schemas §2](../../../../../docs/03_SPEC/Minimal_Schemas.md)、[Schemas_APIs_CLIs §1](../../../../../docs/04_IMPLEMENTATION/Schemas_APIs_CLIs.md)（含例外批次 6 读端点）、[Phase_By_Phase_Test_Plan W2](../../../../../docs/04_IMPLEMENTATION/Phase_By_Phase_Test_Plan.md)（W2-SUB-001）、[ADR-0002](../../../../../docs/adr/0002-mvp-reality-anchoring.md) D9。

## ADDED Requirements

### Requirement: StackLock Zod schema

core-schemas SHALL 新增 StackLock schema：`stack_id`（格式 `STACK-<uuid>`，design D5 记录的对 canonical NNNN 示意格式的偏离）、`repos`（SHUD/rSHUD/AutoSHUD/zero 四键，各含 commit + branch——design D5a 显式偏离记录：Minimal_Schemas §2 示例仅三键，但 zero 是 ADR-0001 钉死的 agent runtime 基座，复现链必锁，Test_Plan W2-SUB-001 已含 zero；canonical 补正走任务 0.1）、`runtime`（os/r_version/python_version/sundials_version/gcc_version/gdal_version 占位值或 `unknown`；`r_packages_lock` 为 `{ path, sha256 } | null`——design D5a 显式偏离记录：canonical 字符串 `renv.lock` 是文件名指针防不了内容漂移，对象化 = 内容哈希锁定，缺文件显式 null）、`harness`（version/cli_version/prompt_pack/skills_version，M2 采集口径见下方 requirement）、`llm`（provider/model_id/**base_url**/params_digest/prompt_pack_digest，全部 required）、`fingerprint`（sha256）、`created_at`。废弃字段 `runtime.container`/`limits`/`policy_version` MUST NOT 出现。

#### Scenario: llm 块缺 base_url 被拒

- **WHEN** 以缺 `llm.base_url` 的输入构造 StackLock
- **THEN** schema 校验失败（D9：第三方端点必锁，缺失即拒绝）

#### Scenario: 正例通过且废弃字段被拒

- **WHEN** 以含四 repo commit、runtime 占位、完整 llm 块的输入校验
- **THEN** 通过；含 `runtime.container` 的输入按 strict 模式拒绝

### Requirement: submodule commit 只读发现（W2-SUB-001）

采集服务 SHALL 经 gitlink 只读读取 SHUD、rSHUD、AutoSHUD、zero 四个 submodule 的 commit 与 branch，MUST NOT 修改任何 git 状态或进入 submodule 工作树写操作。

#### Scenario: 四个 submodule commit 均可读取

- **WHEN** 在本仓库执行采集
- **THEN** 返回四个 repo 各自的 40 位 commit hash，zero 的 commit 等于 pin `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`

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

`fingerprint` SHALL 是对 StackLock **内容字段**（`repos`/`runtime`/`harness`/`llm`）canonical JSON（键排序）的 sha256；计算域 MUST 显式排除 `stack_id`、`created_at` 与 `fingerprint` 自身——canonical 用途是「快速比对」（Minimal_Schemas §2），同一环境两次 lock 必须比对相等，随机 `stack_id` 不得进入计算域。同内容 MUST 得同 fingerprint。

#### Scenario: 同一环境两次 lock 同 fingerprint

- **WHEN** 在同一环境连续两次 `POST /api/stacks/lock`
- **THEN** 两条记录 `stack_id` 不同、`fingerprint` 相同

#### Scenario: 内容变化改变 fingerprint

- **WHEN** 改动 `llm.base_url` 后再次 lock
- **THEN** fingerprint 与此前不同

### Requirement: lock 与读取端点

后端 SHALL 提供 `POST /api/stacks/lock`（执行采集、经 schema 校验、以既有 record store 权威持久化到 `workspace/stacks/`）与 `GET /api/stacks/:stackId`（读取；不存在返回 404 canonical envelope）。POST 响应形态 SHALL 为 `{ stack: <StackLock 记录>, degraded: string[] }`——`degraded` 是响应级载体，MUST NOT 进入 StackLock 记录 schema（strict）或落盘；GET 返回裸记录（沿 M1 `POST /api/tasks` 裸记录先例，读侧无 degraded）。llm 块 MUST 从 provider 配置读取，MUST NOT 在任何响应或日志中泄露 api key 值（只允许 `api_key_ref`）。

#### Scenario: lock 后可读取

- **WHEN** `POST /api/stacks/lock` 成功后 `GET /api/stacks/:stackId`
- **THEN** GET 返回与响应 `stack` 字段一致的同一记录，含四 repo commit、llm.base_url 与 fingerprint；记录本体不含 `degraded`

#### Scenario: 不存在的 stack 返回 404

- **WHEN** `GET /api/stacks/STACK-nonexistent`
- **THEN** 404 与 canonical error envelope，不泄露文件系统路径

### Requirement: 重复提交语义（非幂等，显式裁决）

`POST /api/stacks/lock` SHALL 为非幂等操作：不纳入 Idempotency_Concurrency_Locking_Spec §4「必须幂等的操作」清单（清单不变，与 proposal 表述一致），不受理 `Idempotency-Key`；重复调用各产生独立记录，跨记录的环境等价性比对由 `fingerprint` 承担。

#### Scenario: 重复 lock 各得独立记录

- **WHEN** 同一环境连续两次调用 `POST /api/stacks/lock`
- **THEN** 产生两条各自可 GET 的独立记录（`stack_id` 不同、`fingerprint` 相同），无去重、无 409
