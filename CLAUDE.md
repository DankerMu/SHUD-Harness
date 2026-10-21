<!--
Generated from instructions/agents/shared.md and instructions/agents/claude.md
by `pnpm run instructions:render` (project-instruction-bootstrap sources). Edit those sources, then re-render.
Do not hand-edit this file.
-->

# SHUD-Harness

> 本仓库工程与 agent 操作规则的单一事实源（eng-init 2026-10-20，L3 strict）。bounded contexts 与不变量在 `CONTEXT.md`，领域术语在 `openspec/glossary.md`，阈值与校验镜像在 `constraints.yaml`。

## Code Canonicality

同一逻辑在仓库中只能有一个实现；版本演进属于 git 历史，不属于文件名或标识符。

- 新增函数/类/模块/文件前先 grep 现有实现；有则扩展或重构，确无才新建。
- 文件名、类名、函数名、模块名禁止后缀：`_v1` `_v2` `_new` `_old` `_backup` `_temp` `_copy` `_final` `_real` `_improved` `_refactored` `_fixed` `_legacy` `_deprecated`。已存在的视为待统一的债，不是可延续的模式。
- 原地重构：先提交可工作状态，改原文件，跑测试；坏了就 `git revert`。绝不"以防万一"保留旧版本。
- 没有 `## Source of Truth & Refactor Contract` 书面例外，不允许新旧实现并行过渡。
- 注释掉的代码是 lint 错误不是安全网；未引用导出与死路径是债（knip 阻断）。
- 仓库不是草稿纸：`tmp/` `scratch/` `backup/` `_old/` `wip/` 不得进入提交。

| 规则 | 执行 |
|---|---|
| 禁止后缀 | `.git-hooks/check-naming.sh`（pre-commit + CI `pnpm run naming:check`） |
| 死代码/未用依赖 | `knip.json`（CI `pnpm run deadcode`） |
| 重复代码 ≤3% | `.jscpd.json`（CI `pnpm run dup`） |

## Project Identity

SHUD-Harness is a **PI-led scientific research engineering assistant** for the SHUD hydrological modeling system. It orchestrates SHUD (C++ solver), rSHUD (R toolbox), and AutoSHUD (R automation pipeline) through a Coordinator Agent with Web-first interaction, real-time chat, bash sandbox execution, lightweight memory, and PI-gated governance.

**核心定位**: 不是自治科研平台，而是帮 PI 和工程师节省重复劳动时间的工具，还要提升科研效率、拓展研究员能力边界。成功标准 = 时间节省，不是自治程度。

- 生命周期：年（长期科研基础设施）· 单人维护 · 工具：Claude Code + Codex · 严格度 **L3 strict**（`constraints.yaml`）。
- 产品形态：`dsh --profile shud`（dsh 内核 + `dsh-shud-*` 插件），没有自己的 app；设计账本 [ADR-0004](docs/adr/implemented/0004-dsh-kernel.md)，里程碑 M1–M6 唯一真相源 `docs/04_IMPLEMENTATION/Phased_Plan.md`。
- 首任务：ccw 运行 → RunRecord → EvidenceReport（MVP-1）。任何 spike 不以首任务的一个用户可见步骤收尾就不准开（K13）。

## Stack & Versions

| 层 | 选择 | 钉版 |
|---|---|---|
| 运行时 | Node ≥24（直接运行 `.ts`） / pnpm workspace | `.tool-versions`（24.13.1 / 11.28.5），`package.json#packageManager` |
| 语言 | TypeScript strict，NodeNext，`.ts` 后缀导入 | `tsconfig.base.json`，typescript 5.8.3 |
| 校验/测试 | Zod 4.4.3 · vitest 4.1.11 + coverage-v8 | 根 `package.json` devDependencies |
| 质量闸 | eslint 10 + typescript-eslint（type-aware）· prettier · jscpd · knip · commitlint · gitleaks · semgrep（CI） | 同上；`gitleaks`/`semgrep` 为系统二进制 |
| 宿主 | dsh `dsh-v0.2.1-rc.2`，checkout 在 `../deepseek-harness`，只读 | `profile/shud/package.json` peer |
| 模型 | DeepSeek Flash via DMXAPI（`deepseek-flash-guan`，`DMXAPI_KEY` 仅环境变量） | `profile/shud/cordis.patch.yml` |
| 科学栈 | SHUD C++14 + SUNDIALS（`~/sundials`）· rSHUD 2.5.0 · AutoSHUD | submodule 只读 |

