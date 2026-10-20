---
status: living
created: 2026-10-20
owner: PI + agent
---

# 迁移前计划：内核切换到 DeepSeek Harness (dsh)

## 已定决策（本计划不重开）

- **内核** = DeepSeek Harness（`dsh`），钉 tag `dsh-v0.2.1-rc.2`，不追分支头。
- **运行时模型** = DeepSeek Flash，经 DMXAPI 中转，模型别名 `deepseek-flash-guan`，凭据 `DMXAPI_KEY`（本机环境变量）。
  - 首选路径：dsh 原生 `llm-deepseek` adapter，`baseURL: https://www.dmxapi.cn`（Messages 协议）。
  - 备胎：`dsh-llm-pi-ai` 手动声明 `api: openai-completions` 网关。
  - 2026-10-20 HTTP 层探针：模型列表在列；OpenAI tool-call 通；Messages 仅 `x-api-key` 通；Messages + tools + `mid-conversation-tool-changes-2026-07-01` beta 头通；SSE 流式通；`cached_tokens: 0`（缓存透传待实测）。
- 某项验证不通只走回退路径，不重议内核或模型。

## 诊断摘要（为什么重置）

- 最后提交 2026-08-03；M2 spike epic（#135）开出后 35 个提交全部落在 descriptor mediation / fd authority 证明，`packages/core/src/domain` 零提交。
- Zero 的"钩子不可否决"缺口在 ADR-0001 revisit（2026-07-10）已五条全绿转 Adopt；停摆原因是 meta-spike 失控，不是基座。
- 代码倒挂：单个测试文件 34K 行、record store 12K 行，零次真实 SHUD 运行；spec 343 篇 / 53.7K 行冻结。
- 换内核不解决上述过程问题，所以 ADR-0004 必须带作用域规则（见 2.8）。

## 需求 → dsh 机制映射

| SHUD-Harness 需求 | dsh 机制 | 剩余缺口 |
|---|---|---|
| 中央策略门 | `tools/pre-execute` waterfall `deny`/`ask` + `ctx.tools.guard()` | 无；`policy-gate-core.ts` 纯函数直接挂上 |
| PI 审批 | `ctx.approval`，fail-closed，`approval/asked`/`approval/decided` 落 session log | 无 |
| `data/raw/**` 写保护 | `ctx.sandbox`（macOS Seatbelt），`SANDBOX_UNAVAILABLE` fail-closed | 策略只有 workspaceRoot 粒度；KISS 解 = `data/raw` 放 workspace root 之外 |
| Park/Resume 数小时运行 | `ctx.jobs` 契约 + 完成通知 `followup()` 唤醒 | 内置 `jobs-local` 进程内存态；需自写 durable `JobRegistry` backend |
| 角色 | agent preset + `ctx.subagents` `maxDepth` | 无 |
| Skills | `skill/` 包组 | 无 |
| 两级记忆 | 无内置包，"section provider + tool" | 自写（Zero 原生有，此处倒退） |
| 8 治理对象持久化 | `ctx.storage` 域；模型可见部分走 session event | 领域代码 |
| Web UI | `ConversationNodeDefinition`、sidebar-right tab、settings card | 在其 React shell 内，client API pre-stable |
| 已知答案回放 / eval | session JSONL = replay fixture，`test:snapshot` | 契合首任务 |

"万物皆插件"的例外：长作业跨重启；工作区内子路径禁写；科学治理语义是领域代码；seam 缺失无法上游修（不收外部 PR），只能 `--patch` overlay。

## 上游速度与约束

| 指标 | 值 |
|---|---|
| 首发 / 最新 tag | 2026-08-13 / v0.2.1-rc.2（2026-10-17） |
| v0.2.1-alpha.1 breaking-change 条目 | 20 |
| Session 格式 | v0 → v4（8–10 月） |
| 外部 PR | 0（政策不收） |
| Cordis | vendored 4.0.0-rc.7 |
| 工具链 | Node ^22.19 / ≥24，pnpm，Vitest（per-file 100% 覆盖门） |

