# artifact-evidence

Artifact registry 完整化：evidence_usable 七条确定性规则、LLM 产物默认 false + 升级 audit、ArtifactManifest read/write 与 `manifest_sha256` 复算、`GET /api/artifacts/:artifactId/data` skeleton。权威源：[Artifact_Registry_Spec](../../../../../docs/03_SPEC/Artifact_Registry_Spec.md) §2–§8、[Phase_By_Phase_Test_Plan W2](../../../../../docs/04_IMPLEMENTATION/Phase_By_Phase_Test_Plan.md)（W2-ART-001/002）、[Schemas_APIs_CLIs §1](../../../../../docs/04_IMPLEMENTATION/Schemas_APIs_CLIs.md)（data 端点为既有 canonical 登记项）。

## ADDED Requirements

### Requirement: evidence_usable 七条确定性规则（Artifact_Registry_Spec §4）

registry 服务在 register/update 时 SHALL 校验：① 有 artifact_id；② 有 task_id（来自运行则有 run_id source_ref）；③ 有 sha256 或显式 no-hash 理由；④ 有 source_refs；⑤ path 不在 `workspace/tmp/`；⑥ `redaction_status != unsafe`；⑦ figure 类型必须有生成参数与数据来源。任一不满足 → `evidence_usable` 强制 false（降级记录，不报错）。

#### Scenario: tmp 路径产物不可作证据

- **WHEN** 注册 path 位于 `workspace/tmp/` 的 artifact 并请求 `evidence_usable=true`
- **THEN** 记录创建成功但 `evidence_usable=false`

#### Scenario: 七条齐备时可为 true

- **WHEN** 注册满足全部七条的 metrics artifact 且请求 evidence_usable=true
- **THEN** `evidence_usable=true`（W2-ART-001：path/type/sha256/retention_class 合法）

### Requirement: Artifact schema 扩展：llm_generated 持久化标记（design D6）

Artifact schema SHALL 新增持久化扩展字段 `llm_generated: boolean`（可选，缺省 false）。这是对 Support_Schema_Contracts §1 Artifact 接口的 additive 显式偏离（canonical 落账任务 0.1）：canonical 机制以「created_by 与操作者身份」识别 LLM 产物（Artifact_Registry_Spec §4），但 M2 无 agent 身份体系，该机制无输入可用；且 M1 `ArtifactSchema` 为 strict 集合，未声明键会被直接拒——该标记必须做 schema delta，不能只作瞬态注册参数。register 时该标记随记录落盘；update 与升级路径 MUST 以**落盘值**判定 LLM 产物身份，MUST NOT 采信请求值。M3+ agent 身份落地后与 canonical `created_by` 校验机制合流。

#### Scenario: 标记随记录落盘

- **WHEN** 注册 `llm_generated: true` 的 artifact 后读回记录
- **THEN** 落盘记录含 `llm_generated: true`；未提供该字段的注册落盘为 false

#### Scenario: update 不能洗白 LLM 身份

- **WHEN** 对落盘 `llm_generated: true` 的 artifact 提交携带 `llm_generated: false` 的 update 并请求 `evidence_usable=true`
- **THEN** 落盘 `llm_generated` 保持 true，`evidence_usable` 仍为 false（升级只能走升级服务操作）

### Requirement: LLM 产物默认 false 与升级 audit（grill 定案 3）

落盘 `llm_generated: true`（见上方 schema 扩展 requirement）的 artifact，`evidence_usable` MUST 默认 false 且注册时不可直接置 true；升级为 true 是独立 core 服务操作（M2 无 HTTP 端点，design D6），成功升级 MUST 经服务 options bag 注入的 `auditSink` 写一行 NDJSON audit 事件（`{ ts, level, service, event: "audit.evidence_upgrade", actor, target_id, result }`——core 无 HTTP 请求上下文，不复用 #31 请求中间件，通道形态见 design D6）。`created_by=agent` 一律 403 的校验 **推迟至 agent 身份进入系统的里程碑（M3+）**——本条为 deferred requirement 记录，防治理红线遗忘。

#### Scenario: LLM 产物注册即请求 true 被降级

- **WHEN** 注册 `llm_generated: true` 且请求 `evidence_usable=true` 的 artifact
- **THEN** 落盘记录 `evidence_usable=false`