依赖策略：锁文件 `pnpm-lock.yaml` 必须干净（`--frozen-lockfile`）；`autoInstallPeers: false`，绝不从 npm 拉 dsh；Dependabot 每周（`.github/dependabot.yml`），`@deepseek-ai/*` 排除，dsh 升级只走 `chore(dsh-upgrade)` issue。新依赖需在 PR 里写明理由。

## Directory Map

```
SHUD-Harness/
├── packages/dsh-shud-core/      ← 领域层：8 对象 Zod schema、policy-gate-core、role-tool-map（M1 起新增 raw-guard/jobs/tools/records/presets）
├── profile/shud/                ← dsh bundle + cordis.patch.yml（模型路由、出站关闭、插件挂载）
├── scripts/                     ← 确定性脚本：schema/ docs/ adr/ guardrails/ instructions/ runtime/
├── docs/                        ← adr/（四区）· 03_SPEC · 04_IMPLEMENTATION · generated/（勿手编）· 99_ARCHIVE（冻结）
├── openspec/                    ← glossary.md · project-profile.md · changes/
├── instructions/agents/         ← AGENTS.md / CLAUDE.md 的源（shared + codex + claude）
├── .git-hooks/ .github/         ← 本机闸 · CI/release/dependabot
├── .claude/ .codex/ .agents/    ← agent 运行时：settings/hooks 已跟踪，skills/agents 为投影
└── SHUD/ rSHUD/ AutoSHUD/       ← 只读 submodule
```

边界：插件只触碰文档化 seam（`tools/pre-execute`、`ctx.approval`、`ctx.jobs`、`ctx.sandbox`、`ctx.storage`、agent preset），不 import dsh loop 内部，不改 `../deepseek-harness`。新行为去向：对象字段 → `packages/dsh-shud-core/src/schemas/` 再 `pnpm run schema:generate`；治理规则 → `governance/`；运行时/作业 → 对应 `dsh-shud-*` 包；一次性脚本 → `scripts/`。bounded contexts 见 `CONTEXT.md`。

## Development Workflow

- 克隆后：`pnpm install`（自动执行 `prepare` → `core.hooksPath=.git-hooks`）。本机需 `gitleaks`（brew）；`semgrep` 仅 CI。
- 日常：`pnpm run check` 是唯一默认闸（typecheck → lint → format → coverage → dup → deadcode → naming → schema drift → docs gate）。改 Zod 后 `pnpm run schema:generate`；改 `instructions/agents/*.md` 后 `pnpm run instructions:render`；两者产物都由 CI 比对。
- 运行时：`pnpm run profile:smoke`（dsh 启动 + 路由断言）、`pnpm run shud:tiny`（ccw 30 天）本机运行；CI 有 npm 版 dsh（`profile-smoke` job），无 SHUD。
- 环境：`DMXAPI_KEY` 只经环境变量；本机跑 dsh/gh 前 `unset ALL_PROXY`；`DSH_HOME` 指向临时目录避免污染真实会话。
- 流程：一个 issue 一个分支/worktree，走 `subagent-workflow`；PR ≤400 行（CI 阻断，`size-exempt` label 记录例外）；提交信息 conventional（commit-msg 钩子）；merge 需 CI `all-checks-passed` + PI 功能验收。

## Verification Matrix

