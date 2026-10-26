---
status: accepted
kind: architecture
---

# ADR-0004: 内核切换到 DeepSeek Harness（dsh）与仓库重置

**状态**：accepted（2026-10-20，PI 审核通过）
**决策人**：PI
**方法**：可行性 spike（`../dsh-spike`，约 3.5 小时）+ grill-me 压测（Phase 2，17 个分支全部收敛）
**取代**：ADR-0001 的基座决策（Zero）与拓扑实现层；ADR-0002 的 D3/D5/D9；ADR-0002 D1/D2/D4/D6/D8 继续有效；D7（邮件通知）转为开放项。

## 背景

- Zero 基座于 2026-07-10 转 Adopt 后，项目在 M2 "capability observer" spike（描述符权限证明、fd authority、Rust/gix）上停滞：2026-07-28 起 35 个提交全部落在 spike，`packages/core/src/domain` 零提交，最后提交 2026-08-03。停摆原因是 meta-spike 失控，不是基座缺陷。
- 代码量倒挂：`packages/core` 91K 行中单个测试文件 34K 行、record store 12K 行，零次真实 SHUD 运行；spec 343 篇 / 53.7K 行冻结。
- DeepSeek Harness（`dsh`，MIT，2026-08-13 首发）以 Cordis 插件树实现"万物皆插件"，策略门、审批、沙箱、后台作业、子代理、session 回放均为文档化 seam。spike 实测本项目的治理需求可在 seam 上以配置 + 极少代码实现。

## 决策

| # | 决策 | 依据 |
|---|---|---|
| K1 | **内核 = dsh**，钉 tag `dsh-v0.2.1-rc.2`，不 fork、不改源码；每个里程碑边界评估升级一次，升级 = 独立 issue，以上游 `docs/upgrade-guide/` 为输入，跳过则记录原因 | spike 1.1–1.5 全部通过；上游 4 天 90 提交、单版 20 条 breaking change，必须钉 tag |
| K2 | **产品形态 = `dsh --profile shud`**：一个 profile + 一个 bundle + 若干 `dsh-shud-*` 插件；自建 Hono 后端与 React 前端退场 | dsh 入口校验禁止绕过 profile 启动；治理/审批/沙箱/作业全在 seam 上 |
| K3 | **运行时模型 = DeepSeek Flash，经 DMXAPI 中转**，请求别名 `deepseek-flash-guan`，走原生 `llm-deepseek` Messages adapter（`baseURL: https://www.dmxapi.cn`，`apiKeyEnv: DMXAPI_KEY`）；pi-ai OpenAI 兼容路线为备胎 | 取代 ADR-0002 D9；HTTP 与进程内实测：tool-calling、thinking signature 回放、in-history 系统提示、SSE 均通 |
| K4 | **StackLock.llm 锁三字段**：`base_url` + 请求别名 + 响应 `model`；RunRecord 必须记录响应 `model`。响应 model 变化**不**自动使 lock 失效，只记录，可比性由 PI 看报告判断 | `deepseek-flash` 是官方滚动别名（当前解析到 V4.1-Flash-1017）；PI 有意否决自动失效 |
| K5 | **首任务 = ccw 运行 → RunRecord → EvidenceReport**（无代码改动）；openMP RHS 已知答案回放为第二任务。MVP 主链随之改为 TaskCard→RunJob→RunRecord→EvidenceReport，ChangeRequest + VerificationCase 后移 | 取代 ADR-0002 D3/D5；先打通不含 patch 流程的主链，风险分散 |
| K6 | **单用户维持**（ADR-0002 D6 不变）；多用户不做。若未来需要，路径是作为 dsh-team 风格平台的实例镜像交付，而非在 SHUD-Harness 内实现账号 | PI 决定 |
| K7 | **MVP 零自定义 UI**：用 dsh 自带聊天、审批卡片、作业卡片 + Markdown 报告文件 | 1.4 调研：自定义卡片需 React 包 + 构建；YAGNI |
| K8 | **durable JobRegistry backend 是 M2 核心交付，替换全部 `jobs-local`**：实现 `ctx.jobs` 契约，子进程 detach、作业记录落盘、启动时 pid 对账、collect 后投递完成通知；M2 shud 无 owner 登记，证据为运行目录与 `shud-jobs` 唤醒消息，不补 `job/settled`（[m2-run-chain D7/D12](../../../openspec/changes/m2-run-chain/design.md)） | spike 1.3：优雅关停杀子进程且 settled 未落盘；SIGKILL 留孤儿；重启后一律 `unknown job` |
| K9 | **出站通道**：只关闭 `session-log-deepseek`（它把整份会话日志作为 `dsh_session_log` 字段随每次 official-route 请求发往端点，本项目端点是第三方中转）；插件清单上报与 `FEEDBACK_ONLY` 遥测保持 dsh 默认 | spike 1.1 实测 12 次请求曾携带会话日志；PI 决定只关这一条 |
| K10 | **插件形态 = TypeScript + tsc 构建，pnpm workspace 多包**；profile 的 `cordis.patch.yml` 以 workspace 包说明符挂载（bundle 声明 `workspace:*` 依赖，包入口指向 `lib/`），不发 npm | 复用现有 TS 资产（Zod schema、policy-gate-core）；实测 `link:` 下相对路径解析到 profile 的 `node_modules`，无法导入；bundle 声明 workspace 依赖后可按包说明符导入 |
| K11 | **MVP 不做记忆**；首任务跑通后再评估 | dsh 无内置 memory 包；跨任务才有价值 |
| K12 | **治理四条不变式原样继承**：改物理方程/默认参数/benchmark baseline 需 PI 批；单流域指标提升 ≠ 模型改进；校准 ≠ 结构验证；删除原始数据禁止或 PI 批 | 与内核无关的领域规则 |
| K13 | **作用域规则**：任何 spike 不以首任务的一个用户可见步骤收尾就不准开；写入本 ADR 与 CLAUDE.md | 防止 M2 式失控复发 |
| K14 | **旧文档处置**：agent 出三列处置表（留 / 删 / 删-记），PI 批后执行；表见 [Doc_Disposition_2026-10-20](../../00_INDEX/Doc_Disposition_2026-10-20.md) | PI 决定"有用保留、没用删除" |
| K15 | **仓库重置机制**：同仓库 `main` 原地清理提交，历史保留，`archive/zero-v0.8.3` tag 已打；64 个 open issue 全部关闭并统一评论指向本 ADR，#132 的需求（StackLock 脏状态观测）按路径名 `git status` 语义重开普通任务；根目录删除 `SHUD.pptx`、`shud_harness_theory_to_code_addendum_zh/`、`spikes/`、`workspace/`（本迁移计划移入 docs/） | PI 决定 |