规则：钉 tag；每次升级 = 以 upgrade-guide 为输入的排期任务；SHUD 插件只挂 `docs/architecture.md` "Where new behavior goes" 列出的 seam，不碰 loop。

---

## Phase 0：封存现状（0.5 天）

| # | 任务 | 负责 | 状态 |
|---|---|---|---|
| 0.1 | 决定 stash `wip-before-dsh-migration`（41 处 `.omp/` 投影 + `.review-gate-issues.json`）、`feat/issue-189` 8 个未合并提交、worktree `../SHUD-Harness-issue-176`（`codex/issue-176`）的去向 | **PI 拍板** | ✅ PI 决定：stash 丢弃；两分支本地+origin 删除；worktree 移除（2026-10-20 已执行） |
| 0.2 | main 打 tag `archive/zero-v0.8.3` 并推送 | agent | ✅ 2026-10-20 已推送 |
| 0.3 | 确认 `../openMP` 可用；SHUD 本机 `make shud` + ccw 跑通 | agent | ✅ openMP 在（最后提交 2026-07-03）；SUNDIALS 在 `~/sundials`；`make shud` 7.8s 成功；`./shud ccw` 1827 天 4m45s 退出 0，30 个输出文件 268MB 于 `SHUD/output/ccw.out`（submodule 工作区保持干净）。ccw 是 spike 1.3 的合适 fixture：分钟级，够测 kill/restart |
| 0.4 | pnpm 就位；clone dsh 钉 tag 到 `../deepseek-harness`；`pnpm install && pnpm run build` 计时；`dsh --profile web --dump-config` | agent | ✅ pnpm（brew）在；浅 clone 14s / 205MB；`pnpm install --frozen-lockfile` 2m48s；`pnpm run build` 1m08s；node_modules 2.0GB；`dump-config` 0.6s 出 299 行插件树（存 scratchpad `dsh-dump-config.yml`）。树中可见 `llm-deepseek`（id）/`llm-pi-ai`/`sandbox-local`/`jobs-local`/`user-approval`，以及 `session-telemetry-otel`、`desktop-product-telemetry` 两条遥测行（供 1.5） |

## Phase 1：可行性 spike（3–5 天硬截止）

spike 放在仓库外，不开 openspec change / issue / PR。每项记录：行数、碰到的 pre-stable API 数、耗时。