| 面 | Command | 通过判据 | 级别 |
|---|---|---|---|
| 全部（默认闸） | `pnpm run check` | 以下全部绿 | block |
| 类型 | `pnpm run typecheck` | tsc 0 错 | block |
| Lint（type-aware、max-lines 1000、import 禁令） | `pnpm run lint` | 0 错 0 警 | block |
| 格式 | `pnpm run format:check` | prettier 无差异 | block |
| 单测 | `pnpm run test` | 全绿 | block |
| 单测 + 覆盖率 | `pnpm run test:coverage` | lines/stmts/funcs/branches ≥80% | block |
| 重复 | `pnpm run dup` | ≤3% | block |
| 死代码 | `pnpm run deadcode` | knip 0 error | block |
| 命名 | `pnpm run naming:check` | 无禁止后缀 | block |
| Schema drift | `pnpm run schema:check` | `docs/generated/` 与 Zod 一致 | block |
| 文档闸 | `pnpm run docs:check` | 链接、路径声明、生成指令、决策记录全绿 | block |
| 密钥 | `pnpm run security:secrets` | gitleaks 0 泄漏 | block |
| SAST（CI） | `pnpm run security:sast` | semgrep 0 finding | block（CI） |
| PR 体积 | `pnpm run pr:size` | ≤400 行或已标 `size-exempt` | block（CI） |
| dsh profile 启动（本机 + CI） | `pnpm run profile:smoke` | 路由 deepseek-flash-guan、DMXAPI、session-log-deepseek disabled、raw-guard mounted | block（本机 + CI） |
| raw-guard 五探针（本机，需 `DMXAPI_KEY`） | `pnpm run raw-guard:probes` | T1–T5 PASS、两份 raw md5 不变、总绿汇总 | block（本机） |
| Web 审批卡往返 | 手工：读 raw → Allow once；写 raw → deny | session log 读审批 allowed-once 后成功；写 immutable 且无新审批；raw md5 不变 | manual |
| SHUD ccw tiny（本机） | `pnpm run shud:tiny` | exit 0 + `.dat` 产出，<2 min | block（本机） |
| 闸自证 | `pnpm run test-guardrails` | 每闸拒违规、收干净输入 | block |

## Runtime Lifecycle

无常驻 dev server。以下命令从本仓库根目录执行；先 `pnpm run build` 产出插件 `lib/`。无全局 `dsh` 时使用现有 checkout 的 Node 入口：

```sh
export DSH_HOME="$(mktemp -d)"
pnpm run profile:install
node ../deepseek-harness/apps/cli/lib/bin.js --profile shud --dump-config
```

`profile:install` 默认以 `web` 模板创建 `shud` 并 `link:` 安装本仓库 bundle；安装与启动必须沿用同一导出的 `DSH_HOME`。需要审批卡/作业卡时，在同一环境执行 `node ../deepseek-harness/apps/cli/lib/bin.js --profile shud web --no-open --port <p>`。headless 任务改用同一 bundle 的独立 profile：

```sh
PROFILE_NAME=shud-probe PROFILE_TEMPLATE=headless pnpm run profile:install
node ../deepseek-harness/apps/cli/lib/bin.js --profile shud-probe --json "<task>"
```

headless 任务同样沿用上述 `DSH_HOME`，真实 LLM 调用需环境变量 `DMXAPI_KEY`。切换到研究 workspace 时须使用宿主入口的绝对路径，并保持该 `DSH_HOME`；可选 `--patch <overlay>` 必须在 `web` 等应用参数之前，不能代替 bundle 安装。部署期在用户 `$DSH_HOME/profiles/shud/cordis.patch.yml` 覆写 `shud-raw-guard.config.rawDirs`，覆盖 workspace 外的真实 raw 目录；默认 `data/raw` 仅供开发/探针。证据取自 session log（`approval/asked|decided`、`job/settled`、`tool/result`），不取自终端回忆。SHUD 运行一律在 scratch workspace 复制 `input/ccw` 后进行，submodule 永不改动。

