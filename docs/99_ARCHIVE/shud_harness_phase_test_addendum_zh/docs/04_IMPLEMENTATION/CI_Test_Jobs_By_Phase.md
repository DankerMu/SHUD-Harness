# CI Test Jobs by Phase

**状态：** v0.8.1 CI 补充  
**目标：** 将测试阶段映射到 CI job，确保每一周新增能力进入自动化检查。

---

## 1. CI 总体结构

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

---

## 2. PR CI

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

---

## 3. Nightly CI

Nightly 建议跑：

| Job | 目的 |
|---|---|
| ccw-tiny | 真实 SHUD tiny run |
| rshud-roundtrip | rSHUD reader compatibility |
| batch-dummy | 3x3 sensitivity dummy batch |
| report-export-snapshot | standalone HTML export snapshot |
| recovery | service restart / uncollected job recovery |

---

## 4. Release CI

Release 前额外跑：

- submodule checkout and commit lock；
- release manifest generation；
- docs zip package；
- schema JSON package；
- report export sample；
- accepted report language guard；
- no secrets in artifacts；
- sample workspace package。

---

## 5. Phase-to-CI mapping

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

---

## 6. GitHub Actions skeleton

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

---

## 7. 不建议 PR 必跑的测试

以下测试成本高或环境复杂，放 nightly/manual：

- ccw tiny true SHUD run；
- full sensitivity batch；
- Docker runner integration；
- future SLURM adapter；
- SMTP real email；
- LLM model calls。
