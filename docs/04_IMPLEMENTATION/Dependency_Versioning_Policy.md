# Dependency Versioning Policy

**状态**：v0.8.2 MEDIUM 新增实施规范  
**目标**：定义 Bun/npm 依赖锁定、核心库版本基线、依赖更新策略和 CI 检查，避免 StackLock 只覆盖系统依赖而遗漏 TypeScript 全栈依赖。

---

## 1. 管理范围

| 范围 | 示例 |
|---|---|
| package manager | Bun version、lockfile format |
| TypeScript stack | TypeScript、Zod、React、Hono、Vite/Build tool |
| data/warehouse | DuckDB Node client、Parquet/Arrow libs |
| testing | Bun test、Playwright、testing-library |
| security | secret scan、dependency audit |
| scientific runtime bridge | R invocation helpers、shell executor wrappers |
| submodules | SHUD、rSHUD、AutoSHUD、zero commit |

---

## 2. Lockfile 策略

1. 必须提交 Bun lockfile。
2. 仓库只允许一个 package manager lockfile source of truth。
3. `package.json` 必须设置 `packageManager`。
4. CI 必须使用 frozen/locked install。
5. 未经批准的 lockfile drift 阻塞 PR。

推荐：

```json
{
  "packageManager": "bun@1.3.x"
}
```

具体 patch 版本进入实现后由 lockfile 固定。

---

## 3. 核心依赖基线

> 注意：下表是 v0.8.2 开发前建议基线。真正实现时以 `package.json` + Bun lockfile + release manifest 为准。

| 组件 | MVP 建议 | 说明 |
|---|---|---|
| Bun | `1.3.x` 固定 patch | 使用 Bun runtime/package manager/test；CI 用相同版本 |
| TypeScript | `6.0.x` 或项目确认的稳定 minor | 不使用 nightly；TS 7 native preview 不进入 MVP |
| Zod | `4.3.x` | Zod 4 稳定后作为 schema source |
| React | `19.2.x` | 与 React DOM 版本一致；不引入 Server Components 到 MVP |
| Hono | 锁定一个 minor | API server 框架，禁止 floating latest |
| DuckDB Node client | 优先评估 `@duckdb/node-api` Neo client；如使用 deprecated `duckdb`，必须记录原因 | DuckDB 官方旧 Node client 已 deprecated，应在实现前决策 |
| Playwright | 锁定 minor | e2e/UI smoke |
| Markdown/HTML render deps | 锁定 minor | report export 不能依赖 floating latest |

---

## 4. DuckDB client 决策

实现前必须做一次 `DuckDB Client Selection Note`：

```text
候选 1: @duckdb/node-api / Node Neo
候选 2: duckdb deprecated node client
候选 3: shell out duckdb CLI for MVP
```

决策条件：

- Bun compatibility；
- native binding installation；
- CI platform support；
- API maturity；
- rebuild from filesystem records；
- failure behavior；
- security and maintenance status。

如果使用 deprecated `duckdb` package：

- 必须标记为 temporary；
- 必须有 migration plan；
- release notes 中说明；
- CI 需固定平台。

---

## 5. 依赖更新类型

| 类型 | 示例 | 策略 |
|---|---|---|
| security patch | CVE / compromised package | P0，尽快更新，跑 smoke + affected tests |
| patch update | bugfix | 可批量，每 2-4 周 |
| minor update | TS/Zod/React minor | 单独 PR，跑 schema/UI/report tests |
| major update | React 20、Zod 5、TS 7 | ChangeRequest + migration notes + full CI |
| native dependency update | DuckDB/SUNDIALS/GDAL | 必须跑 fixture/nightly，记录 StackLock |
| submodule update | SHUD/rSHUD/AutoSHUD/zero | ChangeRequest + compatibility tests |

---

## 6. DependencyLock schema 草案

```ts
interface DependencyLock {
  lock_id: string;
  created_at: string;
  package_manager: {
    name: "bun";
    version: string;
    lockfile_path: string;
    lockfile_sha256: string;
  };
  packages: Array<{
    name: string;
    version: string;
    dependency_type: "runtime" | "dev" | "peer" | "optional";
    source: "npm" | "git" | "local";
  }>;
  native_dependencies?: Array<{
    name: string;
    version: string;
    source: string;
    platform: string;
  }>;
  submodules: Array<{
    name: "SHUD" | "rSHUD" | "AutoSHUD" | "zero";
    commit: string;
    dirty: boolean;
  }>;
}
```

---

## 7. CI 检查

PR CI：

```text
bun --version
bun install --frozen-lockfile
dependency lockfile drift check
schema generate/check
dependency audit
secret scan
```

Nightly：

```text
outdated report
security advisory scan
native dependency install smoke
DuckDB client smoke
```

Release：

```text
DependencyLock generated
release manifest includes package manager + lockfile sha
submodule commits recorded
```

---

## 8. 依赖更新 PR 模板

```markdown
## Dependency update

Type:
- [ ] security patch
- [ ] patch
- [ ] minor
- [ ] major
- [ ] native dependency
- [ ] submodule

Packages:

Reason:

Risk:

Tests run:
- [ ] schema
- [ ] unit
- [ ] api
- [ ] websocket
- [ ] ui dummy
- [ ] report export
- [ ] ccw tiny/nightly if needed

Rollback plan:
```

---

## 9. 验收标准

- [ ] `packageManager` 已固定。
- [ ] lockfile 被提交。
- [ ] CI 使用 frozen install。
- [ ] Release manifest 记录 package manager、lockfile hash、core dependency versions。
- [ ] DuckDB client 选择有记录。
- [ ] major update 必须走 ChangeRequest。
- [ ] dependency audit 和 secret scan 进入 CI。