## Conventions

- 命名：文件 kebab-case（`policy-gate-core.ts`），类型 PascalCase，常量 UPPER_SNAKE；schema 字段 snake_case（`Minimal_Schemas.md`）。
- 债标记：`TODO(#issue)` 必须带 issue 号；无号 TODO 在 review 中打回。
- 偏离带理由：任何对 `constraints.yaml`/baseline 的放宽都是独立决策并写进 `docs/adr/proposed/`，不得夹带在功能 PR。
- 提交：`type(scope): subject`，types feat/fix/docs/build/chore/ci/refactor/test；`Co-Authored-By` 行保留。
- PR：模板 `.github/pull_request_template.md`；描述末尾 `🤖 Generated with Claude Code` 行保留。
- 分支：`main` 受保护，功能分支 `type/short-slug`，merge 走 PR。
- 覆盖率：80% block；新代码不得靶向性排除；`index.ts` 与测试文件排除。

## Code Review Self-Check

提交 PR 前逐项自查，并把证据贴进 PR：

- [ ] `pnpm run check` 本机绿；触及 seam/运行时还跑了 `profile:smoke` 或 `shud:tiny`
- [ ] 测试先于实现（TDD）；每个新谓词/不变量有正反例
- [ ] 没新增 `_v2`、注释代码、无号 TODO、未用导出
- [ ] 触及 `## Critical Paths` 时：reviewer 子代理白盒审查记录 + 测试证据在 PR 内
- [ ] Zod 改动已 `schema:generate`；指令源改动已 `instructions:render`
- [ ] 文档随代码改（命令/路径/行为）；非平凡变更有决策记录
- [ ] 报告措辞：无"模型机制已验证"、无"普遍改进"、calibration 标注为 calibration
- [ ] 无密钥、无 `data/raw` 写入、无 dsh 源码改动

## Architecture Discipline

- **TDD**：红 → 绿 → 重构；行为先由失败测试定义，覆盖率 80% block。
- **Seam-only**：能力经 dsh 文档化 seam 注入，缺 seam 是"报告偏差"不是 fork。
- **Model-visible ⟺ logged**：模型看到的每个工具结果/审批/作业事件都进 session log；未记录的东西不是证据。
- **Capability seams + registrations as effects**：插件注册是显式副作用，启动时可枚举（`--dump-config`）。
- **显式默认、无硬编码可调项**：阈值/路径/模型 id 来自 `constraints.yaml`、`profile/shud/cordis.patch.yml`、schema 常量；配置缺失即 fail-loud，不静默回退。
- **Runtime invariant companions**：每条 `CONTEXT.md` 不变量在代码里有对应断言或测试；M2 起作业持久化不变量进入矩阵。
- **Branded ids**：TaskCard/RunJob/RunRecord 等 id 用品牌类型，不用裸 string。
- **Waterfall delegation**：`tools/pre-execute` 决策按 allow→deny→cancel→ask 瀑布，第一条命中即终止，fail-closed。
- **Closure 判据代码化**：TaskCard 不能仅因 LLM 认为完成而关闭（`docs/02_ARCHITECTURE/Agent_Architecture.md` §7）。

## Critical Paths

以下七类改动必须白盒审查（reviewer 子代理逐行 + 测试证据），人工只做功能审查与测试验收，不审代码：

1. 策略门决策（`packages/dsh-shud-core/src/governance/`：allow/deny/ask 表、保留规则 id）
2. 原始数据保护（`data/raw` 只读、sandbox 边界、symlink 解析）
3. 审批 seam（`ctx.approval` 结果处理、fail-closed）
4. 作业持久化 / park-resume（`ctx.jobs` 后端、SIGTERM/SIGKILL 对账）
5. 密钥处理（`DMXAPI_KEY` 流向、RunRecord/报告/日志脱敏）
6. 报告语言护栏与水印（EvidenceReport 措辞常量、7 态水印）
7. Schema 与生成投影（`packages/dsh-shud-core/src/schemas/`、`docs/generated/`）

