# CI/CD 与发布

**状态：** P2 实施规范  
**适用范围：** GitHub Actions、schema drift、文档检查、submodule lock、release  
**目标：** 防止设计、schema、实现和 submodule 状态漂移。

## 1. CI 阶段

推荐流水线：

```text
checkout with submodules
→ install dependencies
→ lint markdown
→ typecheck TypeScript
→ test schema
→ test reducers
→ test WebSocket protocol
→ test sandbox path policy
→ build web app
→ package docs
```

## 2. CI 总体结构

```text
checkout-submodules
→ install
→ docs
→ schema
→ unit
→ integration
→ websocket
→ ui-e2e-dummy
→ fixture-nightly
→ release-check
```

## 3. PR CI

PR 必跑：

| Job | 命令草案 | 覆盖 |
|---|---|---|
| docs | `bun run docs:lint && bun run docs:links` | 文档链接、格式、canonical 标注 |
| schema | `bun run schema:generate && bun run schema:check` | Zod/JSON Schema/Markdown drift |
| unit | `bun test packages/core` | schema、reducers、path、metrics |
| api | `bun test packages/backend --filter api` | REST + filesystem |
| websocket | `bun test packages/backend --filter websocket` | seq/reconnect/snapshot |
| sandbox | `bun test packages/core --filter sandbox` | path policy、secret redaction |
| web-build | `bun run build:web` | React build |
| ui-dummy | `bun run test:e2e:dummy` | Dashboard → task → dummy job → report |

## 4. Nightly CI

Nightly 建议跑：

| Job | 目的 |
|---|---|
| ccw-tiny | 真实 SHUD tiny run |
| rshud-roundtrip | rSHUD reader compatibility |
| batch-dummy | 3x3 sensitivity dummy batch |
| report-export-snapshot | standalone HTML export snapshot |
| recovery | service restart / uncollected job recovery |

## 5. Release CI

Release 前额外跑：

- submodule checkout and commit lock
- release manifest generation
- docs zip package
- schema JSON package
- report export sample
- accepted report language guard
- no secrets in artifacts
- sample workspace package

## 6. Phase-to-CI mapping

| Week | 新增 CI job 或测试集 |
|---:|---|
| W0 | docs + submodule parse + readiness YAML |
| W1 | schema + api task + ui skeleton |
| W2 | stack/data/artifact tests |
| W3 | runner + WebSocket + recovery smoke |
| W4 | ccw tiny nightly |
| W5 | rSHUD roundtrip + patch artifact tests |
| W6 | batch progress + heatmap tests |
| W7 | report export + PI gate + notification mock |
| W8 | Zero adapter + natural language e2e demo |

## 7. GitHub Actions skeleton

```yaml
name: ci
on: [push, pull_request]

jobs:
  docs:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: recursive
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bun run docs:lint
      - run: bun run docs:links

  schema-unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: recursive
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bun run schema:generate
      - run: bun run schema:check
      - run: bun test packages/core

  integration:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: recursive
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bun test packages/backend
      - run: bun run test:e2e:dummy
```

## 8. 不建议 PR 必跑的测试

以下测试成本高或环境复杂，放 nightly/manual：

- ccw tiny true SHUD run
- full sensitivity batch
- Docker runner integration
- future SLURM adapter
- SMTP real email
- LLM model calls

## 9. Submodule 检查

CI 应检查：

- 四个 submodule 是否初始化；
- StackLock 测试是否能读取 commit；
- submodule path 是否与文档一致；
- release tag 是否记录 submodule commit。

## 10. Schema drift 检查

如果存在 Zod schema 和 Markdown schema，两者必须同步。推荐生成 schema docs，而不是手工维护两份。

CI 检查：

```text
bun run schema:generate
 git diff --exit-code docs/generated/schema
```

### 补充 CI 检查项

- `.gitmodules` 格式验证
- 文档链接检查（`docs:links`）
- Schema 生成与 drift 检查（`schema:generate` + `schema:check`）
- docs 和 sample artifacts 的 secret 扫描
- Support schema 测试
- Artifact manifest 测试
- Idempotency 测试

## 11. 文档检查

Markdown lint 至少检查：

- 链接是否存在；
- 同名标题；
- 代码块闭合；
- 文件路径是否英文；
- canonical/superseded 标注。

文档链接检查必须确认 `MASTER_INDEX.md` 中列出的每个文件存在。

## 12. Release 内容

每次 release 应包含：

```yaml
release:
  version: 0.8.x
  harness_commit: ...
  submodules:
    SHUD: ...
    rSHUD: ...
    AutoSHUD: ...
    zero: ...
  schema_version: ...
  prompt_version: ...
  skills_version: ...
```

## 13. Artifact 发布

可发布：

- Web build；
- docs zip；
- schema JSON；
- sample workspace；
- tiny fixture instructions。

不要发布：

- API keys；
- raw large data；
- 用户私有 RunRecord；
- 大型模型输出。

## 14. 版本策略

建议：

```text
0.8.0-design      # 设计补齐
0.8.1-skeleton    # deterministic skeleton
0.8.2-tiny-run    # ccw tiny run
0.8.3-zero-agent  # 接入 Zero AgentLoop
```

## 15. v0.8.2 新增 CI 检查

### PR CI 新增

```text
requirements-check:
  - verify unique requirement IDs
  - verify P0/P1 acceptance criteria
  - verify Traceability refs

dependency-check:
  - bun --version
  - bun install --frozen-lockfile
  - dependency audit
  - lockfile drift check

observability:
  - health endpoint tests
  - structured log tests
  - redaction tests

perf-smoke:
  - metadata API latency smoke
  - WebSocket reconnect smoke
```

### Nightly 新增

```text
perf-nightly:
  - report generation benchmark
  - batch progress benchmark
  - MVP concurrency smoke

ops-drill:
  - disk critical simulation
  - stale dummy job
  - DuckDB corruption/rebuild simulation
  - SMTP mock failure
```

### Release 新增

- Performance budget report；
- DependencyLock；
- Requirements coverage summary；
- Ops runbook drill summary；
- secret scan summary；
- health/deep diagnostics sample。

## 16. 验收标准

- [ ] CI 能 checkout submodules。
- [ ] TypeScript typecheck 通过。
- [ ] schema drift 检查通过。
- [ ] 文档链接检查通过。
- [ ] release manifest 记录四个 submodule commit。
- [ ] docs zip 使用英文文件名，内容可为中文。
