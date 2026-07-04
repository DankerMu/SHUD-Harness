Reviewer agent: review-correctness
Review round: post-gate follow-up on 4717f16
Reviewed head SHA: 4717f1608058418a279365b385afc17e35e2238a
Summary: Raw-byte protection is mostly covered, but symlink-alias hidden denials and some programmatic process escapes can still produce false success or incomplete evidence.

Invariant Matrix Coverage:
- raw write denial: covered - seatbelt profile denies canonical `data/raw/**`; hardlink residual is explicitly demonstrated/scanned.
- raw read+workspace write compatibility: covered - legal raw read/workspace write and over-budget legal commands have regression coverage.
- hidden-denial evidence: missing - symlink alias writes can be sandbox-denied while the wrapper records `tool.completed/allowed`.
- process lifecycle containment: missing - Node programmatic process creation can evade the current token checks and fall back to best-effort PPID sampling.
- audit durability: covered - audit subtree/path sabotage and hardlink/symlink audit targets are guarded by tests.
- zero unchanged: covered - `git -C zero diff --quiet` exit 0; zero HEAD `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.

Findings:
- severity: P1
  failure class: hidden-denial evidence / false success
  violated invariant/contract: Symlink alias writes to `data/raw/**` are one of the six required escape classes and must return a remediation tool error, `tool.failed`, audit row with profile id, and `decision=denied_by_sandbox` when denied at OS layer.
  concrete scenario: `ln -s ../data/raw/symlink-hidden.txt workspace/link-to-raw.txt; printf hidden > workspace/link-to-raw.txt 2>/dev/null || true`. Creating the workspace symlink is allowed, the write through it is denied by seatbelt, stderr and exit status are hidden, and static target recognition does not mark the symlink target as a known raw write.
  evidence (file:line): `packages/core/src/tools/raw-data-sandbox.ts:634`, `packages/core/src/tools/raw-data-sandbox.ts:648`, `packages/core/src/tools/raw-data-sandbox.ts:453`, `packages/core/src/tools/raw-data-sandbox.ts:3784`, `packages/core/src/tools/raw-data-sandbox.ts:3808`, `packages/core/src/tools/raw-data-sandbox.ts:1964`, `packages/core/src/tools/raw-data-sandbox.test.ts:102`
  consequence: Raw bytes remain protected, but the caller and audit trail can see `tool.completed`/`allowed` instead of the required raw-denial evidence, so denial evidence no longer aligns across ToolResult/WS/audit/profile id.
  fix direction: Add symlink-aware hidden-denial detection for redirection targets that are or become symlinks to protected raw paths, including `ln -s <raw> <workspace-link>; write <workspace-link>` forms, or otherwise fail closed when a hidden write uses a filesystem alias whose raw target cannot be ruled out.
  required test/proof: Add visible and suppressed symlink-only cases, without a companion `../data/raw` command, and assert no raw mutation plus `raw_data_write_denied`, `tool.failed`, audit row, and matching profile id.
  sibling surfaces: pre-existing symlink aliases, command-created symlink aliases, child shell aliases, stderr/exit masking, WS event builder consumers.
  blocking status: blocking
- severity: P1
  failure class: process lifecycle containment / false success
  violated invariant/contract: Programmatic process creation that cannot be proven foreground-contained must fail closed; bash must not return success while invocation-owned descendants can later mutate workspace state.
  concrete scenario: `node -e 'const cp=require("child"+"_process"); cp.spawn("sh",["-c","sleep .25; printf leaked > workspace/node-dyn-leak.txt"],{["detached"]:true,stdio:"ignore"}).unref()'`. The module name and detached flag are constructed so the Node preflight misses them, and runtime containment then depends on race-prone PPID sampling after the parent exits.
  evidence (file:line): `packages/core/src/tools/raw-data-sandbox.ts:3528`, `packages/core/src/tools/raw-data-sandbox.ts:3542`, `packages/core/src/tools/raw-data-sandbox.ts:3596`, `packages/core/src/tools/raw-data-sandbox.ts:3611`, `packages/core/src/tools/raw-data-sandbox.ts:1569`, `packages/core/src/tools/raw-data-sandbox.ts:1617`, `packages/core/src/tools/raw-data-sandbox.test.ts:1660`
  consequence: A detached child can write allowed workspace files after the wrapper has finalized a successful ToolResult and appended an `allowed` audit row.
  fix direction: Treat Node/Bun process-creation calls as fail-closed when child process usage is detected but module binding or detached status cannot be statically proven safe, or move containment to an execution primitive that reliably owns/reaps descendants.
  required test/proof: Add a dynamic Node/Bun child-process regression using concatenated module name and computed `detached` property; assert containment failure or no post-return mutation after a settle window.
  sibling surfaces: normal completion, timeout, abort, audit append timing, future RunJob executor, other interpreters with computed module/function names.
  blocking status: blocking

Non-blocking notes:
- I did not execute the test suite; this was a read-only static review against the diff, specs, tests, and local git state.
