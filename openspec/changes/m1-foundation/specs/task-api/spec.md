# task-api

Hono 后端骨架：workspace init、TaskCard 最小链路、错误 envelope、幂等/锁/快照 skeleton、health、Artifact registry skeleton、路径安全 helper、结构化请求日志与 API 性能冒烟（观测最小骨架）。权威源：[Schemas_APIs_CLIs](../../../../../docs/04_IMPLEMENTATION/Schemas_APIs_CLIs.md)（API 端点唯一注册表）、[API_Error_And_Idempotency_Contracts](../../../../../docs/04_IMPLEMENTATION/API_Error_And_Idempotency_Contracts.md)、[Idempotency_Concurrency_Locking_Spec](../../../../../docs/03_SPEC/Idempotency_Concurrency_Locking_Spec.md)、[Workspace_Conventions](../../../../../docs/03_SPEC/Workspace_Conventions.md)、[Observability_Test_Plan](../../../../../docs/04_IMPLEMENTATION/Observability_Test_Plan.md)（OBS-HEALTH-001/002、OBS-LOG-001/002）、[Performance_Test_Plan](../../../../../docs/04_IMPLEMENTATION/Performance_Test_Plan.md)（PERF-API-001）。

## ADDED Requirements

### Requirement: workspace init 幂等创建目录树

`POST /api/workspace/init` SHALL 按 Workspace_Conventions 目录集（含 `readiness/` 补充目录）创建 workspace 文件树；重复调用 MUST 幂等（不报错、不重复创建、不破坏已有内容）。

#### Scenario: 二次 init 幂等

- **WHEN** 对已初始化的 workspace 再次调用 `POST /api/workspace/init`
- **THEN** 返回成功，目录树不变，已有文件不被覆盖

### Requirement: TaskCard 最小链路

后端 SHALL 提供 `POST /api/tasks`（建卡，初始 status=created，经 core-schemas 的 Zod 校验）、`GET /api/tasks`（列表）、`GET /api/tasks/:id`（详情）。

#### Scenario: 建卡后可查

- **WHEN** `POST /api/tasks` 创建 TaskCard 成功
- **THEN** `GET /api/tasks/:id` 返回同一对象，`GET /api/tasks` 列表包含它

#### Scenario: 非法请求体被拒

- **WHEN** `POST /api/tasks` 请求体缺 required 字段
- **THEN** 返回 400 与标准错误 envelope（错误类别 schema_error，含字段级信息）

### Requirement: API 错误 envelope 统一

所有非 2xx 响应 SHALL 使用 API_Error_And_Idempotency_Contracts 定义的错误 envelope 结构（字段以该 spec 为准），MUST NOT 返回裸字符串或框架默认错误页。

#### Scenario: 未知路由也走 envelope

- **WHEN** 请求不存在的 API 路径
- **THEN** 404 响应体为标准 envelope 结构

### Requirement: 幂等与锁 service skeleton

M1 变更范围内，`POST /api/tasks` SHALL 接受可选 `Idempotency-Key` 头作为 skeleton 验证载体；`packages/core` SHALL 提供 IdempotencyRecord / LockRecord 的存取 service skeleton（文件级实现即可，契约遵 Idempotency_Concurrency_Locking_Spec §2/§3——IdempotencyRecord 含 `request_digest`，key mismatch 按 API_Error_And_Idempotency_Contracts §2 映射 422）。

M1 以 `POST /api/tasks` 作为 skeleton 的验证载体，属 change-scoped 约定：该端点不在 Idempotency_Concurrency_Locking_Spec §4「必须幂等的操作」表与 API_Error_And_Idempotency_Contracts §3 适用清单内，本 requirement 不以验收断言扩张 canonical 契约——纳入 canonical 适用清单按账本冻结规则以 spec bug 修正单独记录（待办见 proposal Impact）。change-scoped key/digest 配方：`Idempotency-Key` 由客户端提供，`scope=task`（IdempotencyRecord scope 枚举既有值），`request_digest` = 规范化 JSON 请求体（键排序；至少覆盖 title、created_by 与全部业务字段）的 sha256。

#### Scenario: 幂等重放

- **WHEN** 以相同 `Idempotency-Key` + 相同请求体重放 `POST /api/tasks`
- **THEN** 返回首次创建的同一 TaskCard，不产生重复对象

#### Scenario: 活跃同 key 请求跨一秒仍收敛

- **WHEN** 首个相同 `Idempotency-Key` + 相同 request digest 的建卡请求仍在本进程执行，且 snapshot 写入或 post-write hook 超过 1000ms
- **THEN** 后到请求等待同一 in-flight owner 终态并重放同一 durable TaskCard，不返回 pending 409，不产生第二个 snapshot/result_ref

#### Scenario: 无活跃 owner 的 started record 走 stale 路径

- **WHEN** workspace 中只有 `status=started` 的同 key/digest IdempotencyRecord，但本进程没有对应 in-flight owner
- **THEN** 后端在有界等待后返回稳定可重试错误，不创建 TaskCard，不把 orphaned claim 误记 completed

#### Scenario: digest mismatch 返回 422

- **WHEN** 以相同 `Idempotency-Key` + 不同请求体（request_digest 不一致）重放 `POST /api/tasks`
- **THEN** 返回 422 标准错误 envelope（idempotency key mismatch，API_Error_And_Idempotency_Contracts §2），不创建新对象

### Requirement: task snapshot 落盘与恢复