## Observability

- 结构化日志 = dsh session log（`session.v4.jsonl.zstd`）；插件事件走 dsh 事件而非 `console.log`。
- 禁止记录：`DMXAPI_KEY`、任何 `sk-` 形态 token、`data/raw` 内容。`profile:smoke` 断言 dump-config 无密钥。
- 作业状态以 `job/settled` 为准；RunRecord 记录 exit code（0/10/12/13/19/20）与 artifact 路径。
- 无 tracing/metrics（单机单用户，不装空壳）。

## Agent Operating Rules

**可以**：读全仓库与 submodule；在 worktree 内改 `packages/ scripts/ profile/ docs/ openspec/ instructions/`；运行矩阵内任何命令；派 `implementer`/`reviewer`/`verifier`/`explorer` 子代理；开 issue（`issue-scribe`）。

**越界（no-bypass hook 阻断）**：跳过钩子的 no-verify 标志 · force-push `main` · 改 `../deepseek-harness` · 写/删 `data/raw` · 启用 `session-log-deepseek` · 密钥写进文件/日志/RunRecord · 删 `archive/zero-v0.8.3` tag · 手编 `AGENTS.md`/`CLAUDE.md`/`docs/generated/`/`docs/adr/archived/`。

**不得**：下科学结论（单流域提升 ≠ 模型改进；calibration ≠ 结构验证）· 自行批准 PI gate · 改物理方程/默认参数/benchmark baseline 而不经 `ask` · 放宽任何闸以让自己的改动通过 · dsh 升级绕开 `chore(dsh-upgrade)` issue。

**升级**：阻塞于需 PI 判断的问题时，写明问题与证据后停下；merge 由 PI 做功能验收。决策记录四区见 `docs/adr/README.md`。

## Enforcement Index