| # | 验证项 | 通过标准 | 回退 | 时限 |
|---|---|---|---|---|
| 1.1 | 原生 `llm-deepseek` → DMXAPI，headless 多步 tool-calling | thinking signature 回放无错；`systemPromptUpdate: in-history` 可用或经显式 `models` 条目关掉后可用 | pi-ai `openai-completions` | 0.5 天 → **✅ 2026-10-20 通过**（~1h）：run A 5 tool_call 9.7s；run B `--session-id` 续跑 4 tool_call 9.5s；11 条 assistant/message 全带 signature，0 replay 降级；in-history 成立（system/message 仅 1 节点）。overlay 仅配置行、0 行代码。记录在 `../dsh-spike/runs/1.1/`。**附带发现（归 1.5）**：`session-log-deepseek` 把完整 session log 作为 `dsh_session_log` 字段附在每次 official-route 请求里发往端点（本例即 DMXAPI），`plugin-package-inventory-deepseek` 附插件清单；两者已在 overlay 关闭 |
| 1.2 | `tools/pre-execute` 拒绝 bash 写 `data/raw`；`ask` 往返 Web 审批 | 拒绝落 `tool/result`；审批产生 `approval/asked`/`approval/decided` | `data/raw` 移出 workspace root | 1 天 → **✅ 2026-10-20 通过**（~1.5h）：55 行 JS 插件经文件路径 `insert` 挂载；headless 5 探针全符合预期；根外 `data/raw` 由 seatbelt 守住字节（md5 不变）；Web 审批卡片显示插件文案与原命令，Allow once → `approval/decided: allowed-once` → 工具执行。取代 Zero 路线 2.9K 行 `policy-gate-registry` + 5.7K 行 `raw-data-sandbox` |
| 1.3 | `shud_run` 注册 `ctx.jobs` 作业跑 ccw；完成唤醒；中途 kill dsh 重启 | 唤醒成立；重启后明确丢了什么 | 产出 durable `JobRegistry` backend 工作量估算 | 1.5 天 → **✅ 2026-10-20**（~25min，0 行代码，直接用 bash `run_in_background`）：ccw 4m45s 完成 → `job/settled` → agent 自动 turn 2 唤醒汇报。SIGTERM 关停：shud 子进程被杀、`job/settled` 未落盘、重启后 `job_list` 空 / `unknown job`；SIGKILL：shud 成孤儿继续跑（PPID=1），registry 同样失忆。**结论：小时级运行必须自写 durable JobRegistry backend，需同时做 detach 与启动时 pid 对账（估 300–500 行，M3 核心）**。见 `../dsh-spike/runs/1.3/` |
| 1.4 | 自定义聊天卡片渲染 RunRecord 摘要 | Web client 可见；记录 client API 触点数 | MVP 不做 UI，headless + 报告文件 | 0.5 天 → **调研结论，未实作**（~20min）：必须是 monorepo 内 workspace React 包 + tsdown 构建（`tool.call.toolview` slot）；npm 上 client 包停在 0.0.1-rc.1 无法外置；估 150–250 行 + 半天样板。**建议 MVP 不做（grill 2.2 决）；PI 要看实物可追加半天** |
| 1.5 | 遥测与启动开销 | 搞清默认上报项与关闭方式；冷启动计时 | 配置关闭；关不掉则 overlay | 0.5 天 → **✅**：三条默认出站行 `session-log-deepseek`（整份会话日志随每次 official-route 请求发往端点，本例即 DMXAPI）、`plugin-package-inventory-deepseek`、`session-telemetry-otel`（OTLP → deepseeksvc.com，FEEDBACK_ONLY）均 overlay 关闭并验证；headless 冷启动 ≈ 2s，web 就绪 < 8s，RSS ≈ 244MB |

## Phase 2：grill（1 次会话）

| # | 问题 | 推荐 | 负责 |
|---|---|---|---|
| 2.1 | 产品形态 = `dsh --profile shud`，Hono 后端退场 | 接受 | **PI** |
| 2.2 | MVP 自定义 Web UI vs headless + ACP + Markdown 报告 | 看 1.4 数据；默认不做 | **PI** |
| 2.3 | 两级记忆进 MVP？ | 首任务之后 | **PI** |
| 2.4 | 03_SPEC 冻结为 archive tag 下素材库，新 living spec 一页 | 是 | **PI** |
| 2.5 | 首任务：openMP RHS 回放 vs 先"ccw 运行 + 报告" | 先小任务，回放第二 | **PI** |
| 2.6 | 升级节奏：钉 tag + 固定间隔 + upgrade-guide 驱动 | 接受 | PI |
| 2.7 | `StackLock.llm` 锁三字段：base_url、请求别名、响应 `model` | 批准 | PI |
| 2.8 | 作用域规则入 ADR：spike 不以首任务用户可见步骤收尾不准开 | 批准 | PI |

## Phase 3：重写文档（1–2 天）

新增 3.0：旧文档三列处置表（ADR-0004 K14），agent 出表 PI 批 → `docs/00_INDEX/Doc_Disposition_2026-10-20.md`。✅ 提案已出（118 份：留 69 / 删 27 / 删-记 22，含 UI 三份改判留的例外；另附 openspec/changes 与根目录残留两节），待 PI 批后在 Phase 4 执行删除与"剪 Zero 段"。

