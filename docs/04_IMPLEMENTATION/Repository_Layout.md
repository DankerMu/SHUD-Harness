---
status: living
supersedes: Zero 时代 monorepo 布局（tag archive/zero-v0.8.3）
---

# 仓库结构 v2（dsh profile + 插件）

决策依据 [ADR-0004](../adr/implemented/0004-dsh-kernel.md) K2/K10。SHUD-Harness 不再是独立应用，而是一个 dsh profile 及其插件包。

## 1. 代码仓库

```text
SHUD-Harness/
  package.json                      # pnpm workspace 根；scripts: typecheck / test / build / profile:smoke
  pnpm-workspace.yaml               # packages/*
  tsconfig.base.json
  packages/
    dsh-shud-core/                  # 领域层（运行时无关）
      src/schemas/                  # 8 对象 Zod schema（移植）
      src/governance/               # 治理常量、policy-gate-core 纯函数（移植）、措辞规则
      src/index.ts
    dsh-shud-raw-guard/             # tools/pre-execute 策略门插件（spike 1.2 TS 化）
    dsh-shud-jobs/                  # durable JobRegistry backend（ctx.jobs 契约）
    dsh-shud-tools/                 # shud_run / shud_collect 等模型可见工具
    dsh-shud-records/               # TaskCard/RunJob/RunRecord/StackLock/EvidenceReport 的 ctx.storage 域
    dsh-shud-presets/               # coordinator / worker / coder / reviewer agent preset 与 system prompt 段
  profile/
    shud/
      package.json                  # dsh bundle 声明（dsh.bundle.patch）
      cordis.patch.yml              # 模型路由、session-log-deepseek 关闭、以 workspace 包说明符挂载插件（bundle 声明 workspace:* 依赖）
      overlays/                     # 可选 --patch 覆盖（本机 / CI）
  skills/                           # SHUD 专用 SKILL.md（run-shud-tiny-case 等，经 dsh skill-filesystem 加载）
  scripts/                          # 确定性脚本（R/bash），非 LLM
  templates/                        # evidence_report.md 模板
  docs/                             # ADR + 计划 + 精简 spec（处置表执行后）
  openspec/                         # glossary + changes
  SHUD/ rSHUD/ AutoSHUD/            # 只读参考 submodule（保留）
```

每个 `dsh-shud-*` 包：`src/` TS strict，`tsc` 到 `lib/`，`vitest` 测试，`package.json` 声明 `peerDependencies["@deepseek-ai/dsh"] = "0.2.1-rc.2"`。Host 侧插件入口 `export const name` + `export function apply(ctx, config)`。不发 npm；profile 以 workspace 包说明符 `insert` 挂载（bundle 声明 `workspace:*` 依赖）：`profile/shud/package.json` 的 `dependencies["@shud-harness/dsh-shud-raw-guard"] = "workspace:*"`，patch 行的 `name: '@shud-harness/dsh-shud-raw-guard'`。

默认 `rawDirs: ["data/raw"]` 仅用于开发与探针；部署期真实 `<data_root>/raw` 必须在 workspace root 之外，由用户在 `$DSH_HOME/profiles/shud/cordis.patch.yml` 中以 `- id: shud-raw-guard` + `config: { rawDirs: ["<workspace 外的绝对路径>", ...] }` 覆写。`profile:install` 不生成或改写用户 patch，覆写结果可用 `--profile shud --dump-config` 查看。

## 2. 运行时资产（不进代码仓）

```text
$DSH_HOME/                          # dsh 家目录（本机 ~/.dsh 或显式指定）
  profiles/shud/                    # 由 profile/shud 初始化的 profile
  sessions/                         # session.v4.jsonl（回放 fixture 来源）
  storages/                         # ctx.storage 域（RunRecord 等）
<workspace>/                        # 每个研究任务的工作区（session cwd = workspace root）
  shud/                             # SHUD 二进制 + input/ + output/
  runs/<run_id>/                    # 作业日志、pid 记录、产物清单
  reports/                          # EvidenceReport Markdown
<data_root>/raw/                    # 原始数据，必须在 workspace root 之外（Seatbelt 只读）
```

## 3. 与 dsh 的边界

- dsh checkout（`../deepseek-harness`，钉 tag）只作只读运行宿主，不改源码、不作为构建宿主；类型来自插件包的 devDependencies `@deepseek-ai/dsh-tools@0.2.1-rc.2`（工具 seam）与 `@deepseek-ai/cordis@4.0.5`（`Context`），不从 checkout 引入。
- 本仓库永不 import dsh loop 内部；只挂 `docs/architecture.md` "Where new behavior goes" 列出的 seam。
- UI 若日后要做：client 插件走手写 JS（`dsh.client` 声明 + `window.__ModuleLoader__.load`），不引入 React 构建链。
