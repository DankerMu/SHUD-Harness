# Tasks

## 1. Decision core (`packages/dsh-shud-raw-guard/src/decide.ts`, `decide-spelling.test.ts`)

- [x] 1.1 先加测试：design 列出的写归档、bsdtar、workdir、ask/next 钉住、资源行。验证：对未改的 `decide.ts` 运行 `pnpm vitest run packages/dsh-shud-raw-guard`，红绿划分须与 design「Required evidence」一致，既有行全绿。记录红行数。
- [x] 1.2 按 design 改 `TAR_COMMAND`，加 `tarArguments`、`TAR_ARCHIVE_WRITE`、`TAR_ARCHIVE_OPERAND`、`tarArchives`，第一遍写判定加 `writesArchive`。验证：同一命令全绿，既有行不变；`git diff` 中 `decide.ts` 只动这些位置。
- [x] 1.3 design 列出的二十七项突变各自让对应行变红（证据记入报告，不提交）。
- [x] 1.4 `pnpm run check` exit 0（覆盖率不降）；`pnpm run build`；`pnpm run test-guardrails`。

## 2. Spec

- [ ] 2.1 本 change 的 spec delta 与实现一致；验证：`openspec validate raw-guard-tar-archive --strict --no-interactive`。

## 3. Verification

- [ ] 3.1 `pnpm run raw-guard:probes`（编排方）跑两次：T1–T5 PASS，INCONCLUSIVE 则重跑；md5 不变。
- [ ] 3.2 PR 内附 reviewer 白盒审查摘要（Critical Paths #1/#2）、红→绿、突变表、probes 结果。

Suggested fixture level: expanded
Minimal mergeable slice: atomic（bsdtar 与写归档共用 `TAR_COMMAND`）

## Risk packs

- Public API / CLI / script entry — selected：`decideRawAccess` 决策契约；由 1.1、1.2 覆盖。
- File IO / path safety — selected：操作数按 workdir 解析、`-` 排除、`-C` 不改变归档路径；由 workdir 行、多 raw 行与突变 4、11、12、18 覆盖。
- Auth / permissions / secrets — selected：ask→deny 收紧；raw 作为打包源保持 ask；由 ask 钉住行覆盖。
- Legacy compatibility — selected：既有全部行（含 #279 的 `tar -cf o.tar prot` ask）与探针不变；由 1.1、3.1 覆盖。
- Documentation / migration notes — selected：spec delta；由 2.1 覆盖。
- Resource limits — selected：`tarArguments` 按段从第一个 tar 扫描，操作数正则线性；由五条资源行（含触及 raw 的超长旧式簇、大量 `(` 子段）与突变 14、19、27 覆盖。
- Config / project setup — not selected：无配置变化。
- Schema / fields — not selected：无 schema。
- Concurrency / shared state — not selected：纯函数；`TAR_ARCHIVE_OPERAND` 的 `g` 只用于 `matchAll`。
- Error handling / rollback — selected：归档操作数进入 `canonical`，可能抛 ENOTDIR/ENAMETOOLONG/EACCES/ERR_INVALID_ARG_VALUE；异常上抛，dsh 记为工具错误且不执行（fail-closed，同既有 `canonical`）；由 design 的说明覆盖，不另加行。
- Release / packaging — not selected：无依赖变化。