| # | 交付物 | 负责 |
|---|---|---|
| 3.1 | ADR-0004：内核 = dsh，取代 ADR-0001 基座前提与 ADR-0002 D3/D5/D9；含 K1–K15 | agent 起草，PI 批 | ✅ 草稿 `docs/adr/0004-dsh-kernel.md`，待 PI 批 |
| 3.2 | Phased_Plan v2（一页） | agent | ✅ M1–M6 重切，首任务锚定 |
| 3.3 | Repository_Layout v2（profile / bundle / `dsh-shud-*`） | agent | ✅ |
| 3.4 | 从 `instructions/agents/` 重新生成 CLAUDE.md / AGENTS.md | agent | ✅ shared.md 改后按原 header 拼接再生成 |
| 3.5 | glossary 增补：profile、bundle、seam、waterfall、preset | agent | ✅ §10 新增 11 条；策略门/JobRegistry 两条改写 |
| 3.6 | 移植清单：8 对象 Zod schema、`policy-gate-core.ts`、治理不变式与提示词措辞规则 | agent | ✅ `docs/04_IMPLEMENTATION/Port_List.md` |

## Phase 4：执行 reset（0.5 天，PI 确认后才动）✅ 2026-10-20

| # | 任务 | 负责 | 结果 |
|---|---|---|---|
| 4.1 | 同仓库 `main` 原地清理提交（PI 已定，K15） | agent | ✅ 五个提交：`cf860cc2`（phase3）→ `1cbdcae1` → `2b565bce` → `59659d39` → `50f470a5`；未 push |
| 4.2 | 移除 `zero` submodule；保留 SHUD / rSHUD / AutoSHUD | agent | ✅ `1cbdcae1` |
| 4.3 | 关闭 epic #85、#135 及子 issue，评论指向 ADR-0004；#132 原始需求按路径名 `git status` 语义重开普通任务 | agent，PI 确认范围 | ✅ 64 个 issue 全部 closed（not planned，统一评论）；PR #130 关闭并删分支；#132 → **#199**（label m3）|
| 4.4 | 根目录清理：`SHUD.pptx`、`shud_harness_theory_to_code_addendum_zh`、`spikes/`、`workspace/`；加 `openspec/changes/m1-*`、`m2-*` 与 Bun/GLM 构建残留（处置表末两节） | PI 决定，agent 执行 | ✅ `1cbdcae1`；**表外追加** `.workplans/`（421 个 Zero 时代 issue 工作计划文件）单独提交 `2b565bce`，可一行 revert |
| 4.5 | 搭 dsh 插件 monorepo 骨架，搬入 3.6 清单 | agent | ✅ `50f470a5`：pnpm workspace + `packages/dsh-shud-core`（92 测试绿）+ `profile/shud` + CI；移植细节与漂移记录见 Port_List |
| 4.6 | 处置表执行（47 删 + 26 剪 + spec 债 ①–⑥） | agent | ✅ `59659d39`；link check 0 断链；新发现未修的债 ⑦–⑬ 记入 ADR-0004 附录 |

依赖链：0.3 → 1.3；1.x → 2；2 → 3；3.1 批准 → 4。Phase 1 到期未完也进 grill。

## 日志

