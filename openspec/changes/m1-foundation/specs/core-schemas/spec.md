# core-schemas

首批 5 个 Zod schema 与 schema 生成/漂移检查。权威源：[Minimal_Schemas](../../../../../docs/03_SPEC/Minimal_Schemas.md)（核心对象）、[Support_Schema_Contracts](../../../../../docs/03_SPEC/Support_Schema_Contracts.md)（support 对象）、[CANONICAL_CONTRACTS §1](../../../../../docs/00_INDEX/CANONICAL_CONTRACTS.md)（canonical 顺序）、[Schema_Generation_And_Drift_Control](../../../../../docs/04_IMPLEMENTATION/Schema_Generation_And_Drift_Control.md)（schema 生成与 drift 政策唯一权威源，canonical_for: schema-drift-policy）。

## ADDED Requirements

### Requirement: 首批 5 个 Zod schema

`packages/core/src/domain/schemas/` SHALL 提供 TaskCard、Artifact、ErrorRecord、IdempotencyRecord、LockRecord 的 Zod schema，字段与语义遵 canonical 顺序（Zod 源码进入实现后为最高事实源，语义以 Minimal_Schemas / Support_Schema_Contracts 为底）。每个 schema MUST 有正反例单测。

#### Scenario: 合法对象通过

- **WHEN** 用符合 Minimal_Schemas 语义的样例 parse TaskCard
- **THEN** 校验通过并得到类型化对象

#### Scenario: 缺 required 字段被拒

- **WHEN** 用缺失 required 字段的对象 parse 任一 schema
- **THEN** 校验失败并给出字段级错误

### Requirement: TaskCard 粗粒度状态机

TaskCard.status SHALL 限定为 Minimal_Schemas 定义的粗粒度状态枚举（`created → planned → running → parked → reporting → awaiting_pi → done | cancelled | blocked`）；`runtime_phase` 为辅助展示字段，MUST NOT 参与状态机转换条件。

#### Scenario: 非法状态值被拒

- **WHEN** 以枚举外的 status 值构造 TaskCard
- **THEN** Zod 校验失败

### Requirement: ErrorRecord 携带 remediation

ErrorRecord SHALL 包含 `remediation` 结构：`next_action ∈ {escalate_to_pi, open_gate, adjust_scope, fix_and_retry, abort}` + `hint` + `ref`（权威源 Support_Schema_Contracts §3）。

#### Scenario: remediation 枚举约束

- **WHEN** 以枚举外的 `next_action` 值构造 ErrorRecord
- **THEN** Zod 校验失败

### Requirement: schema 生成与漂移检查

系统 SHALL 提供生成脚本：从 Zod 源码单向生成两套生成物——`docs/generated/schema/*.md`（Markdown 字段表）与 `docs/generated/json-schema/*.json`（JSON Schema），遵 Schema_Generation_And_Drift_Control §1/§3；CI SHALL 运行 drift 检查（`bun run schema:generate` 后 `git diff --exit-code docs/generated/schema docs/generated/json-schema`，同 spec §4），任一目录生成物与源不一致时失败。

#### Scenario: 漂移被拦截

- **WHEN** 修改 Zod schema 字段但未重新生成生成物
- **THEN** CI drift 检查失败并指出漂移的 schema（检查范围覆盖 `docs/generated/schema` 与 `docs/generated/json-schema` 两目录，任一目录有差异即失败）