| 规则 | 位置 | 校验 | 级别 |
|---|---|---|---|
| 禁止并行版本后缀 | `.git-hooks/check-naming.sh`，`constraints.yaml` naming | pre-commit；CI `pnpm run naming:check` | block |
| 文件 ≤1000 行（3 文件冻结基线，M2/M3 棘轮） | `eslint.config.mjs`，`constraints.yaml` baseline | pre-commit lint-staged；CI `pnpm run lint` | block |
| type-aware lint，禁 import dsh 内部路径 | `eslint.config.mjs`，`tsconfig.eslint.json` | pre-commit；CI `pnpm run lint` | block |
| 格式 | `.prettierrc.json`，`.editorconfig` | pre-commit；CI `pnpm run format:check` | block |
| 类型 | `tsconfig.base.json` | CI `pnpm run typecheck` | block |
| 测试 + 覆盖率 ≥80% | `vitest.config.ts` | CI `pnpm run test:coverage` | block |
| 重复 ≤3% | `.jscpd.json` | CI `pnpm run dup` | block |
| 死代码/未用依赖（duplicates 为 warn，M3 转 error） | `knip.json` | CI `pnpm run deadcode` | block |
| Schema 生成物无漂移 | `scripts/schema/check.sh` | CI `pnpm run schema:check` | block |
| 文档链接 + 路径声明 + 生成指令 + 决策记录 | `scripts/docs/`，`scripts/instructions/render.sh`，`scripts/adr/verify.sh` | CI `pnpm run docs:check` | block |
| 密钥 | gitleaks | pre-commit；CI `pnpm run security:secrets` | block |
| SAST | semgrep | CI `pnpm run security:sast` | block |
| PR ≤400 行（label `size-exempt` 记录） | `scripts/guardrails/pr-size.sh` | CI `pnpm run pr:size` | block |
| Conventional commits | `commitlint.config.mjs` | commit-msg | block |
| 锁文件干净、不拉 dsh | `pnpm-workspace.yaml` | CI lint/test jobs install with frozen lockfile | block |
| 单一必需检查 | `.github/workflows/ci.yml` all-checks-passed | GitHub rulesets（branch protection） | block |
| 越界动作（no-verify、force-push、dsh/raw 写、生成物手编） | `scripts/guardrails/no-bypass.sh`（`.claude/settings.json` 与 `.codex/hooks.json` 共用） | pre-commit 等价：agent PreToolUse hook | block |
| 本次触碰 >1000 行文件 | `.claude/hooks/large-file-guard/large-file-guard.sh` | pre-commit 等价：agent hook on git commit | block |
| 闸自证 | `scripts/guardrails/test-guardrails.sh` | 本机 `pnpm run test-guardrails` | block |
| dsh profile 路由 / 出站关闭 | `scripts/runtime/profile-smoke.sh` | 本机 + CI `pnpm run profile:smoke` | block |
| raw-guard 五探针 / raw 字节不变 | `scripts/runtime/raw-guard-probes.sh` | 本机 `pnpm run raw-guard:probes`（需 `DMXAPI_KEY`） | block |
| ccw tiny 闭环 | `scripts/runtime/shud-tiny.sh` | 本机 `pnpm run shud:tiny` | block |
| 物理方程/默认参数/baseline 改动需 PI | policy gate `ask` | 运行时审批卡 + 决策表测试 `pnpm run test` | gate |
| merge = PI 功能验收 | GitHub PR | GitHub rulesets（PR required） | gate |
| 不 import dsh loop 内部（seam 白名单，M1 起） | `eslint.config.mjs` | review-only until M1 | review-only |
| docs 随代码改 | PR 模板 | review-only | review-only |
| 科学措辞规则（M3 转测试常量） | 报告生成 | review-only until M3 | review-only |
| 运行时不变量伴生（M2 起入矩阵） | reviewer 清单 | review-only until M2 | review-only |
| dsh 升级只走 issue | 流程 | review-only | review-only |

## Agent Roles

Canonical 角色枚举 (唯一权威源: `docs/02_ARCHITECTURE/Roles_and_Boundaries.md` §0):
`coordinator | repo_explorer | worker | coder | reviewer`

| 角色 | 职责 | 科学决策权 |
|------|------|-----------|
| PI/研究者 | 在 Web 界面提问、审批、判断证据 | ✅ |
| Coordinator | 建 TaskCard、执行计划、监控消耗、生成报告 | ❌ |
| Repo Explorer | 只读探索仓库、定位入口/调用链/影响面 | ❌ |
| Worker | 跑模型、解析日志、写脚本、生成图表 | ❌ |
| Coder | 在 worktree 改代码、生成 patch/ChangeRequest | ❌ |
| Reviewer | 检查工程完整性和兼容性 (不判断科学结论) | ❌ |

## Governance Rules

- 改物理方程 / 默认参数 / benchmark baseline → PI 审批（`tools/pre-execute` 返回 `ask`，dsh Web 审批卡片）
- 改输出格式 (breaking) → PI 审批
- 删除原始数据 → 禁止或 PI 审批；`data/raw` 必须位于 workspace root 之外（Seatbelt 只读）
- 单流域指标提升 ≠ 模型改进 → Agent 不允许这样表述
- 校准结果 ≠ 结构验证 → Agent 必须标注为 calibration
- 设计决策 K1–K13 与三仓库事实：[ADR-0004](docs/adr/implemented/0004-dsh-kernel.md)、`docs/01_CODEBASE/SHUD_IO_Facts.md`、`docs/01_CODEBASE/rSHUD_AutoSHUD_Quirks.md`；迁移账 `docs/Migration_Plan_dsh.md`；Zero 时代历史在 tag `archive/zero-v0.8.3`。

## 已装能力