TaskCard SHALL 落盘为 workspace 内 snapshot；服务重启后 `GET /api/tasks` MUST 恢复重启前的任务列表。

#### Scenario: 重启恢复

- **WHEN** 建卡后重启后端服务并请求 `GET /api/tasks`
- **THEN** 列表包含重启前创建的 TaskCard

#### Scenario: post-write 后 snapshot 必须仍可重放

- **WHEN** snapshot rename 后、producer 返回前，post-write hook 删除、替换或破坏 `snapshot.json`
- **THEN** 建卡失败且不缓存 phantom TaskCard；keyed 路径不留下 completed IdempotencyRecord，修复 workspace 后同 key 可安全重试

#### Scenario: canonical snapshot 缺 task_card 返回专门错误

- **WHEN** completed result_ref 指向一个 schema 可解析但不含 nested `task_card` 的 canonical TaskSnapshot
- **THEN** 返回 `task_snapshot_missing_card` recovery/migration error，不折叠为 idempotency result binding mismatch

### Requirement: health live/ready skeleton

后端 SHALL 提供 liveness 与 readiness 两个健康端点（路径以 Schemas_APIs_CLIs 注册表为准）：live 表示进程存活，响应含 `status`、`version`、`uptime_seconds`、`timestamp`（OBS-HEALTH-001 字段集）；ready 表示 workspace 可用，检查项 MUST 含目录树在位、snapshot 可读与 `workspace_writable`（OBS-HEALTH-002），响应含分项 checks。

#### Scenario: 依赖未就绪

- **WHEN** workspace 未初始化时请求 readiness 端点
- **THEN** 返回非 2xx；liveness 端点仍返回 2xx

#### Scenario: workspace 不可写

- **WHEN** workspace 目录不可写时请求 readiness 端点
- **THEN** ready 状态为 not_ready，分项 checks 中 `workspace_writable` = fail（OBS-HEALTH-002）

### Requirement: Artifact registry skeleton

`packages/core` SHALL 提供 Artifact registry service skeleton：注册 Artifact（类型枚举遵 Artifact_Registry_Spec）、按 id 查询；本里程碑仅要求文件级存取与 schema 校验，manifest 与 evidence_usable 全量语义随 M2+ 激活。

#### Scenario: 注册后可查

- **WHEN** 通过 registry service 注册一个合法 Artifact
- **THEN** 按 id 查询返回同一记录，且落盘于 workspace 约定路径

### Requirement: 路径规范化与 workspace 边界防护

`packages/core` SHALL 提供共享路径安全 helper，对外部输入的路径按 Workspace_Conventions §9 处理：resolve 规范化 → 校验落在 workspace（或允许的只读路径）边界内 → 拒绝 symlink escape → 记录规范化路径。M1 的落盘写入面（Artifact registry 落盘、task snapshot 写入）SHALL 经由该 helper 解析目标路径；被拒路径 MUST NOT 触发任何 workspace 外读写（对应 Test_Plan W1 Unit「path normalization」）。

#### Scenario: 路径穿越被拒

- **WHEN** 输入路径含 `../`（或等效形态），resolve 后落在 workspace 边界之外
- **THEN** helper 拒绝该路径，不发生任何 workspace 外读写

#### Scenario: symlink escape 被拒

- **WHEN** 输入路径位于 workspace 内，但经 symlink 解析后实际指向 workspace 外
- **THEN** helper 拒绝该路径，不发生任何 workspace 外读写

#### Scenario: 合法路径记录规范化形态

- **WHEN** 输入 workspace 边界内的合法路径
- **THEN** helper 返回规范化路径，落盘与记录均使用该规范化形态

### Requirement: 结构化 API 请求日志（观测最小骨架）

后端 SHALL 为每个 API 请求输出一条 NDJSON 结构化日志行，字段集对齐 Observability_Test_Plan OBS-LOG-001：`ts`、`level`、`service`、`event`、`request_id`、`route`、`status`、`duration_ms`；日志 MUST NOT 出现 secret 明文，涉及 secret 的值仅以 ref（如 `env:GLM_API_KEY`）或 `[REDACTED]` 形式出现（OBS-LOG-002，与 glm-provider 的 secret 约束共同覆盖）。metrics/alerts/ops dashboard 等观测全量栈不在本里程碑（M3 运维骨架承接）。

#### Scenario: 请求产生结构化日志行

- **WHEN** 任一 API 请求处理完成
- **THEN** 输出一条 NDJSON 日志行，含 OBS-LOG-001 全部八个字段，`request_id` 可关联同请求的错误 envelope

#### Scenario: secret 不落日志

- **WHEN** 请求处理路径涉及已配置的 secret（如 provider 配置加载）
- **THEN** 日志中仅出现 ref 或 `[REDACTED]`，无 secret 明文

### Requirement: API metadata 性能冒烟（PERF-API-001）

仓库 SHALL 提供 `bun run test:perf:api` 冒烟脚本（fixture = mock workspace + 100 tasks，遵 Performance_Test_Plan PERF-API-001）：断言 `GET /api/tasks`、`GET /api/tasks/:id` 与 health ready 端点 P95 ≤ 300ms；该冒烟 SHALL 接入 PR CI（Performance_Test_Plan §5 CI 放置）。

#### Scenario: 冒烟在 CI 内判定

- **WHEN** PR CI 运行 `bun run test:perf:api`
- **THEN** 三个 metadata 端点 P95 ≤ 300ms 时通过；任一超标时 CI 失败并输出实测 P95
