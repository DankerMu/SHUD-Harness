# M2: Research Context — StackLock + DataProvenance

## Why

M1 交付了 TaskCard 最小链路与 Artifact registry skeleton，但任务还回答不了两个科研复现的根本问题：**"这个结果是在什么环境下算出来的"**（版本链）和 **"输入数据从哪里来、是否被改动过"**（数据溯源）。没有这两层，M4 的科学运行（ccw tiny + VerificationCase）产出的任何数字都不可复现、不可审计。

M2 按 Phased_Plan M2 节交付研究上下文层：StackLock（含 llm `base_url` 必锁，ADR-0002 D9——第三方端点防静默换版）、DataProvenance（sha256 + raw 数据保护）、Artifact registry 完整化（evidence_usable 治理），以及 D6 口径的单账号 + localhost 鉴权。

## What Changes

- 新增 StackLock：`POST /api/stacks/lock` 自动采集四个 submodule commit + runtime 版本占位 + renv.lock 内容哈希 + llm（provider/model_id/base_url/params_digest/prompt_pack_digest）+ 整体 fingerprint。
- 新增 DataProvenance：`POST /api/data/register` 对已存在路径做安全校验 + sha256（文件与目录两种语义），缺失路径返回 404/422 canonical envelope。
- Artifact registry 完整化：evidence_usable 七条确定性规则 + LLM 产物默认 `evidence_usable=false` + 升级操作写 audit 行；ArtifactManifest read/write 与 `manifest_sha256` 可复算；`GET /api/artifacts/:artifactId/data` skeleton（路径安全、不泄 secrets）。
- 鉴权（D6 收缩口径，grill 已拍板）：server 仅监听 127.0.0.1 + 单一本地 token，API 统一校验（401 复用既有 `permission_error` 类别）；浏览器前端经入口页 bootstrap 注入获取 token、统一 fetch wrapper 携带（design D1）；不建多用户 Session 层。
- TaskCard 绑定：create 接受 `stack_id`/`data_id` 并做存在性校验（canonical TaskCard 字段已含，不动 frozen 字段集；两字段纳入 keyed 幂等请求体 digest，防同 key 不同绑定被错误去重）。
- 前端：ResearchContext（SideNav 内 StackLock + DataProvenance 摘要卡）、ArtifactRef 组件（纯展示，props 传入）、ExperimentHeader 完整化、统一鉴权 fetch wrapper 接线。

**Grill 定案（2026-07-16，三决策）**：(1) 鉴权 = localhost 绑定 + 单一本地 token；(2) renv.lock 集成归 StackLock 采集（`runtime.r_packages_lock` 记内容哈希，缺文件显式降级语义），不归 data register；(3) evidence_usable 实现七条 + LLM 默认 false + audit，`created_by=agent` 的 403 校验推迟到 agent 身份进系统的里程碑（M3+），spec 显式记录推迟。

## Capabilities

- `stack-lock`：StackLock schema、submodule/runtime/renv 采集、fingerprint、`POST /api/stacks/lock` 与按 id 读取。
- `data-provenance`：DataProvenance schema、路径安全校验、文件/目录 sha256、`POST /api/data/register` 与按 id 读取。
- `artifact-evidence`：evidence_usable 规则引擎、manifest read/write 与完整性、`GET /api/artifacts/:artifactId/data` skeleton。
- `local-auth`：localhost 绑定 + 本地 token 中间件与负例。
- `research-context-binding`：TaskCard stack/data 绑定校验 + 前端 ResearchContext/ArtifactRef/ExperimentHeader。

## Impact

- `packages/core`：新增 stack-lock/data-provenance/artifact-manifest schemas 与服务、sha256 工具、evidence 规则；扩展 artifact 服务与 Artifact schema（`llm_generated`，design D6 偏离记录）。
- `packages/backend`：新增 `/api/stacks`、`/api/data` 路由与 artifact data 端点；全路由挂 token 中间件；workspace 目录树扩展（新增 provenance/、secrets/、artifacts/manifest-sets/；stacks/ 已在 M1 目录表存在，非本次扩展）。
- `packages/frontend`：token bootstrap + 统一鉴权 fetch wrapper、SideNav ResearchContext 卡、ArtifactRef、ExperimentHeader 数据接线。
- 不改 SHUD/rSHUD/AutoSHUD/zero submodule；不改 M1 frozen canonical 契约：TaskCard 字段集不动；error envelope 不扩（401 复用既有 `permission_error`，不加新类别）；幂等适用清单不扩（`POST /api/stacks/lock` 与 `POST /api/data/register` 显式裁决为非幂等；`POST /api/tasks` 仍是清单唯一 task 项，其 keyed digest 覆盖新可选字段 stack_id/data_id）。
- 显式偏离与 canonical bug 级修正账（各 spec/design 逐处记录，文档补正集中在 tasks 0.1）：StackLock repos 四键（补 zero）与 `r_packages_lock` 对象化（Minimal_Schemas §2）；Artifact 增 `llm_generated`、ArtifactManifest 增 `superseded_by`（Support_Schema_Contracts §1/§2）；`HARNESS_LOCAL_TOKEN`（Config_Secrets §4）；provenance/secrets/manifest-sets 目录（Workspace_Conventions / Repository_Layout）。
- 验收门：一个 task 绑定 stack_id + data_id，SideNav 展示完整版本链（含 llm base_url）；registry 记录 evidence_usable artifact。测试细目 = Test_Plan W2（W2-SUB-001、W2-DATA-001/002、W2-ART-001/002 + 3 条 UI）。
