# data-provenance

DataProvenance schema、路径安全校验、文件/目录 sha256、`POST /api/data/register` 与 `GET /api/data/:dataId`。权威源：[Minimal_Schemas §3](../../../../../docs/03_SPEC/Minimal_Schemas.md)、[Data_Storage_Provenance](../../../../../docs/03_SPEC/Data_Storage_Provenance.md)（raw 只读纪律）、[Schemas_APIs_CLIs §1](../../../../../docs/04_IMPLEMENTATION/Schemas_APIs_CLIs.md)、[Phase_By_Phase_Test_Plan W2](../../../../../docs/04_IMPLEMENTATION/Phase_By_Phase_Test_Plan.md)（W2-DATA-001/002）。

## ADDED Requirements

### Requirement: DataProvenance Zod schema

core-schemas SHALL 新增 DataProvenance **记录** schema：`data_id`（格式 `DATA-<uuid>`，design D5 偏离记录）、`basin`、`event_window`（`{ start, end }` 对象，废弃数组形态 MUST 拒绝）、`sources`（每个来源含 path + sha256；observations 数组项含 variable/station/path/sha256）、`preprocess`（script/params/output_sha256，可选）、`uncertainty_notes`（可选）。无 sha256 的来源简写 MUST 拒绝（记录侧约束；register 输入侧 sha256 为服务端专属计算字段，输入契约见下方 requirement）。

#### Scenario: 正例通过、废弃形态被拒

- **WHEN** 以对象 event_window + 带 sha256 的 sources 校验
- **THEN** 通过；`event_window: [start, end]` 数组形态与缺 sha256 的来源均拒绝

### Requirement: sha256 双形态（design D3）

hashing 工具 SHALL 提供：文件 = 内容流式 sha256；目录 = 对目录内全部常规文件按相对路径字典序生成 `"<relpath>\n<file-sha256>\n"` 行序列再整体 sha256。符号链接、非常规文件 MUST 拒绝；空目录 MUST 拒绝。同内容 MUST 得同哈希（确定性）。

#### Scenario: 目录哈希确定性

- **WHEN** 对同一目录内容计算两次目录哈希
- **THEN** 两次相同；新增一个文件后值改变

#### Scenario: 符号链接被拒

- **WHEN** 待哈希路径下存在符号链接
- **THEN** 拒绝并返回 path-safety 类错误，不跟随链接

### Requirement: register 输入契约（sha256 为服务端专属）

`POST /api/data/register` SHALL 定义独立输入 schema（非 DataProvenance 记录 schema）：`basin` 与 `event_window`（`{ start, end }` 对象）必填；`sources` 必填且每个来源仅含描述字段（path；observations 项含 variable/station/path）；`preprocess`（script/params）与 `uncertainty_notes` 可选。全部 sha256 类字段（来源 `sha256`、`preprocess.output_sha256`）为服务端专属计算字段：输入中出现任一 → 422 canonical envelope（显式拒绝，不静默忽略，不采信客户端哈希——防伪造哈希与实算值混淆）。落盘记录 MUST 通过 DataProvenance 记录 schema 校验（含服务端实算 sha256）。

#### Scenario: 输入自带 sha256 被拒

- **WHEN** register 请求的某来源携带 `sha256` 字段
- **THEN** 422 canonical envelope，不创建记录

#### Scenario: 缺必填字段被拒

- **WHEN** register 请求缺 `basin` 或 `event_window`
- **THEN** 422 canonical envelope（schema_error），不创建记录

### Requirement: register 端点（W2-DATA-001/002）

后端 SHALL 提供 `POST /api/data/register`：对请求内每个来源路径做 workspace 相对路径安全校验（复用 M1 路径安全 helper，拒绝绝对路径/越界/穿越），路径存在则计算 sha256 并持久化 DataProvenance 记录（既有 record store 权威，`workspace/provenance/`——目录形态对 Workspace_Conventions §5 / Repository_Layout §2 的显式偏离裁决见 design D4，canonical 统一走任务 0.1），返回完整记录；以及 `GET /api/data/:dataId` 读取。

#### Scenario: 已存在路径注册成功（W2-DATA-001）

- **WHEN** 对 workspace 内已存在的数据路径调用 register
- **THEN** DataProvenance 创建成功，每个来源记录了实际计算的 sha256，`GET /api/data/:dataId` 可读回

#### Scenario: 缺失路径返回 404/422（W2-DATA-002）

- **WHEN** 来源路径不存在
- **THEN** 返回 404/422 canonical error envelope，不创建任何记录，不泄露绝对路径

#### Scenario: 越界路径被拒

- **WHEN** 来源路径含 `..` 穿越或为绝对路径
- **THEN** 422 拒绝（path-safety），不触碰文件系统

### Requirement: secrets 子树 denylist

`workspace/secrets/**` MUST NOT 可被登记为数据来源：register 请求任何来源路径落于该子树 → 422 canonical envelope，不读取文件内容、不创建记录。该路径在 workspace 边界内也一律拒绝——复用 M1 path-safety helper 的边界机制扩展 deny 子树（design D1）。

#### Scenario: secrets 路径登记被拒

- **WHEN** register 的来源路径为 `secrets/local-token`
- **THEN** 422 canonical envelope，不读取文件内容、不创建记录

### Requirement: 重复提交语义（非幂等，显式裁决）

`POST /api/data/register` SHALL 为非幂等操作：不纳入 Idempotency_Concurrency_Locking_Spec §4「必须幂等的操作」清单（清单不变，与 proposal 表述一致），不受理 `Idempotency-Key`；对同一来源集重复提交各产生独立记录，内容等价性比对由来源 sha256 承担。

#### Scenario: 重复 register 各得独立记录

- **WHEN** 对同一来源集连续两次 register
- **THEN** 产生两条独立记录（`data_id` 不同、来源 sha256 逐项相同），无去重、无 409

### Requirement: raw 数据只读纪律

register 全流程 MUST 只读访问被注册路径（open 只读、no-follow 纪律）；MUST NOT 写入、重命名或修改 `data/raw/**` 下任何内容。

#### Scenario: register 不改动被注册内容

- **WHEN** register 完成后对比来源文件字节
- **THEN** 与 register 前逐字节一致
