# Tasks

## 1. Decision core (`packages/dsh-shud-raw-guard/src/decide.ts`, `decide.test.ts`)

- [ ] 1.1 先加测试（design 列出的默认配置行含 `DATA/RAW` 双分支、替身配置的 FS 敏感性双分支行含同名异例目录、无字母根的探测行、`case-probe.test.ts` 的三条 mock 探测行（全大写根小写回退、解析到不同路径、抛错）、根不存在行、文件工具分支钉现状行）；验证：对未改代码运行 `pnpm vitest run packages/dsh-shud-raw-guard/src/decide.test.ts`，新增的 deny/ask 决策行断言失败（红），直接调用 `caseInsensitiveRoot` 的行因导出不存在以 TypeError 失败（预期），next 行绿；分别记录两类红行数。
- [ ] 1.2 实现 `normalizeCommandPaths`、导出 `caseInsensitiveRoot`（无缓存；全大写根用小写拼写探测）、加法式 mention 判定；验证：同一命令全绿，`git diff` 只涉及 mention 段与两个新函数。
- [ ] 1.3 `pnpm run check` exit 0（knip 对新导出无报错）；`pnpm run build`；报告本机覆盖率，并说明 Linux CI 上不会执行的平台专属分支（mention 的 `"i"` 标志）。

Suggested fixture level: expanded
Minimal mergeable slice: atomic

## 2. Spec

- [ ] 2.1 本 change `specs/raw-data-guard/spec.md` delta（编排方已写）与实现一致：等价写法条款、大小写探测规则（含全大写根与不缓存）、`..` 已记录漏报、四个场景；验证：`openspec validate raw-guard-path-spelling --strict --no-interactive`。

## 3. Verification

- [ ] 3.1 `pnpm run raw-guard:probes`（编排方执行）：T1–T5 PASS 或 INCONCLUSIVE 重跑，md5 不变。
- [ ] 3.2 PR 内附 reviewer 白盒审查摘要（Critical Paths #1/#2）、红→绿证据、本机（不敏感）与 CI（敏感）各自分支的测试结果。

## Risk packs

- Public API / CLI / script entry — selected：`decideRawAccess` 的触及契约；由 1.1、1.2 覆盖。
- File IO / path safety — selected：路径等价写法、`realpathSync.native` 探测、根不存在；由 1.1 覆盖。
- Auth / permissions / secrets — selected：漏报修复把写从 next 拉回 deny、读拉回 ask（PI 审批）；大小写敏感 FS 上不误伤；由 1.1 双分支覆盖。
- Legacy compatibility — selected：全部既有行不变、探针不变；由 1.1、3.1 覆盖。
- Documentation / migration notes — selected：spec delta 与第三处已记录漏报；由 2.1 覆盖。
- Config / project setup — not selected：`rawDirs` 校验不变。
- Schema / fields — not selected。
- Concurrency / shared state — not selected：无缓存、无模块级状态，纯函数加只读 realpath。
- Resource limits — not selected：每次判定每个 raw 根多一次 realpath，与 `canonical()` 已有调用同量级。
- Error handling / rollback — not selected：探测失败一律回落敏感，无新错误路径。
- Release / packaging — not selected。
