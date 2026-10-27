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
| 3.1 | ADR-0004：内核 = dsh，取代 ADR-0001 基座前提与 ADR-0002 D3/D5/D9；含 K1–K15 | agent 起草，PI 批 | ✅ 草稿 `docs/adr/implemented/0004-dsh-kernel.md`，待 PI 批 |
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
- 2026-10-20 #200 spec 清账：⑦–⑬ 全部执行（PR 见 issue）。顺带项：提交计数行已在前一轮改写；`.agents/skills/shud-gov/` 是项目本地 skill（无 pack 上游），其 `zero-seam-guard` 维度已失效——决定：M1 首个插件包落地时改写为 `dsh-seam-guard`（patterns `packages/dsh-shud-*/**`、`profile/**`，keywords `tools/pre-execute`、`ctx.jobs`、`ctx.approval`），在此之前不运行该维度。
- 2026-10-20 shud-gov 降级完成：skill 目录删除（`.agents/skills/shud-gov/`，本地 `.claude` 投影同删）；保留的领域事实落为 `01_CODEBASE/SHUD_IO_Facts.md`、`01_CODEBASE/rSHUD_AutoSHUD_Quirks.md`，spec 缺口登记为 `03_SPEC/Spec_Gaps_Register.md`（去掉 K2 失效的 GAP-07/08、RACE-02），Park/Resume 审查清单按 `ctx.jobs` 重写入 `Park_Resume_Design.md` 附录 A；zero-seam-guard 维度、三个 checks 脚本与 zero-patterns.md 不搬。project-profile 风险包指向这些文件。
- 2026-10-20 eng-init（L3 strict，bootstrap）装好 repo 控制面：`AGENTS.md`/`CLAUDE.md` 由 `instructions/agents/` 经 `pnpm run instructions:render` 生成（CI 比对）、新增 `CONTEXT.md` 与 `constraints.yaml`（阈值/基线/校验镜像单源）；闸 = eslint(type-aware, max-lines 1000) + prettier + jscpd ≤3% + knip + naming guard + gitleaks + semgrep(CI) + coverage ≥80% + PR ≤400 行（`size-exempt` label 记录）+ commitlint，本机 git 钩子 `.git-hooks/` + agent `no-bypass` hook；CI 重写为风险分层 + `all-checks-passed` 聚合，分支保护只要求该检查并要求 PR（0 approvals）；`docs/adr/` 升级四区（0001–0004 迁入 `implemented/`，`pnpm run adr:check`）；运行时自检 `profile:smoke`/`shud:tiny`（本机，CI 无 dsh/SHUD）；闸自证 `pnpm run test-guardrails`。Q1.4b 冻结基线：3 个 >1000 行文件、7 条 type-safety finding、1 个 knip 重复导出别名（棘轮 M2/M3，见 `constraints.yaml` baseline）。gitleaks 历史扫描命中 68 条，全部为已删 Zero spike fixture（`spikes/git-status-capability/contracts/fixtures/`）的 64-hex 契约 token，经 `.gitleaks.toml` 路径白名单排除——PI 确认非真实凭据；若是，历史重写另议。
- **M1 入口**：设计输入 = `04_IMPLEMENTATION/Phased_Plan.md` §1 + `Repository_Layout.md` + `Port_List.md` + ADR-0004 K2/K9/K10；走 `stage-change-pipeline`（grill 凭证可引用 Phase 2 已拍板分支，缺口才补问）→ OpenSpec change `m1-skeleton` → issue；M1 验收门见 Phased_Plan §0 表。前置：#200 可与 M1 代码并行，不阻塞。
- 2026-10-20 M1 开工：OpenSpec change [`m1-skeleton`](../openspec/changes/archive/2026-10-21-m1-skeleton/proposal.md)，Epic [#210](https://github.com/DankerMu/SHUD-Harness/issues/210)。K10 挂载口径按实测修正为 workspace 包说明符（bundle 声明依赖并经 `link:` 安装）；文字传播由 #217 完成。本条记录开工而非完成，手工 Web 审批往返与 raw md5 证据由 #223 验收后追加。
- 2026-10-21 M1 工程集成：PI 在本会话确认“测试通过，继续”。#211–#222 的工程与文档切片已逐 PR 合并；最终 [CI 39542343267](https://github.com/DankerMu/SHUD-Harness/actions/runs/39542343267) 的 `profile-smoke` 与 `all-checks-passed` 均成功。真实 `deepseek-flash-guan` 五探针正例全绿、两份 raw md5 不变；禁用插件负例正确失败，证据见 [#235](https://github.com/DankerMu/SHUD-Harness/pull/235)、[#236](https://github.com/DankerMu/SHUD-Harness/pull/236)。手工验收结论已接受；[#223](https://github.com/DankerMu/SHUD-Harness/issues/223) 的真实 session log 路径与审批/拒写摘录随后补采，见下节「M1 手工 Web 验收证据」；实际 Web 启动参数为 `--profile shud --no-open --port <p>`，不再追加 `web` 位置参数。

- 2026-10-21 M1 收口复审：三项验收门独立重跑全绿后，白盒复审在 raw-guard 决策核发现 shell 文本判定比规范窄（glob/brace 绕过、`/bin/rm` 等落 ask），立 [#245](https://github.com/DankerMu/SHUD-Harness/issues/245) 并以 PR [#246](https://github.com/DankerMu/SHUD-Harness/pull/246) 修复（OpenSpec change `raw-guard-shell-boundary`，已归档）；三轮跨审 + PI 批准一次 fix-pass extend。存量缺口另立 [#247](https://github.com/DankerMu/SHUD-Harness/issues/247)（非字面路径拼写）、[#248](https://github.com/DankerMu/SHUD-Harness/issues/248)（`2>/dev/null` 重定向误报）。Epic #210 不重开。

- 2026-10-22 M1→M2 边界 dsh 升级评估（#295，Phased_Plan §6）：执行 `env -u ALL_PROXY npm view @deepseek-ai/dsh dist-tags --json`，npm `latest` 与 `next` 均为 `0.2.1-rc.2`（`alpha` 为 `0.2.1-alpha.5`），与当前钉版一致；`git -C ../deepseek-harness describe --tags --exact-match HEAD` 返回 `dsh-v0.2.1-rc.2`。只读检查该 checkout 的 `docs/upgrade-guide/`，只有 `v0.1.7-rc.2`、`v0.2.0-rc.2` 与 `v0.2.1-alpha.1`–`alpha.4`，无 rc.2 之后条目，因而没有可评估的新版本 seam 迁移说明。结论：跳过升级，保持钉版与依赖不变；未运行升级后的回归探针。真正升级时仍须核对 `jobs`、`jobs-local`、`tool-jobs`、`api/session-controller`、`storage`、session 恢复及 ADR-0006 要求的 `dsh-llm`/`dsh-scope` 变更。#233 保持 open：本次未重跑 stock Web 与 shud 的 schema 投影对照，不宣称其 carrier projection error 已解决，待真正升级时复核。

- 2026-10-26 钉版 schema 投影复核（[#233](https://github.com/DankerMu/SHUD-Harness/issues/233)，非宿主升级）：dsh `dsh-v0.2.1-rc.2` / `687f282e8625c6b8d11ff58211a90524be2e4317`。在两个新建的独立 `DSH_HOME` 中分别创建无 SHUD 的 stock Web 与经 `profile:install` 安装的 shud；均执行 `node <host>/apps/cli/lib/bin.js --profile <name> --dump-config-schema`，均为 exit 1 / `x-cordis.complete=false`。四个 `preset-standard` / `preset-ptc` / `preset-minimal` / `preset-cordis` 在两侧均为 `status: schema`。完整 diagnostics 对比：stock 的 8 条在 SHUD 中逐项、顺序、路径完全相同（4 warning：`/115,/122,/123,/153`；4 carrier error：`/186,/187,/188,/189`）；SHUD 仅新增 `/191` 的 `Config is not a native Schemastery schema`（`shud-jobs: unsupported`），共 9 条。基线无 shud 行；SHUD 无 `status: error` entry，raw-guard/tools 均为 `absent`。carrier projection error 在此钉版仍存在，决定维持 `profile-smoke.sh` 的受限 exit 1 + incomplete 例外、可见 diagnostics 和独立插件导入校验，不改脚本/spec，不要求 raw-guard `complete=true`。以后 carrier 修复也须独立评估 SHUD 的 StandardSchema 限制，不能仅据 carrier 消失收紧 exit。证据保存在本机 `.workplans/issue-233/` 的两份完整 schema JSON、stderr、`version.json`、`diagnostics-diff.json` 与 `assessment.md`，公开摘要见关联 issue/PR；临时 profile 已删除，无密钥传播、求解器/LLM 执行或运行时挂载验证。

- 2026-10-27 M2→M3 边界 dsh 升级评估（[#420](https://github.com/DankerMu/SHUD-Harness/issues/420)，Phased_Plan §6）：执行 `env -u ALL_PROXY npm view @deepseek-ai/dsh dist-tags --json`，`latest` 为 `0.2.1-rc.2`、`next` 为 `0.2.1-rc.4`（`alpha` 为 `0.2.1-alpha.5`）；npm 发布时间 rc.3 2026-10-23、rc.4 2026-10-26。上游 GitHub（`gh api`，默认分支 `master`）release/tag 只到 `dsh-v0.2.1-rc.3`，`docs/upgrade-guide/` 只有 `v0.2.1-rc.3/independent-session-forks`（普通 Session fork 不再记录 `parentSession`、不显示为子代理；旧 V4 reader 可能拒绝含继承投递确认的无父 fork），无 rc.4 目录；本评估不触碰 `../deepseek-harness` checkout。rc.2→rc.3 六个提交中，源码改动只在 `packages/llm/llm-deepseek`（API-key 路由跟随官方 `/models` 列表）与 `packages/api/session-controller/src/client/sessions/service.ts` 一行；approval、core/tools、preset、jobs、subagent 源码无改动。以 `npm pack` 取 rc.2 与 rc.4 的 `dsh-user-approval`、`dsh-tools`、`dsh-jobs`、`dsh-jobs-local`、`dsh-llm`、`dsh-scope`、`dsh-agent-preset`、`dsh-api-session-controller`、`dsh-web-app`、`dsh-headless`、`dsh-app-boot`、`dsh` 逐字节 `diff -rq`（排除 package.json/README/locale）：前六者与 `dsh-headless`、`dsh-app-boot`、`dsh` 完全相同；`dsh-llm-deepseek` 仅新增 `isBuiltInCatalog` 与 listing cache，`message_start` 处理未变，响应 model 仍被丢弃（M2 design D10 的 `response_model_source: configured` 继续成立）；`dsh-agent-preset` 仅 skill 参考表多一行；`dsh-web-app` 的 `cordis.patch.yml` 仅新增 UI 行 `entry-customization`；`dsh-api-session-controller` 仅一行注释。ADR-0006 要求核对的 `dsh-llm`、`dsh-scope`、`dsh-jobs`、`dsh-jobs-local` 均无变化。结论：跳过升级，保持钉 `0.2.1-rc.2` 与依赖不变；rc.4 不解决 M3 两项挂在升级上的设计问题——`approval/decided` 仍只有 `{id, outcome}`、无 PI comment 字段（ADR-0004 附录 ⑫，`PI_Decision_Comments_Spec.md` §7），响应 model 仍不可得——M3 设计按 rc.2 事实冻结。真正升级时须复核：rc.3 的 `independent-session-forks` 对 `shud-jobs` 唤醒路径（`sessionController.resolveAgent(owner_session)`，不依赖 fork 来源关系）的影响，以及上游 `master` 相对 rc.3 已有 1533 提交（含 `refactor(approval): persist policy and turn state in projection (#6816)`），属未来 rc。#233：`dsh-app-boot` rc.2 与 rc.4 逐字节相同，carrier projection error 在 rc.4 不可能消失；本次未重跑 `--dump-config-schema` 对照，`profile-smoke.sh` 例外维持。未运行升级后回归探针。本机证据（dist-tags、tarball shasum、逐包 diff 输出）在 `.workplans/m3-mvp-1/dsh-upgrade-eval-evidence.md`，不入库。

### M1 手工 Web 验收证据（2026-10-21，#223）

PI 选择补采一次真实 Web 会话并亲自在审批卡点击“允许一次”；下列记录补齐上条工程集成日志中的证据缺口。使用持久 `DSH_HOME=/Users/danker/.dsh` 的 `shud` Web profile，模型为 `deepseek-flash-guan`（DMXAPI，key 仅由环境变量提供）。通过宿主现有 workspace API 登记合成工作区，不改宿主代码或 profile 配置；agent 未代批审批。

- 工作区：`/Users/danker/.shud-acceptance-ob3hziek/work`；raw 样本：`data/raw/obs.csv`。
- Session：`session-6cc096e4-2c08-4574-9e26-efa787a45170`。
- 原始日志：`/Users/danker/.dsh/sessions/--Users-danker-.shud-acceptance-ob3hziek-work--/session-6cc096e4-2c08-4574-9e26-efa787a45170/session.v4.jsonl.zstd`。逐帧解压后按 `seq`、approval id 与 tool call id 关联；不以模型回复判定。
- raw MD5：运行前与完成后均为 `406a4b65e6edef2cae087755117da2b9`。

读 raw：seq 18 的 bash 调用执行 `cat data/raw/obs.csv`；以下为同一请求的实际日志字段摘录：

```jsonl
{"seq":19,"type":"approval/asked","data":{"id":"680a9abf-e78b-4647-bc1d-8653ebbf6262","toolName":"bash","callId":"call_00_ye1uq1WaB4A7qvpyM1Mp7560","reason":"Reading raw data requires PI approval (provenance rule)."}}
{"seq":20,"type":"approval/decided","data":{"id":"680a9abf-e78b-4647-bc1d-8653ebbf6262","outcome":"allowed-once"}}
{"seq":23,"type":"tool/result","data":{"message":{"toolCallId":"call_00_ye1uq1WaB4A7qvpyM1Mp7560","isError":false,"content":[{"type":"text","text":"date,q\n2020-01-01,1.5\n2020-01-02,1.7\n"}]}}}
```

写 raw：同一会话 seq 27 调用 `write` 尝试把样本的 `1.5` 改为 `9.9`，seq 28 被拒；从该 write 调用到 seq 33 的 `turn/end` 没有新的 `approval/asked`，文件字节不变：

```jsonl
{"seq":28,"type":"tool/result","data":{"message":{"toolCallId":"call_00_Nii7WoUPoOksK91x29ht0502","isError":true,"content":[{"type":"text","text":"Error: Raw data is immutable. Use the read tool to read raw data; write derived data in the workspace."}]}}}
```

两个场景及 MD5 对照均通过；该证据仅用于 M1 的手工 Web 审批往返，不扩张为通用 raw 数据安全证明。

### M1 收口修复的 PI 功能验收（2026-10-22）

Epic #210 关闭后，M1 收口复审又合并了 13 个修复（#247 #248 #251 #255 #260 #263 #266 #273 #277 #279 #283 与 StackLock 的 #199、#264）。ADR-0005 只覆盖 Epic #210，这批修复的 PI 功能验收在此补做；PI 结论：「已全部完成，通过」。

自动闸（main `ac5f9bbf`）：`pnpm run check` 892 passed；`profile:smoke` OK；`raw-guard:probes` 两次 T1–T5 PASS、md5 不变；`shud:tiny` exit 0（22 个 `.dat`）。

Web 往返：独立 `DSH_HOME=/Users/danker/.shud-acceptance-m1fix-20261022/dsh-home`，`shud` Web profile，模型 `deepseek-flash-guan`（DMXAPI，key 仅由环境变量提供）；合成工作区 `/Users/danker/Documents/shud-acceptance-m1fix-20261022/work`（默认 `rawDirs`）。PI 亲自点击审批卡，agent 未代批。Session `session-c08fa6b1-6335-4f36-8ae7-41a8238515d0`，原始日志 `/Users/danker/.shud-acceptance-m1fix-20261022/dsh-home/sessions/--Users-danker-Documents-shud-acceptance-m1fix-20261022-work--/session-c08fa6b1-6335-4f36-8ae7-41a8238515d0/session.v4.jsonl.zstd`，逐帧解压后按 `seq` 与 tool call id 关联：

| 命令 | 对应 | 日志（seq） | 结果 |
|---|---|---|---|
| `cat data/raw/obs.csv` | 基线 | 19 asked → 20 allowed-once → 23 | 返回 3 行样本 |
| `echo bad >> data/raw/obs.csv` | 基线 | 35 → 36，无 asked | `Raw data is immutable` |
| `head data/raw/obs.csv 2>/dev/null` | #248 | 49 asked → 50 allowed-once → 53 | 返回样本 |
| `cat ./data/raw/obs.csv` | #247 | 66 asked → 67 allowed-once → 70 | 返回样本 |
| `ls data` | #273 | 82 → 85，无 asked | 输出 `raw` |
| `tar -tf data/raw/a.tar` | #279 | 98 asked → 99 allowed-once → 102 | 输出 `notes.txt` |
| `tar -cf out/raw-copy.tar data/raw` | #283 | 115 asked → 116 allowed-once → 119 | 归档写到 `out/` |
| `tar -cf data/raw/new.tar notes.txt` | #283 | 138 → 139，无 asked | `Raw data is immutable` |
| `tar -xf data/raw/a.tar -C out` | #279 | 151 → 152，无 asked | `Raw data is immutable` |
| `rm -rf data` | #273 | 164 → 165，无 asked | 祖先目录拒绝文案 |

raw MD5 前后一致：`obs.csv` `406a4b65e6edef2cae087755117da2b9`，`a.tar` `b44f2949186b04ea191dca76e0445468`；`data/raw/new.tar` 不存在，`out/` 下无解包产物。PI 通过即接受：raw 内归档用 bash 解包（`tar -xf <raw>/a.tar -C work`）直接拒绝、无审批通道（#279 起）。宿主 Web 启动时自动选中 Documents 下的默认工作区而非进程 cwd，验收会话须在界面中选定合成工作区后新建；默认工作区内的两次试跑不计入证据。该证据只覆盖上表场景，不扩张为通用 raw 数据安全证明。

### M2 spike：m2-run-chain O1–O6（2026-10-22，#294）

回答 [`m2-run-chain`](../openspec/changes/archive/2026-10-27-m2-run-chain/design.md) 的 Open Questions（task 1.1），约 1.5h（含两次 ccw）。spike 仓库 `../dsh-spike` commit `2218e45`：一次性插件 `plugins/shud-spike-m2/jobs.js`（`LocalJobRegistry` 子类，308 行 JS）与 `tools.js`（宿主层工具行 `shud_run_spike`、`spike_probe`，71 行），overlay `overlays/m2.patch.yml`，证据 `runs/m2/`（`NOTES.md` 为逐项记录，注册表事件 `state/probe.log`）。宿主 `dsh-v0.2.1-rc.2` 只读未改；`DSH_HOME=../dsh-spike/home`，`pnpm run profile:install` 建 `shud` Web profile 后叠加 `--patch overlays/m2.patch.yml`（`session-log-deepseek` 仍 `disabled: true`，`runs/m2/dump-config.yml:22-24`）；模型 `deepseek-flash-guan`（DMXAPI，key 仅由环境变量提供）。宿主路径相对 `../deepseek-harness/`。

会话日志在 `../dsh-spike/home/sessions/--Users-danker-Desktop-Hydro-SHUD-dsh-spike-runs-m2-work-ws--/<id>/session.v4.jsonl.zstd`（gitignored），紧凑视图已提交为 `runs/m2/session-S1.txt`、`session-S2-no-jobs.txt`、`session-S3.txt`：S1 `session-1f6f37f6-a2a4-438f-b34d-6c9a20351de3`（standard preset）、S2 `session-258102d3-993a-4a10-90ca-83263f3e5a0b`（overlay 新增的无 `tool-jobs` preset `no-jobs`）、S3 `session-2a1fb198-3242-4f12-95cc-bc6e1dd14cb7`（standard，重启后建）。

| 问题 | 命令 / 会话证据 | 宿主源码 | 结论 |
|---|---|---|---|
| O1 kill 与 teardown 可否区分 | S1 seq 45–47 模型 `job_kill`；`POST /api/job/kill`（Web 作业卡端点，以 S2 身份）；`kill -TERM` 宿主；`state/probe.log` 的 `cancel` 事件 | `packages/jobs/jobs-local/src/index.ts:332-334`、`:484-494`、`:674-677`、`:694-713`；`packages/jobs/tool-jobs/src/index.ts:377`、`:403`（`reason` 为模型自由文本）；`packages/api/job-controller/src/index.ts:125` | 能。覆写 `kill` 置一次性标记：模型 kill 与作业卡 kill 均 `marked:true`，SIGTERM 为 `marked:false` + `'jobs service disposed'`；teardown 在 `cancel` 内同步结束 `done`，宿主约 2s 退出。理由字符串可被模型伪造，不作判据 |
| O2 detached 包装进程活过 SIGTERM/SIGKILL | `runs/m2/restart-sigterm.txt`、`restart-sigkill.txt`（`ps -o pid,ppid,pgid,stat,etime`） | `apps/cli/src/profile-boot.ts:304-310`；`packages/subprocess/subprocess-local/src/spawn.ts:74-79`（只终止 `ctx.subprocess` 进程树） | 能。`spawn('/bin/sh', …, { detached: true })` + `unref()` 的 wrapper 自成进程组，宿主退出后 PPID→1，shud 子进程持续 `R` 至写出 `exit_code` |
| O3 脚本重启 Web 并经 HTTP 恢复同一会话 | 下方命令；S1 seq 131、163 唤醒消息（`source.kind: shud-spike`）→ turn 9、12 自动汇报；重启后 HTTP 再问 S1（seq 140–141） | `packages/client/connection/src/browser-auth.ts:314-348`（`/connect`）、`client/rpc.ts:39-56`（请求信封）；`packages/api/session-controller/src/index.ts:300-302`、`:461` | 能。每次重启 token 变化须重新 `/connect`；唤醒由新进程的注册表 `resolveAgent` 冷恢复会话投递，无需浏览器 |
| O4 响应体 model / 已配置 model | S1 seq 17–19 `spike_probe`；`runs/m2/o4-wire.out`（DMXAPI 对请求 `deepseek-flash-guan` 的 `message_start.message.model` 为 `deepseek/deepseek-flash`） | `packages/llm/llm-deepseek/src/translate.ts:110-115`（丢弃 `message.model`）；`packages/core/agent-loop/src/agent.ts:529-535`（`source.model` 取 `request.model`）；`packages/core/session/src/index.ts:912` | 响应体 model 在任何插件 seam 不可得；已配置 model 可得（`requestHeader().config.model`、`agent.options.model`、发起调用的 assistant `source.model` 三者均为 `deepseek-flash-guan`）。未触发停止条件 |
| O5(a) 瞬时全局控制器 | `probe.log` 的 `o5a` 事件（每次登记含重启接管各一条）；S2 seq 17、30 与 S1 seq 91/98 | `packages/jobs/jobs-local/src/index.ts:207-210`、`:346-354`、`:382-386`；`vendor/cordis/src/utils.ts:176`（服务代理的 `ctx` 是调用方上下文） | 可行。须以构造时保存的原始实例调 `LocalJobRegistry.prototype.attachController`；挂载前/释放后无 owner `start` 均抛 `no job controller serves this agent`，挂载中成功；无 `tool-jobs` 的 preset 在多次瞬时挂载前后有 owner 启动均被拒，standard preset 照常登记 bash 作业 |
| O5(b) preset `tool-jobs` 与作业卡可见并可 kill | S1 seq 35–47 `job_list`/`job_output`/`job_kill`；S3 重启后 `job_list` 列出接管登记；`job/kill` 以 S2 身份 kill S1 的作业 | `packages/jobs/jobs-local/src/index.ts:310-314`、`:410-414`、`:448-449`；`packages/api/job-controller/src/rows.ts:42`、`:48` | 能。作业卡列表侧未开浏览器，以源码与 `job_list` 为证；shud 作业不产生 `job/*` 会话事件 |
| O5(c) 宿主层工具行对 preset Agent 可见 | S1 seq 17–19、30–32 | `packages/core/tools/src/index.ts:805` | 可见 |
| O5(d) `ctx.inject(['sessionController','sessions'])` | 无会话（启动期）；`probe.log`：apply 时 `sessionControllerAtApply:false`，约 250ms 后 `inject-fired`；三次启动一致 | `packages/api/session-controller/src/index.ts:120-132`（`inject` 不含 `jobs`）；`packages/schedule/tool-schedule/src/index.ts:444` | 回调在 `session-controller` 可用后触发，不成环 |
| O6 `Config` 并集不 import schemastery | 无会话（启动期）；`runs/m2/o6-node-check.out`；`web-o6-missing.log`、`web-o6-unknown.log` | `vendor/cordis/src/fiber.ts:50-61`（只调 `~standard.validate`）；`vendor/schemastery/src/index.ts:324-327`（`set` 就地改父类）、`:812-822`（`object` 非严格，未知键透传） | 能。手写 Standard Schema 拆出 `stateDir`/`shudBin`、自查并集外键、其余交父类校验；缺键或未知键时 stderr `did not activate` + `ValidationError`，其余行继续运行；白名单不需放宽 |

O3 可用命令（`shud:restart` 驱动的种子；`unset ALL_PROXY`，同一 `DSH_HOME`）：

```sh
out=$(../dsh-spike/runs/m2/dsh-up.sh 47820 web-A)   # 后台 node ../deepseek-harness/apps/cli/lib/bin.js --profile shud --patch <overlay> --no-open --port 47820；打印 "<pid> <launch-url>"
node ../dsh-spike/runs/m2/api.mjs connect 47820 "${out#* }"   # GET /connect?token=<t>&interactions=none → API cookie
node ../dsh-spike/runs/m2/api.mjs call 47820 session/create '{"request":{"cwd":"<ws>"}}'
node ../dsh-spike/runs/m2/api.mjs call 47820 session/prompt '{"request":{"requestId":"<id>","sessionId":"<sid>","mode":"queue","content":[{"type":"text","text":"<prompt>"}]}}'
kill -TERM "${out%% *}"   # SIGKILL 用例为 kill -KILL
out=$(../dsh-spike/runs/m2/dsh-up.sh 47820 web-B); node ../dsh-spike/runs/m2/api.mjs connect 47820 "${out#* }"
node ../dsh-spike/runs/m2/api.mjs call 47820 session/prompt '{"request":{"requestId":"<id2>","sessionId":"<sid>","mode":"queue","content":[{"type":"text","text":"<prompt>"}]}}'
```

`api.mjs call` 发 `POST /api/<ns>/<method>`，体为 `{"type":"client-request","rpcId":<uuid>,"method":"<ns>/<method>","payload":{"args":{…}}}`。

用户可见步骤（ADR-0004 K13）：`shud` Web 宿主中 S1 的模型调用 `shud_run_spike` 跑完整 ccw（1827 天），运行中重启宿主：

| 时刻（UTC） | 事件 | 进程（pid / PPID） |
|---|---|---|
| 13:24:55 | 提交 `RUN-20261022T132455-5beb`，dsh 登记 `shud-11fa45f1ae6047fa` | dsh 47234；wrapper 49092 / 47234；shud 49096 / 49092 |
| 13:25:19 | `kill -TERM 47234`，约 2s 退出 | wrapper 49092 / **1**；shud 49096 / 49092，`R` |
| 13:25:29 | 重启 dsh 49351，对账接管为 `shud-3c3948716ec1488c` | 49092、49096 存活 |
| 13:29:29 | `exit_code` 0、30 个输出文件；S1 seq 131 唤醒 → turn 9 汇报 succeeded | — |

SIGKILL 变体（`END 730`）：13:30:50 `kill -KILL 49351`，wrapper 51886 / 1、shud 51890 存活；重启 dsh 51998 接管为 `shud-93bbde2b93d84bea`；13:32:24 exit 0，S1 seq 163 唤醒 → turn 12。结束时 `pgrep` 无残留 dsh、wrapper 或 shud 进程。

**附带发现（触发停止条件，已裁决）**：按 id 的 patch 不能改行的 `name`（`vendor/include/src/index.ts:115-118` 告警 `patch: name mismatch … skipping`，实测 `runs/m2/dump-config-byid-rename.stderr`），D1「按 id 替换 `jobs` 行」不可行；spike 改用 `- id: jobs` + `disabled: true` 再插入新行（对插入行按 id 补 `config` 可行，`vendor/include/src/index.ts:94-99`）。编排方裁决：D1 挂载方式修订为 disable + insert（行 id `shud-jobs`），决策实质不变，受影响文字已在 design、proposal、specs 与 tasks 中修订（清单见 design「Open Questions」末条）。O4 使 `response` 分支在 rc.2 恒不可达；编排方裁决保留 `response|configured` 枚举，spec「Response model capture」、D10 与 task 12.1 改为 rc.2 恒记 `configured`（先 `requestHeader()?.config.model` 后 `options.model`，`source.model` 不得记为 `response`）。修订后的 requirement 经一轮 Stage 3 式三路并行复审（6 条 P1：O6 Config 投影为 `unsupported`、按 id patch 整体替换 `config`、O4 未落到 spec/任务、#303/#314 过时），全部修复并经独立验证通过。

### M2 raw-guard：`shud_run` 路径保护（2026-10-24，#301）

策略门现按 session cwd 与原有 native realpath／最近存在祖先规则解析路径：`runs` 位于或等于任一 raw 根时优先 deny；否则 raw 内 `input_dir` 以原 provenance 文案 ask；忽略参数中的 `workdir`，缺失或非法输入参数仍检查输出。实际 built Cordis seam 10 场景通过，两次 live `raw-guard:probes` 均 T1–T5 PASS，raw／根外样本 MD5 前后不变。此处只记录策略门及既有工具回归证据；`shud_run` 工具尚未挂载（#314），不代表完整运行链或 PI 验收。

### M2 手工 Web 重启唤醒验收（2026-10-27，#318）

PI 亲自在 Web 提交 ccw，收到 RunRecord 后明确选择“通过”，确认作业运行中重启宿主、返回原会话自动收到同一运行的完成通知与 RunRecord，未重复提交或手动 collect。[PI 结论转录](https://github.com/DankerMu/SHUD-Harness/issues/318#issuecomment-6443324760)与 [Epic 记录](https://github.com/DankerMu/SHUD-Harness/issues/293#issuecomment-6443325571)已公开。agent 只协助验证宿主身份并发送 SIGTERM、启动新宿主、提取磁盘证据；不以自动化结果代替 PI 的 UI 结论。以下是正式 `shud_run` 链路，不是前述 spike。

- 运行版本：SHUD-Harness `319ed3656f1c02fa5ddd89f2e4f38a103f99ba4d`；宿主仍钉 `dsh-v0.2.1-rc.2` / `687f282e8625c6b8d11ff58211a90524be2e4317`。
- 工作区：`/Users/danker/Documents/SHUD-PI-Acceptance`；`DSH_HOME=/Users/danker/.shud-pi-293-l96_w31g/home`。因 PI 无法在选择器中选择点前缀目录，使用可见工作区；未改宿主选择器或迁移旧会话。
- Session：`session-b232067e-6fa3-4650-a04a-35456cf8b527`。
- 原始日志：`/Users/danker/.shud-pi-293-l96_w31g/home/sessions/--Users-danker-Documents-SHUD-PI-Acceptance--/session-b232067e-6fa3-4650-a04a-35456cf8b527/session.v4.jsonl.zstd`。按独立 zstd 帧解压，核对 `seq`、同一 tool call id 与 `source.kind`；本次提取时日志 SHA256 为 `a25f7619513c5a0ba870b33a4c970838b4cb33aaefe87c2cb8f1b937140d59fe`，继续会话后日志可追加。
- RunJob：`JOB-20261027T132408-0fd5`；run_id：`RUN-20261027T132408-0fd5`。未传 `end_days`，持久记录为 `null`；45份源输入、工作区输入和运行副本 SHA256 逐一相同，完整 END 未缩短。

真实提交为 seq 18 的 `tool/call shud_run`，参数原文：

```json
{"input_dir": "/Users/danker/Documents/SHUD-PI-Acceptance/input/ccw", "project": "ccw", "label": "ccw acceptance run (no end_days override)"}
```

seq 19 的成功 `tool/result` 与其共享 `callId` / `toolCallId = call_00_Av9qEaEWRI7W3ny0zwLH3632`，`isError=false`；结果首行为：

```text
SHUD running: job_id=JOB-20261027T132408-0fd5, run_id=RUN-20261027T132408-0fd5, dsh_job_id=shud-4c340ac15842454d, run_dir=/Users/danker/Documents/SHUD-PI-Acceptance/runs/RUN-20261027T132408-0fd5.
```

2026-10-27T13:28:25.505Z，agent 在新鲜 `run-job.json` 仍为 `running`、`exit_code` 文件不存在、wrapper PID `43586` / start `2026-10-27T13:24:08.000Z` 同身份且非 Z 的条件下，核对锁中宿主 PID/start 后只向宿主 `59450` 发送 SIGTERM。旧宿主 exit 0 后，原 wrapper 同身份仍存活（`Ss`）；新宿主 `60691` 使用同一 `DSH_HOME` 启动并接管，登记 id 变为 `shud-c76fba5a46454114`，`dsh_job_ids` 保留前后两项，`cancel_requested_at` 仍为 `null`。没有向 SHUD 组发信号；这些是离散身份观测，不主张穷尽进程追踪。

重启后 seq 35（13:29:09.201Z）的实际自动唤醒字段摘录：

```json
{"type":"user/message","seq":35,"data":{"content":[{"type":"text","text":"SHUD run RUN-20261027T132408-0fd5: exit_class=ok; artifacts=30."}],"source":{"kind":"shud-jobs"},"role":"user","id":"91e7f92a-0d7a-4b1d-8359-d650fd6f7861"}}
```

本次日志只有一次 `shud_run`、零次 `shud_collect`，且真实用户来源消息只有最初一次提交；唤醒后助手 seq 60 调用 `read` 读取下述 RunRecord，seq 61 同 call id `call_00_ET_pJTQlOPPGJGNI1hcoisY9857` 成功返回。PI 随后报告收到 RunRecord 并确认验收通过，不把模型的口头完成声明作为磁盘结果。

- RunRecord 路径：`/Users/danker/Documents/SHUD-PI-Acceptance/runs/RUN-20261027T132408-0fd5/run-record.json`；SHA256 `6303758674fbcb093ae64b243db56d45c94ba957f708c2214ce88026dd465df4`。
- 结果：`status=succeeded`、`exit_code=0`、`exit_class=ok`、30个产物文件；`collected_at=2026-10-27T13:29:09.007Z`。恢复生成的 `resources.wall_seconds=null`、`peak_memory_mb=null`，不解释为求解器耗时或性能改善。
- RunJob 已为 `collected`，`notify.status=delivered`、`attempts=0`、`at=2026-10-27T13:29:09.184Z`。本次验收是实际 Web 的 SIGTERM 重启场景；此前自动化 SIGKILL 证据独立保留，不冒充本次 PI 手工步骤。
