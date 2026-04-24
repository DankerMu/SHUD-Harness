# 附录 C：建议的文件树

## C.1 运行时状态树
```text
.shud-harness/
  config/
  runtime/
    sessions/
    episodes/
    jobs/
    traces/
    heartbeat.json
  memory/
    working/
    episodic/
    semantic/
    procedural/
    epistemic/
    meta/
  skills/
    installed/
    registry.json
  memory-proposals/
  skill-proposals/
  benchmark-state/
```

## C.2 科研资产树
```text
shud-workspace/
  repos/
    SHUD/
    rSHUD/
    AutoSHUD/
  data/
    raw/
    processed/
  manifests/
    datasets/
    observations/
    preprocess/
    stacklocks/
    output-contracts/
  rcs/
  experiments/
  runs/
  evidence/
  changes/
  validation/
  warehouse/
  releases/
```

## C.3 技能树
```text
skills-src/
  run-shud-tiny-case/
  diagnose-shud-run-failure/
  rshud-roundtrip-test/
  add-shud-output-diagnostics/
  benchmark-before-after/
  build-provenance-complete-run/
```

## C.4 代码树
```text
apps/
  server/
  web/
  supervisor/

packages/
  runtime-*
  harness-*
  shud-*
```
