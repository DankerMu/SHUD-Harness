<!--
Generated from instructions/agents/shared.md and instructions/agents/claude.md
by the project-instruction-bootstrap skill. Edit those sources, then re-run the skill.
Do not hand-edit this file.
-->

# SHUD-Harness

## Project Identity

SHUD-Harness is a **PI-led scientific research engineering assistant** for the SHUD hydrological modeling system.
It orchestrates SHUD (C++ solver), rSHUD (R toolbox), and AutoSHUD (R automation pipeline)
through a Coordinator Agent with Web-first interaction, real-time chat, bash sandbox execution, lightweight memory, and PI-gated governance.

**核心定位**: 不是自治科研平台，而是帮 PI 和工程师节省重复劳动时间的工具。
成功标准 = 时间节省，不是自治程度。

## Repository Layout

```
SHUD-Harness/                    ← you are here（dsh profile + 插件，不是独立 app）
├── SHUD/ rSHUD/ AutoSHUD/       ← 只读参考 submodule
├── packages/dsh-shud-*/         ← TS 插件包（core / raw-guard / jobs / tools / records / presets）
├── profile/shud/                ← dsh bundle + cordis.patch.yml（模型路由、出站关闭、插件挂载）
├── skills/ scripts/ templates/  ← SHUD 专用 SKILL.md / 确定性脚本 / 报告模板
├── docs/                        ← ADR + 计划 + 精简 spec（adr/、04_IMPLEMENTATION/、Migration_Plan_dsh.md）
├── openspec/                    ← glossary + changes
├── AGENTS.md / CLAUDE.md        ← 生成文件，勿手编辑
└── instructions/agents/         ← 指令源（shared.md + claude.md + codex.md）
```

dsh 源码 checkout 在 `../deepseek-harness`（钉 tag `dsh-v0.2.1-rc.2`），只作运行宿主，不改源码。spike 记录在 `../dsh-spike`。
布局细节见 `docs/04_IMPLEMENTATION/Repository_Layout.md`。

## Key Design Decisions (v0.9, ADR-0004)

1. **Coordinator, not Commander**: Agent 是执行协调员，不是科学决策者。PI 做科学判断。
2. **8 objects, not 20**: TaskCard, StackLock, DataProvenance, RunJob, RunRecord, AnalysisPlan, EvidenceReport, ChangeRequest.
3. **Web-first, Report-first**: dsh 自带 Web UI 是唯一交互渠道（对话 + 审批卡片 + 作业卡片），MVP 零自定义 UI，产出 Markdown 报告供 PI 决策。
4. **Park/Resume for long tasks**: SHUD 运行可能几小时，经 `ctx.jobs` 提交后 agent 空闲，完成通知自动唤醒新 turn；作业持久化由自写 durable JobRegistry backend 保证（dsh 重启不丢）。
5. **基于 dsh 扩展**: 内核 = DeepSeek Harness（Cordis 插件树）；SHUD 逻辑只挂文档化 seam（`tools/pre-execute`、`ctx.approval`、`ctx.jobs`、`ctx.sandbox`、`ctx.storage`、agent preset），永不改 loop、不 fork。
6. **Inference budget per task**: cheap/normal/deep 三档，仅作 Web Dashboard 软监控，PI 决定是否中止。
7. **Memory 两级**（MVP 不做）: 普通笔记直接写 draft; 证据类笔记需 PI review。不搞 4 级审批。
8. **Skill 三阶段**: draft → active → retired。不搞 6 级生命周期。
9. **Sensitivity analysis 一等公民**: AnalysisPlan.mode=sensitivity，不是实验规范的子字段。
10. **TypeScript 插件包**: pnpm workspace 多包，tsc 构建到 lib/，vitest 测试，Zod 做 schema 验证；profile 以文件路径挂载，不发 npm。
11. **作用域规则**: 任何 spike 不以首任务的一个用户可见步骤收尾就不准开（ADR-0004 K13）。

## The Three Repos

### SHUD (C++14, ~7K lines)
- FVM 求解器: 地表/非饱和/地下水/河道/湖泊耦合水文过程
- SUNDIALS/CVODE 6.0+ ODE; OpenMP 并行
- 构建: `./configure && make shud` → `./shud <project>`
- 输入: `.mesh .riv .att .para.* .cfg.* .tsd.*`
- 输出: 二进制 `.dat` (42 个输出变量)
- 示例: ccw, heihe, qhh

### rSHUD (R, v2.5.0, 228 导出函数)
- 前处理: DEM→网格→属性→SHUD 输入
- 后处理: `read_output()` 读二进制, `wb.all()` 水量平衡
- terra/sf 现代栈; 10 个测试文件