K10 revisit（2026-10-20，`m1-skeleton` design D7）：依据 `link:` 安装下的模块解析实测，将挂载方式修正为 workspace 包说明符 + bundle `workspace:*` 依赖；TS + tsc 多包、不发 npm 的决策不变。

## 需求 → dsh 机制映射（spike 实测）

| 需求 | dsh 机制 | 代码量 | 来源 |
|---|---|---|---|
| 中央策略门 | `tools/pre-execute` waterfall 返回 `deny`/`ask` + `ctx.tools.guard()` | 55 行 JS | spike 1.2 |
| PI 审批 | `ctx.approval` seam，fail-closed，`approval/asked`/`approval/decided` 落 session log，Web 卡片现成 | 0 行 | spike 1.2 |
| `data/raw` 字节保护 | 放在 workspace root 之外，`workspace-write` 模式下 Seatbelt 拒写 | 0 行 | spike 1.2 |
| Park/Resume | `ctx.jobs` + tool-jobs 完成通知自动开新 turn | 0 行（但见 K8） | spike 1.3 |
| 模型路由 | `llm-deepseek` 配置行 | 17 行 YAML | spike 1.1 |
| 角色 | agent preset + `ctx.subagents` `maxDepth` | 待 M3 | 文档 |
| 已知答案回放 | session JSONL = replay fixture | 待 M4 | 文档 |

## 后果

- **正面**：治理层回到"配置 + 薄插件"的体量；审批、沙箱、作业、回放由上游维护；spike 以 55 行 JS 取代 Zero 路线 2.9K 行策略门 + 5.7K 行沙箱包装。
- **负面（接受的债）**：产品生命周期绑定 dsh pre-stable API，每次升级是迁移任务；client 侧 UI 若日后要做，需随 pre-stable client API 漂移；dsh 不收外部 PR，seam 缺失只能用 `--patch` overlay 绕。
- **安全提示**：dsh 默认行为会把会话日志发往 official-route 端点；本项目只关该行（K9），其余出站行为保持默认，升级时需重新审视新增出站行。

## 开放项

- post-MVP UI 插件（PI 意图：设置页 / 聊天卡片 / 右侧栏面板 / 可折叠 terminal），参考实现 = dsh-team 的手写 JS client 插件路线（`window.__ModuleLoader__.load` + `requireClient('react')`，无构建）。
- JobRegistry 记录落点已由 [M2 design D2](../../../openspec/changes/m2-run-chain/design.md) 关闭：工作区 `runs/<run_id>/` 保存 RunJob/RunRecord 与日志；`stateDir` 保存活动/完成索引与锁；不采用 `ctx.storage` 域存运行记录。
- prompt cache 经 DMXAPI 是否透传未测。
- ADR-0002 D7 邮件通知：dsh 无 SMTP seam；是否保留待首任务后评估。

