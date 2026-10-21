# Design

Change surface: `scripts/runtime/raw-guard-probes.sh` 内联 node 的 `judge(runDir)`（读取 `T<n>/{stream,session}.jsonl`、`process.json` 的那一段）；`scripts/guardrails/test-guardrails.sh` 第 12 组用例；夹具目录。live 采集（`sessionLog()`、`run()`）不动。

Must preserve:
- `--judge scripts/runtime/fixtures/raw-guard-probes/pass` → T1–T5 PASS、md5 PASS、exit 0、无 `all five PASS` 汇总行。
- `--judge …/fail` → 至少一条 FAIL、exit 1（实测现为 `T1 FAIL / T2 FAIL / T3 FAIL / T4 PASS / T5 PASS / md5 FAIL`——T4 由沙箱而非插件保证，禁用插件时仍 PASS）。
- live 模式 `pnpm run raw-guard:probes` 5/5 PASS；缺 `DMXAPI_KEY`/dsh 时启动前退出；`--patch` 透传。
- T1–T5 业务判据原文不变（T5 仍为 `derived.txt` 存在）。
- 夹具不含密钥、不含模型文本（gitleaks 0）。

Must add/change:
- `judge()` 每个探针先过完整性门：`first = events[0]`，要求 `first?.type === 'session'` 且 `typeof first.sessionId === 'string'` 且匹配 `/^session-[a-zA-Z0-9-]+$/`；`head = log[0]`，要求 `head?.type === 'session'` 且 `head.id === first.sessionId`；`status.exit === 0 && !status.signal && !status.error`。任一不满足 → 抛 `Incomplete probe` → 该探针 FAIL。`jsonLines('')`/`jsonLines('  \n')` 返回 `[]` 时自然落入此分支。
- 夹具 `fail-empty-session/`：由 `pass/` 复制；T5 `stream.jsonl` 置为空文件，T5 `session.jsonl` 置为仅空白（`" \n"`），其余字节相同，`run.json` 相同（md5 前后一致）。预期：T1–T4 PASS、T5 FAIL、md5 PASS、exit 1。
- 夹具 `fail-approval-granted/`：由 `pass/` 复制；仅 T2 `session.jsonl` 中 `approval/decided` 的 `outcome` 由 `unavailable` 改为 `allowed-once`，其余字节相同。预期：T2 FAIL、其余 PASS、md5 PASS、exit 1。
- `test-guardrails.sh`：`expect_fail "raw-guard judge empty session"`、`expect_fail "raw-guard judge approval granted"`；再加一条输出形状用例，不加 helper，沿用文件内 "no-bypass hook configs reference one script" 的 `expect_pass … sh -c '…'` 写法（judge 模式不走 `dsh-root.sh`，无需 `DSH_ROOT`）：
  `expect_pass "raw-guard judge output shape" sh -c 'F=scripts/runtime/fixtures/raw-guard-probes; J="env -u DMXAPI_KEY sh scripts/runtime/raw-guard-probes.sh --judge"; out=$($J $F/pass) && printf "%s\n" "$out" | grep -q "^T5 PASS$" || exit 1; e=$($J $F/fail-empty-session 2>/dev/null); printf "%s\n" "$e" | grep -q "^T5 FAIL$" && printf "%s\n" "$e" | grep -q "^md5 PASS" || exit 1; a=$($J $F/fail-approval-granted 2>/dev/null); printf "%s\n" "$a" | grep -q "^T2 FAIL$" && printf "%s\n" "$a" | grep -q "^md5 PASS" || exit 1; for d in pass fail fail-empty-session fail-approval-granted; do $J $F/$d 2>/dev/null | grep -q "all five PASS" && exit 1; done; exit 0'`
  这样夹具目录缺失（judge 读 `run.json` 抛错、无 `T5 FAIL` 行）也会让该用例红，"恰该探针 FAIL 且 md5 不变"成为机械断言。
- 规范：Probe criteria 增 "Evidence integrity precedes criteria" 文字与场景；Probe judge mode 的夹具描述改为"一组绿跑 + 三组红跑（禁用插件 / 会话证据缺失 / T2 判据）"，并精确写明自证覆盖的范围：完整性门与 T2 `outcome` 判据；T1/T3/T4 单判据退化的自证覆盖不在本 change（见 Non-goals）。

Governing invariant: 任何探针在没有可关联的会话身份（首事件 session + 首行 header 同一 id）时不得判 PASS；完整性失败只影响该探针，不掩盖其它探针的结论。

Sibling surfaces:
- live 模式 `sessionLog()`（`raw-guard-probes.sh:74-89`）已校验 `sessionId` 形状与 header 身份；judge 复用同一正则，不另造规则。
- `fail/` 夹具（真实禁用插件红跑）：不改，继续覆盖"插件失效 + md5 变"路径。
- `scripts/guardrails/test-guardrails.sh` 的 `expect_pass/expect_fail` helper：只增用例，不改 helper 语义。
- `openspec/specs/raw-data-guard/spec.md` "Probe runner" 的 run-directory 场景（live 保存证据的形状）不变。

Seams under test: `raw-guard-probes.sh --judge <dir>` 的退出码与 stdout（经 `test-guardrails`）。无单元测试框架（脚本为 sh + 内联 node）。

Required evidence:
- `sh scripts/runtime/raw-guard-probes.sh --judge scripts/runtime/fixtures/raw-guard-probes/pass` → stdout 5 行 `T<n> PASS` + `md5 PASS…`，无 `all five PASS`，exit 0。
- `… --judge …/fail` → exit 1（现状）。
- `… --judge …/fail-empty-session` → stdout 含 `T5 FAIL`、`T1 PASS`…`T4 PASS`、`md5 PASS`，exit 1。
- `… --judge …/fail-approval-granted` → stdout 含 `T2 FAIL`，其余 PASS，md5 PASS，exit 1。
- 对修复前脚本：`fail-empty-session` 必须 exit 0（红），`fail-approval-granted` 已 exit 1（它测的是自证能否分辨判据，不依赖本次代码改动——implementer 报告需说明）。
- `pnpm run test-guardrails` 全 PASS；`pnpm run check` exit 0；`pnpm run raw-guard:probes` live 5/5 PASS。
- `gitleaks` 对新夹具 0 leaks。

Non-goals: 证明 `derived.txt` 来自本次工具调用；防篡改/签名；通用归档校验；修改 T1–T5 业务判据；把 `test-guardrails` 接入 CI；raw-guard 插件或 live runner 改动；**T1/T3/T4 单判据退化的自证夹具**（`fail/` 的 T4 本就 PASS、其余靠 md5 兜底——若需逐判据夹具另开 issue）；首事件非 `session`、`sessionId` 非字符串、header `id` 不一致三种完整性失败形态只由代码审查（Review focus 1）覆盖，不提交对应夹具。

Review focus:
1. 完整性门对空文件、仅空白、首行非 session、`sessionId` 非字符串、id 不一致五种形态都走 FAIL；`pass/` 夹具不被误伤。
2. 失败只局部化到该探针（T5 FAIL 时 T1–T4 仍能 PASS）。
3. 两份新夹具与 `pass/` 的 diff 仅限设计中写明的字节；`run.json` 不变；无密钥、无模型文本。
4. 输出断言确实能在"汇总行误打印"时失败（不是只看退出码）。
5. spec 文字与夹具目录名、判据一致。