- 2026-10-20 计划建立；已切回 main，本地改动入 stash。
- 2026-10-20 Phase 0 全部完成（0.1 PI 决定：stash 丢弃、两 spike 分支本地+origin 删除、worktree 移除）。注意：`.omp/` 下的改动由 OMP 运行时在会话启动时自动重投影（08:45 时间戳），不是 WIP，不要手工处理。注意：`/workspace/` 在 `.gitignore:32`，本计划文件目前不进 git，是否纳入版本随 Phase 4.4 决定。
- 2026-10-20 `.omp/` 加入 `.gitignore` 并从索引移除（main 提交 31002cac，未推送）。
- 2026-10-20 Phase 1 spike 完成（约 3.5h，远少于 3–5 天预算）：1.1/1.2/1.3/1.5 通过，1.4 仅调研。spike 仓库 `../dsh-spike`（commit ec9b812）：`overlays/`（模型路由 + 遥测关闭 + 插件挂载）、`plugins/shud-raw-guard/`（55 行）、`runs/1.1–1.5/NOTES.md`。总代码量 55 行 JS + 约 30 行 YAML。
- 进入 Phase 2 grill 的新增议题：(a) `session-log-deepseek` 默认把整份会话日志发往 LLM 端点，SHUD profile 必须固化关闭并写入 ADR；(b) durable JobRegistry backend 是 M3 核心交付（1.3 实测重启即失忆）；(c) 1.4 是否补做实物。
- 2026-10-20 Phase 2 grill 完成，PI 确认共同理解。决策：profile+插件形态、不做多用户（D6 维持）、首任务 = ccw 运行→RunRecord→报告、MVP 零自定义 UI、durable JobRegistry 替换全部 jobs-local（M3 核心）、旧 spec 三列处置表 PI 批、钉 dsh-v0.2.1-rc.2 每里程碑评估升级、只关 session-log-deepseek、TS+tsc 多包、MVP 不做记忆、2.7/2.8/治理四条入 ADR、别名漂移不自动失效 lock、reset = main 原地清理、64 个 issue 全关、根目录删 SHUD.pptx/theory 附录/spikes/workspace。开放项：post-MVP UI 四类（设置页/聊天卡片/右侧栏/可折叠 terminal，参考 dsh-team 手写 JS client 插件）、JobRegistry 落点、prompt cache 透传。
- 2026-10-20 Phase 3 文档全部起草完毕（未提交，待 PI 审）：ADR-0004（K1–K15 + 附录）、Phased_Plan v2（M1–M6）、Repository_Layout v2、Port_List、glossary §10、CLAUDE/AGENTS 再生成、处置表提案、ADR-0001/0002 取代记录。
- 2026-10-20 advisor 复核后修正：UI 三份文档改判留（PI 已给 post-MVP 意图）；处置表补 openspec/changes 与根目录残留；ADR-0004 状态改 proposed（决策已定、文本待审）；Phased_Plan 加 M 编号对照说明。
- 2026-10-20 PI 批准 ADR-0004 与处置表（accepted / approved），Phase 3 以 `docs(phase3)` 提交；开始 Phase 4。
- 2026-10-20 Phase 4 完成（见上表）。纠偏记录：处置表把 `Phased_Plan.md`/`Repository_Layout.md` 标为 删-记/删（针对 HEAD Zero 内容），机械执行时误删了 v2 版，子代理发现后已 restore，实际删除 47 份；`pnpm` 对 profile 的 `@deepseek-ai/dsh` peer 会自动从 npm 拉整个 dsh（579MB），已以 `autoInstallPeers: false` 关闭。最终树 `pnpm run check` 全绿（typecheck + 92 vitest + schema drift + 300 文件 link check）。
- 2026-10-20 PI 批准 push：main 7 个提交推到 origin（`4be2ea89..9f61792a`），首个 pnpm 版 CI run 39444257050 success。spec 清账 issue = #200（⑦–⑬ + 顺带两项）；#132 继任 = #199。`openspec/project-profile.md` 重写为 dsh 版（subagent-workflow Phase 0.5 的输入）。 冒烟：`--profile headless --patch profile/shud/cordis.patch.yml --dump-config` 通过，配置里 `agent-default-model = deepseek-flash-guan`、`llm-deepseek.baseURL = https://www.dmxapi.cn`、`session-log-deepseek.disabled = true`。
- **M1 入口**：设计输入 = `04_IMPLEMENTATION/Phased_Plan.md` §1 + `Repository_Layout.md` + `Port_List.md` + ADR-0004 K2/K9/K10；走 `stage-change-pipeline`（grill 凭证可引用 Phase 2 已拍板分支，缺口才补问）→ OpenSpec change `m1-skeleton` → issue；M1 验收门见 Phased_Plan §0 表。前置：#200 可与 M1 代码并行，不阻塞。