**Packs**：`agentic-issue-delivery`、`codebase-stewardship`

**Skills**（Codex 投影在 `.agents/skills/`，Claude 投影在本机 .claude/skills，gitignored）：

- 核心工作流：`subagent-workflow`（issue 实现全流程）· `stage-change-pipeline`（设计到 issue 全流水线）· `risk-adaptive-cross-review`（审核语义源）
- 执行编排：由 native 子代理（`implementer`/`reviewer`/`verifier`）执行，编排见 `subagent-workflow`
- 设计与澄清：`clarify` · `grill-me` · `grill-with-docs` · `brainstorming` · `future-aware-architecture` · `implementation-planning` · `blind-spot-pass`（开工前陌生区域盲区侦察，从 git 历史/相似实现/隐形约定挖 unknown unknowns）
- 代码质量：`review` · `entropy-review` · `repo-entropy-audit` · `improve-codebase-architecture` · `control-plane-auditor`
- 工具：`gh-create-issue` · `git-worktree-workflows` · `project-documentation` · `eng-init`（本控制面的生成器，incremental 模式更新）

**Agents**（Codex 投影在 `.codex/agents/`，Claude 投影在本机 .claude/agents，gitignored）：`implementer` · `reviewer` · `verifier` · `explorer` · `monitor`（CI 等 harness 外长等待交它看护，主线不空转）· `issue-scribe`（主线发现 follow-up 事项时调用：只读取证→按关键词和证据路径查重→落一条结构化 issue，绝不顺手修）

**Hooks**（脚本在 `.claude/hooks/` 与 `.codex/hooks/`，条目在 `.claude/settings.json` 与 `.codex/hooks.json`，均已跟踪）：

- `worktree-guard` — 并行 worktree 写围栏；仅当项目根存在 worktree-guard 配置文件（.worktree-guard.json，按需创建）时激活，由 `subagent-workflow` 进出并行委派时自动写入/清除。
- `large-file-guard` — `git commit` 前拦截本次触碰的 >1000 行文本文件（增量棘轮，存量不追溯）；`.large-file-guard.json` 可调阈值/排除/停用。
- `no-bypass` — 越界动作阻断（见 `## Agent Operating Rules`）；单一脚本 `scripts/guardrails/no-bypass.sh`，两运行时的 hook 条目都指向它；规则清单在 `constraints.yaml` no_bypass。

## 项目本地适配（living 文件，按需创建）

- `openspec/project-profile.md` — workflow 适配（入口/契约/风险轴）；`subagent-workflow` 首次运行可自动 bootstrap。
- `openspec/glossary.md` — 领域 ubiquitous language 单一来源（已创建：中英术语映射，grep 前先查两态关键词）；由 `grill-with-docs` / `improve-codebase-architecture` 维护。
- `docs/adr/` — 决策记录四区（`proposed/ implemented/ rejected/ archived/`），新记录写入 `docs/adr/proposed/`（命名 `NNNN-slug.md`）；规则见 `docs/adr/README.md`，`pnpm run adr:check` 校验。
- `.large-file-guard.json` — 大文件闸配置（阈值/排除/开关），仅在默认 1000 行不合适时创建。

## 反熵约定

根指令保持精简。包/能力的操作细节下沉到各自 `SKILL.md` / pack README / CHANGELOG，不在本文件展开；子树需细化时就近新增 scoped 指令文件。

## Observable Completion

完工附一行 `Execution Summary: agents=...; skills=...; tools=...; verification=...; limits=...`；保持事实、不展开隐藏推理。

## Claude Code Notes

- 知识域类 skill（如调试方法论）自动触发率低，优先显式 `/skill-name` 调用。
- 安装重叠 skill 时剪枝旧/被取代项，保持技能列表清晰。
- Claude runtime 安装：skills -> `.claude/skills/`，agents -> `.claude/agents/`；改 canonical 后重装，勿编辑投影副本。
