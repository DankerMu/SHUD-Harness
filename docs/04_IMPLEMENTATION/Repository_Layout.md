# 仓库结构 (TypeScript 全栈，基于 Zero)

## 1. 代码仓库结构

```text
shud-harness/                        # TypeScript monorepo (Bun workspace)
  package.json                       # workspace root
  bunfig.toml
  packages/
    core/                            # 扩展 Zero 核心
      src/
        agent/
          coordinator.ts             # Coordinator 角色定义 + system prompt
          worker.ts                  # Worker 角色定义
          reviewer.ts                # Reviewer 角色定义
          park-resume.ts             # Park/Resume 长任务状态机
          research-closure.ts        # 科研 Closure Classifier 扩展
        tools/
          shud-build.ts              # SHUD 编译工具
          shud-run.ts                # SHUD 运行工具
          rshud-parse.ts             # rSHUD 输出解析
          water-balance.ts           # 水量平衡计算
        domain/
          schemas/                   # Zod schemas (前后端共享)
            task.ts                  # TaskCard
            stacklock.ts             # StackLock
            provenance.ts            # DataProvenance
            job.ts                   # RunJob
            run-record.ts            # RunRecord
            analysis.ts              # AnalysisPlan
            report.ts                # EvidenceReport
            change.ts                # ChangeRequest
          services/
            task-service.ts
            job-service.ts
            report-generator.ts
            sandbox.ts
            memory-service.ts
            cost-tracker.ts
    backend/                         # Hono API 服务
      src/
        routes/
          tasks.ts                   # /api/tasks/*
          jobs.ts                    # /api/jobs/*
          reports.ts                 # /api/tasks/:id/report
          analysis.ts                # /api/analysis/*
          stacks.ts                  # /api/stacks/*
          data.ts                    # /api/data/*
          patches.ts                 # /api/patches/*
          notes.ts                   # /api/notes/*
        ws/
          chat.ts                    # WebSocket: LLM 对话流
          logs.ts                    # WebSocket: Job 日志流
          events.ts                  # WebSocket: 全局事件推送
        middleware/
          auth.ts
          sandbox-guard.ts
    frontend/                        # React Web UI
      src/
        pages/
          Dashboard.tsx              # 任务概览 + 成本面板
          TaskDetail.tsx             # 任务详情 + 日志 + 报告
          ReportView.tsx             # Markdown 报告渲染
        components/
          ChatInterface.tsx          # 实时对话
          LogViewer.tsx              # 日志流展示
          ApprovalButtons.tsx        # PI 审批按钮
          CostDashboard.tsx          # LLM + compute 成本面板
          TaskList.tsx               # 任务列表
          JobStatus.tsx              # Job 状态卡片
        api/
          client.ts                  # API client (共享 Zod schemas)
  prompts/
    coordinator.md, worker.md, reviewer.md
  skills/
    run-shud-tiny-case/SKILL.md
    diagnose-shud-run-failure/SKILL.md
    rshud-roundtrip-test/SKILL.md
    summarize-sensitivity-results/SKILL.md
    build-task-report/SKILL.md
  scripts/                           # 确定性脚本 (R/bash, 非 LLM)
    shud/build.sh, run.sh
    rshud/read_output.R, water_balance.R, roundtrip_test.R
    metrics/sensitivity_table.ts, tornado_plot.ts
  templates/
    task_report.md.j2
    evidence_report.md.j2
  tests/
```

## 2. 工作区结构 (运行时资产，不进代码仓)

```text
shud-workspace/
  config.yaml
  tasks/TASK-*.yaml
  stacklocks/STACK-*.yaml
  data_provenance/DATA-*.yaml
  analysis_plans/PLAN-*.yaml
  jobs/JOB-*.yaml
  runs/RUN-*/
    run_record.yaml
    output/
  reports/TASK-*_report.md
  notes/NOTE-*.yaml
  changes/CHG-*.yaml
  artifacts/
  warehouse/shud_harness.duckdb
  repos/SHUD/, repos/rSHUD/, repos/AutoSHUD/
  data/raw/ (只读), data/processed/
  workspaces/TASK-*/
    worktrees/, scratch/, artifacts/, traces/
```

## 3. 技术栈

```text
Runtime:     Bun
Backend:     Hono (TypeScript)
Frontend:    React (TypeScript)
Schemas:     Zod (前后端共享类型)
Storage:     DuckDB (metrics warehouse)
Metrics:     Parquet
Real-time:   WebSocket (对话流 + 日志流 + 事件)
Scripts:     R/bash (确定性计算脚本, 非 LLM)
Execution:   Bun subprocess + local job registry
Foundation:  Zero agent runtime (AgentLoop, Session, Tool, Memory, Skills)
```

## 4. 为什么选择 TypeScript 全栈

Web 是用户唯一交互渠道。全栈 TypeScript 的优势：

- 前后端共享 Zod schema，一处定义两端使用
- Zero 提供成熟的 agent 基础设施，直接复用
- 1.5 人团队维护一种语言，减少认知负担
- SHUD 的科学计算（水文求解、空间分析）由 C++ 和 R 完成，Harness 只是编排层