## Revisit 触发器

1. dsh 升级使任一 seam（`tools/pre-execute`、`ctx.approval`、`ctx.jobs`、`ctx.sandbox`、`llm-deepseek` 配置）破坏且无 overlay 可绕 → 评估钉死旧 tag 或 vendoring。
2. DMXAPI 对 Messages 协议的兼容退化 → 切 pi-ai 备胎路线。
3. 出现第二个真实用户 → K6 重议（dsh-team 实例镜像路径）。

## 附录：旧文档携带事实与 spec 更新债

- 旧文档三列处置表（K14）：[Doc_Disposition_2026-10-20](../../00_INDEX/Doc_Disposition_2026-10-20.md)，118 份在范围内：留 69 · 删 27 · 删-记 22（三份 UI 文档因 PI 已给 post-MVP UI 意图改判留）；另附 `openspec/changes/` 与根目录构建残留两节。"删-记"条目的携带事实集中在该表末节「删-记 汇总」（A 治理与不变量 / B 对象沿革 / C 执行与运维阈值 / D 测试验收 / E 度量流程），本 ADR 不复制，以该节为准；其中"任何基座必须覆盖的默认行为"（memory 不自动 verified、closure 分类器仅 advisory、bash 无内置安全）与"PI 中途介入三级语义"（append / interrupt / abort）在 dsh 下同样成立，M3 设计时逐条对账。
- 处置表执行后需同步的 spec 更新债：① ADR-0002 D3/D5/D9 标 superseded（→K5/K3）；② `03_SPEC/Minimal_Schemas.md` StackLock.llm 按 K4 改为三字段；③ `03_SPEC/Config_Secrets_And_Environment_Spec.md` `GLM_API_KEY` → `DMXAPI_KEY`；④ `00_INDEX/CANONICAL_CONTRACTS.md` 剪掉 API/WebSocket/运维注册段；⑤ 保留文件中标注"需剪掉 Zero 段"的行按表执行；⑥ `openspec/glossary.md` 残留 Zero 行随 ⑤ 一并剪掉。
- 处置表执行记录（2026-10-20，Phase 4）：①–⑥ 已执行；执行中新发现、**未修**的 spec 债：⑦ `Testing_Strategy` W0–W7 周矩阵、§12 "API 422/403" 通过标准、PI 决策测试中的 MemoryNote（与 K11 矛盾）；⑧ `Test_Fixtures_And_Command_Matrix` §5 HTML export 水印（v2 只出 Markdown）、§6 API envelope、`workspace/repos|artifacts` 路径与 Repository_Layout v2 §2 不一致；⑨ `SHUD_Output_Variables` 的 `frontend_default` 字段与"默认展示"列；⑩ `Requirements_Catalog` US-003/004/006/007、TR-007/010、IR-002/003 仍引用已删对象；⑪ `Report_Generation_Spec` 引用的 7 态水印表权威源（Report_Export_Spec）已删，需在 Report_Generation 内重建；⑫ PI 审批批注在 dsh `approval/decided` 上无字段承载（只有 `allowed-once | rejected | cancelled | unavailable`），`request_revision` 与 `rejected` 不可区分——M3 审批接线前设计；⑬ ADR-0002 D1 正文仍写 "Hono 服务"（K2 已取代，历史正文不改）。这些归 M1 开工前的 spec 清账 issue，不阻塞 reset。
- ccw fixture（2026-10-26 事实澄清）：独立 `pnpm run shud:tiny` 默认 END=30 天、串行 < 2 分钟，用于快速求解器 smoke，见 [matrix §4](../../04_IMPLEMENTATION/Test_Fixtures_And_Command_Matrix.md#4-ccw-tiny)；历史 spike 使用 END=1827 天（4m45s）。现行 `pnpm run shud:restart` 与 Epic 收口验收使用未改写的完整 `SHUD/input/ccw`（END=1827），不传 `end_days`，见 [重启验证说明](../../04_IMPLEMENTATION/Repository_Layout.md) 与 [ADR-0007](0007-m2-epic-acceptance.md)；不将独立 tiny 的 30 天设置套到重启验收，也不另行承诺完整版的 M3 fixture 归属。

## 参照

[ADR-0001](0001-agent-runtime-and-topology.md) · [ADR-0002](0002-mvp-reality-anchoring.md) ·
迁移计划 [Migration_Plan_dsh](../../Migration_Plan_dsh.md) · spike 记录 `../dsh-spike/README.md` 与 `runs/1.1–1.5/NOTES.md` ·
上游 `deepseek-ai/deepseek-harness` `docs/architecture.md`（Where new behavior goes）、`docs/subsystems/jobs.md`、`packages/jobs/jobs-local/README.md`