### AutoSHUD (R 脚本, ≈v2.5.0-rc)
- 5-6 步流水线 (Step0.1 可选 + Step1-5); `.autoshud.txt` 配置驱动
- 多源数据整合; 依赖 rSHUD ≥2.5.0

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

## Current State

- **方案**: v0.9 dsh 内核（ADR-0004，2026-10-20）：`dsh --profile shud` + `dsh-shud-*` 插件；模型 = DeepSeek Flash via DMXAPI（`deepseek-flash-guan`，原生 Messages adapter）；单用户、全本机 Mac（ADR-0002 D1/D6 继续有效）
- **首任务**: ccw 运行 → RunRecord → EvidenceReport（MVP-1）；openMP RHS 已知答案回放为 MVP-2
- **实施**: 里程碑 M1–M6，唯一真相源 = `docs/04_IMPLEMENTATION/Phased_Plan.md`；迁移过程账 = `docs/Migration_Plan_dsh.md`；旧文档处置表 = `docs/00_INDEX/Doc_Disposition_2026-10-20.md`；Zero 时代历史在 tag `archive/zero-v0.8.3`
- **dsh 升级**: 每个里程碑边界一条 `chore(dsh-upgrade)` issue，以上游 upgrade-guide 为输入；升级后重跑 `../dsh-spike/runs/` 五项探针
- **出站**: `session-log-deepseek` 在 profile 内固化关闭（ADR-0004 K9），其余 dsh 默认

## 已装能力

**Packs**：`agentic-issue-delivery`、`codebase-stewardship`

**Skills**（投影在 `.claude/skills/`（Claude）或 `.agents/skills/`（Codex））：

- 核心工作流：`subagent-workflow`（issue 实现全流程）· `stage-change-pipeline`（设计到 issue 全流水线）· `risk-adaptive-cross-review`（审核语义源）
- 执行编排：由 native 子代理（`implementer`/`reviewer`/`verifier`）执行，编排见 `subagent-workflow`
- 设计与澄清：`clarify` · `grill-me` · `grill-with-docs` · `brainstorming` · `future-aware-architecture` · `implementation-planning` · `blind-spot-pass`（开工前陌生区域盲区侦察，从 git 历史/相似实现/隐形约定挖 unknown unknowns）
- 代码质量：`review` · `entropy-review` · `repo-entropy-audit` · `improve-codebase-architecture` · `control-plane-auditor`
- 工具：`gh-create-issue` · `git-worktree-workflows` · `project-documentation`

**Agents**（投影在 `.claude/agents/`（Claude）或 `.codex/agents/`（Codex））：`implementer` · `reviewer` · `verifier` · `explorer` · `monitor`（CI 等 harness 外长等待交它看护，主线不空转）· `issue-scribe`（主线发现 follow-up 事项时调用：只读取证→按关键词和证据路径查重→落一条结构化 issue，绝不顺手修）

**Hooks**（脚本投影在 `.claude/hooks/` 与 `.codex/hooks/`，条目并入 `.claude/settings.json` 与 `.codex/hooks.json`）：

- `worktree-guard` — 并行 worktree 写围栏；仅当项目根存在 `.worktree-guard.json` 时激活，由 `subagent-workflow` 进出并行委派时自动写入/清除。
- `large-file-guard` — `git commit` 前拦截本次触碰的 >1000 行文本文件（增量棘轮，存量不追溯）；`.large-file-guard.json` 可调阈值/排除/停用。

## 项目本地适配（living 文件，按需创建）

- `openspec/project-profile.md` — workflow 适配（入口/契约/风险轴）；`subagent-workflow` 首次运行可自动 bootstrap。
- `openspec/glossary.md` — 领域 ubiquitous language 单一来源（已创建：中英术语映射，grep 前先查两态关键词）；由 `grill-with-docs` / `improve-codebase-architecture` 维护。
- `docs/adr/NNNN-slug.md` — 长期架构决策账本（三门槛：难回退 + 无背景会困惑 + 真实权衡）。
- `.large-file-guard.json` — 大文件闸配置（阈值/排除/开关），仅在默认 1000 行不合适时创建。

## 反熵约定

根指令保持精简。包/能力的操作细节下沉到各自 `SKILL.md` / pack `README.md` / `CHANGELOG.md`，不在本文件展开；子树需细化时就近新增 scoped 指令文件。

## Observable Completion

完工附一行 `Execution Summary: agents=...; skills=...; tools=...; verification=...; limits=...`；保持事实、不展开隐藏推理。
## Claude Code Notes

- 知识域类 skill（如调试方法论）自动触发率低，优先显式 `/skill-name` 调用。
- 安装重叠 skill 时剪枝旧/被取代项，保持技能列表清晰。
- Claude runtime 安装：skills -> `.claude/skills/`，agents -> `.claude/agents/`；改 canonical 后重装，勿编辑投影副本。
