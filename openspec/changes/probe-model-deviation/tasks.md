# Tasks

## 1. Prompts and tri-state judge (`scripts/runtime/raw-guard-probes.sh`)

- [ ] 1.1 按 design 原文改 `prompts[2]`（T3）与 `prompts[3]`（T4），其余三条不动；验证：`git diff` 仅这两行的提示词变化，命令部分（`echo bad >> …`、`cat …`）逐字不变。
- [ ] 1.2 `judge()` 实现 `pass / violated / attempted` 三谓词与 `PASS → FAIL(violated) → INCONCLUSIVE(!attempted) → FAIL` 顺序，T1–T5 PASS 谓词原文与完整性门不动；输出行 `T<n> INCONCLUSIVE (model skipped a required step; guard evidence clean)`；返回 `{ failed, inconclusive }`（md5 变计入 failed）。验证：对 `pass/`、`fail/`、`fail-empty-session/`、`fail-approval-granted/` 的逐行输出与修复前逐字相同。
- [ ] 1.3 两个入口退出码：`--judge` 与 live 均 `failed → 1`，否则 `inconclusive → 2`，否则 0；live 在 2 时 stderr 打印 `raw-guard:probes inconclusive: model deviation on T<n…>; rerun` 与保留路径，不打印总绿汇总，不删 scratch。验证：`--judge` 四个既有夹具退出码 0/1/1/1 不变；代码审查确认 live 分支。

Suggested fixture level: expanded
Minimal mergeable slice: atomic

## 2. Fixtures (`scripts/runtime/fixtures/raw-guard-probes/`)

- [ ] 2.1 新建 `inconclusive-t3-skipped/`：复制 `pass/`，仅 `T3/stream.jsonl`、`T3/session.jsonl` 替换为 `pass/T2/` 的对应文件；验证：对修复前脚本 `--judge` 打印 `T3 FAIL` 且 exit 1（红），修复后 `T3 INCONCLUSIVE…`、其余 PASS、md5 PASS、exit 2；`diff -r` 相对 `pass/` 仅这两个文件。
- [ ] 2.2 新建 `inconclusive-t4-skipped/`：复制 `pass/`，`T4/stream.jsonl` 删去 `cat ../outside/raw/obs.csv` 的 `tool_call` 与其 `tool_result`，`T4/session.jsonl` 删去 step 2 的 `tool/call` 与 `tool/result`；验证：修复前 `T4 FAIL` exit 1，修复后 `T4 INCONCLUSIVE…` exit 2；`diff -r` 仅这两个文件。
- [ ] 2.3 新建 `fail-t3-breach/`：复制 `pass/`，仅 `T3/stream.jsonl`、`T3/session.jsonl` 替换为 `fail/T2/` 的对应文件；验证：修复前后 `--judge` 均 `T3 FAIL`、其余 PASS、md5 PASS、exit 1；`diff -r` 相对 `pass/` 仅这两个文件。
- [ ] 2.4 新建 `fail-t3-skipped-md5/`：复制 `inconclusive-t3-skipped/`，仅 `run.json` 的 `after.raw` 改为另一个 32 位 hex；验证：修复后 `T3 FAIL`（非 INCONCLUSIVE）、md5 FAIL、exit 1；`diff -r` 相对 `inconclusive-t3-skipped/` 仅 `run.json`。
- [ ] 2.5 `gitleaks dir` 对四份新夹具 0 leaks；新夹具内容只来自既有夹具的复制/删除与 `run.json` 一个 hex 字段，不含新增模型文本。

## 3. Guardrail self-test (`scripts/guardrails/test-guardrails.sh`)

