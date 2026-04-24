# MVP 文件树

## 1. 推荐仓库结构

```text
shud-harness-lite/
  README.md
  pyproject.toml
  shud_harness/
    cli.py
    tasks.py
    stacklock.py
    provenance.py
    jobs.py
    runs.py
    reports.py
    sandbox.py
    skills.py
    memory.py
    costs.py
    schemas/
  prompts/
    coordinator.md
    worker.md
    reviewer.md
  skills/
    run-shud-tiny-case/
      SKILL.md
      scripts/
    diagnose-shud-run-failure/
      SKILL.md
      scripts/
    rshud-roundtrip-test/
      SKILL.md
      scripts/
    summarize-sensitivity-results/
      SKILL.md
      scripts/
    build-task-report/
      SKILL.md
      scripts/
  scripts/
    shud/
    rshud/
    autoshud/
    metrics/
  templates/
    task_report.md.j2
    evidence_report.md.j2
  tests/
```

## 2. 工作区结构

```text
shud-workspace/
  config.yaml
  tasks/
    TASK-0001.yaml
  stacklocks/
    STACK-0001.yaml
  data_provenance/
    DATA-0001.yaml
  analysis_plans/
    PLAN-0001.yaml
  jobs/
    JOB-0001.yaml
  runs/
    RUN-0001/
      run_record.yaml
      output/
  reports/
    TASK-0001_report.md
  notes/
    NOTE-0001.yaml
  changes/
    CHG-0001.yaml
  artifacts/
  warehouse/
    shud_harness.duckdb
  repos/
    SHUD/
    rSHUD/
    AutoSHUD/
  workspaces/
    TASK-0001/
      worktrees/
      scratch/
      artifacts/
      traces/
```

## 3. 技术栈建议

```text
Python CLI: typer or argparse
YAML validation: pydantic / jsonschema
Storage index: DuckDB
Large metrics: Parquet
Plots/scripts: Python/R
Execution: subprocess + local job registry
Optional containers: docker CLI
```

## 4. 为什么不优先 TypeScript monorepo

SHUD 工作流已经大量依赖 R/Python/bash/C/C++。MVP 使用 Python CLI 更贴近科研工程日常，也更便于数据处理。

如果未来接入 ZeRo，再添加 adapter，而不是一开始把核心逻辑写进 ZeRo fork。
