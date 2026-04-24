# I-01 仓结构与 Package Layout

## 模块状态标签
- **独立实现**：必须支持
- **ZeRo 参考实现**：强参考
- **[R] 已实现可复用**：apps/packages monorepo 组织
- **[M] 需修改后复用**：命名、目录责任边界
- **[N] 必须新增**：harness-* / shud-* 包与科研资产目录

## 1. 推荐目标结构
```text
shud-harness/
  apps/
    server/
    web/
    supervisor/

  packages/
    runtime-core/
    runtime-tools/
    runtime-model/
    runtime-memory/
    runtime-observe/
    runtime-scheduler/
    runtime-supervisor/
    runtime-secrets/

    harness-domain/
    harness-versioning/
    harness-skill/
    harness-memory/
    harness-eval/
    harness-artifact/
    harness-executor/
    harness-benchmark/
    harness-governance/

    shud-domain/
    shud-runner/
    shud-metrics/
    shud-validation/
    shud-provenance/

  prompts/
    commander/
    worker/
    critic/
    harness-optimizer/

  skills-src/
  docs/
  .shud-harness/
  shud-workspace/
```

## 2. `.shud-harness/` 与 `shud-workspace/`
### `.shud-harness/`
面向 runtime：
- config
- sessions
- episodes
- jobs
- memory
- skills
- traces
- benchmark state

### `shud-workspace/`
面向科研资产：
- repos
- data/raw
- data/processed
- manifests
- rcs
- experiments
- runs
- evidence
- changes
- validation
- warehouse
- releases

## 3. 与 ZeRo 的关系
### [R] 可以沿用
- `apps/*`
- `packages/*`
- prompt / docs / benchmarks 的目录风格
- `.zero` 作为 runtime state 的组织思路

### [M] 需要改
- 命名从 `zero-os` 语义切到 SHUD-Harness
- `.zero` 不再承担全部科研状态
- `packages/core` 不应直接塞入大量 SHUD 语义，宜新增 `harness-*` / `shud-*` 包

### [N] 必须新增
- `harness-versioning`
- `harness-executor`
- `harness-benchmark`
- `harness-governance`
- `shud-provenance`

## 4. Greenfield 路线建议
如果不 fork ZeRo，也建议保留类似的 `apps + packages` monorepo 结构。  
原因：
- 运行时与 UI 可分离
- domain 包和 runtime 包边界清晰
- 易于做后续 executor / benchmark / web 扩展

## 5. V1 最低要求
- 代码结构里能找到对象落点
- 运行时状态和科研资产分开
- 文档、schema、目录三者一致