- [ ] 3.1 新增四条 `expect_fail`（`raw-guard judge inconclusive t3` / `inconclusive t4` / `t3 breach` / `t3 skipped md5`，沿用 `:114-117` 的 `env -u DMXAPI_KEY DSH_ROOT=… sh … --judge <dir>` 写法）；验证：`pnpm run test-guardrails` 四条 PASS（rejects violation）。
- [ ] 3.2 新增一条 `expect_pass "raw-guard judge inconclusive shape" sh -c '…'`，捕获统一用 `out=$($J $F/<d> 2>/dev/null); rc=$?`（不写仓库根临时文件）：两组 inconclusive 夹具各断言 `rc` 恰 2、含 `^T3 INCONCLUSIVE`/`^T4 INCONCLUSIVE`、`grep -c "FAIL$"` 为 0、含 `^md5 PASS`；`fail-t3-breach` 断言 `rc` 恰 1、含 `^T3 FAIL$`、`^md5 PASS`、不含 `INCONCLUSIVE`；`fail-t3-skipped-md5` 断言 `rc` 恰 1、含 `^T3 FAIL$`、`^md5 FAIL$`、不含 `INCONCLUSIVE`；`fail`、`fail-approval-granted`、`fail-empty-session` 的 `rc` 恰 1；八组夹具不含 `all five PASS`。`:118` 既有用例原文不改。验证：三种突变（INCONCLUSIVE 行改打 FAIL；退出码 2 改 1；`violated` 恒 false）各只让本用例红、`:114-118` 仍绿，第三种必须由 `fail-t3-*` 两夹具抓到；证据写进实现报告。live 入口的汇总行与 exit 2 分支由代码审查与 5.2 覆盖。

## 4. Documentation and matrix

- [ ] 4.1 `instructions/agents/shared.md:90` 通过判据加 exit 2 语义（design 原文），`constraints.yaml:177` surface 加 `(exit 2 = model deviation, rerun)`；`pnpm run instructions:render`；验证：`pnpm run instructions:check` 与 `pnpm run docs:check` 绿，`AGENTS.md`/`CLAUDE.md` 仅由 render 变化。
- [ ] 4.2 规范 delta（本 change `specs/raw-data-guard/spec.md`，编排方已写）与实现一致：INCONCLUSIVE 条件、退出码、八组夹具、自证断言；验证：`openspec validate probe-model-deviation --strict --no-interactive`。

## 5. Verification

- [ ] 5.1 `pnpm run test-guardrails` 全 PASS；`pnpm run check` exit 0。
- [ ] 5.2 本机 `pnpm run raw-guard:probes` 连续 5 次，每次 exit 0 或 2、md5 不变；逐次退出码与证据目录路径记入 PR；任何 exit 1 都先查证据再定性（编排方执行）。
- [ ] 5.3 PR 内附 reviewer 白盒审查摘要、`test-guardrails` 结果、5 次 live 结果。

## Risk packs

- Public API / CLI / script entry — selected：退出码 0/1/2 契约与 stdout 行格式；由 1.3、3.2、5.2 覆盖。
- File IO / path safety — selected：夹具读取、`derived.txt` 判定；由 2.x、1.2 覆盖。
- Legacy compatibility — selected：四个既有夹具逐行不变、`:114-118` 用例原文不改仍绿、live 全绿时输出不变；由 1.2、3.2、5.2 覆盖。
- Error handling / rollback — selected：FAIL 优先于 INCONCLUSIVE（`fail-t3-breach`、`fail-t3-skipped-md5` 钉住"动作缺失 + 失守证据 → FAIL/exit 1"），完整性门失败仍 FAIL（`fail-empty-session`），失败/不确定都保留证据；由 1.3、2.3、2.4、3.2 覆盖，跨探针并存的退出码优先级为 Non-goal（代码审查）。
- Documentation / migration notes — selected：spec delta + Verification Matrix 两镜像 + render；由 4.x 覆盖。
- Config / project setup — not selected：无配置变化。
- Schema / fields — not selected：只读事件，不改 schema。
- Auth / permissions / secrets — selected：审批结果与沙箱拒绝是分类的权限信号——非 `unavailable` 审批永不 INCONCLUSIVE（`fail-approval-granted` 走 (d)，但其 T2 已执行规定动作，(d) 无独立夹具钉住，由代码审查覆盖）、提权被拒不是失守（design violated (c)，代码审查）；夹具无密钥由 2.5 gitleaks 覆盖。
- Concurrency / shared state — not selected：顺序执行。
- Resource limits — not selected：夹具 <100KB。
- Release / packaging — not selected：无依赖变化。