#### Scenario: 升级操作写 audit

- **WHEN** 经升级服务操作把该 artifact 置 `evidence_usable=true`
- **THEN** 记录更新成功，NDJSON 日志出现一行 `audit.evidence_upgrade` 事件（含 target artifact_id 与 result=success）

### Requirement: ArtifactManifest schema 与 read/write 完整性（W2-ART-002）

core-schemas SHALL 新增 ArtifactManifest Zod schema，与 Support_Schema_Contracts §2（canonical_for support-schemas）一一对应：`manifest_id`（格式 `MANIFEST-<uuid>`，design D5 偏离记录）、`task_id`、`run_id`（可选）、`report_id`（可选）、`artifacts`（**完整 `Artifact[]` 对象数组**——Artifact_Registry_Spec §5 示例的 `{artifact_id,type,path}` 精简行视为示意，两权威源冲突以 Support_Schema_Contracts 为准）、`generated_at`、`generator`（必填）、`manifest_sha256`（可选，写入时计算）；另含 `superseded_by`（可选，见下——对 §2 的 additive 偏离，落账任务 0.1）。

registry SHALL 支持为一组 artifact 生成 manifest 并持久化到 `workspace/artifacts/manifest-sets/`（design D4 目录裁决：`artifacts/manifests/` 已被 M1 单 artifact 元数据记录占用，群组记录独立命名空间，目录加入 `WORKSPACE_CANONICAL_DIRECTORIES`）；manifest 自身 SHALL 计算 `manifest_sha256`（对 manifest 除该字段外的 canonical JSON），读取时可复算一致。manifest 类 artifact 默认不可原地覆盖（§6 Immutability）：重生成 MUST 产生新 manifest_id，且旧记录 MUST 标记 superseded（`superseded_by` 指向新 manifest_id——§6 原文「旧 artifact 标记为 superseded」，canonical schema 无载体字段，故以 additive 字段承载）。

#### Scenario: manifest_sha256 可复算

- **WHEN** 写入 manifest 后读回并按同一 canonical 规则复算
- **THEN** 复算值与记录的 `manifest_sha256` 一致

#### Scenario: 重生成产生新 id 且旧记录标记 superseded

- **WHEN** 对同一组 artifacts 再次生成 manifest
- **THEN** 新记录有新的 manifest_id；旧记录内容不被覆盖，且其 `superseded_by` 指向新 manifest_id

#### Scenario: schema 正反例

- **WHEN** 以缺 `generator` 或 artifacts 为精简行（非完整 Artifact 对象）的输入校验 ArtifactManifest schema
- **THEN** 均校验失败；含完整字段的正例通过

### Requirement: GET /api/artifacts/:artifactId/data skeleton

后端 SHALL 提供该 canonical 端点：按已登记 artifact record 的 path 服务文件内容（正确 media_type），路径经安全校验 + no-follow；artifact 不存在 → 404 envelope；记录存在但文件缺失 → 明确的 410/404 类 envelope（不含绝对路径）。MUST NOT 提供目录列举；range/分页留 skeleton 注记不实现。「响应 MUST NOT 含 secrets」以 deny 子树落为可断言行为（design D1）：`workspace/secrets/**` 位于 workspace 路径安全边界之内，故 register/update 时 path 落于该子树的 artifact MUST 422 拒绝登记；对既有记录 path 落于该子树的 data 请求 MUST 403 拒绝服务（`category=permission_error`），不读取文件内容。

#### Scenario: 已登记 artifact 数据可读

- **WHEN** 注册一个 metrics artifact 后 GET 其 data 端点
- **THEN** 200 返回文件字节与登记的 media_type

#### Scenario: 未登记 id 与路径穿越都不可达

- **WHEN** GET 不存在的 artifactId，或构造含 `..` 的 id
- **THEN** 404/422 envelope；服务端不发生任何越界文件访问

#### Scenario: secrets 子树不可登记也不可读出

- **WHEN** 尝试注册 path 为 `secrets/local-token` 的 artifact；或对 path 已落于 `workspace/secrets/**` 的既有记录 GET data 端点
- **THEN** 登记 422 拒绝；data 请求 403 拒绝，响应不含文件内容任何字节
