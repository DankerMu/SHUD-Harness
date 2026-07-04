# PR #48 round 5 review - correctness

Reviewer agent: review-correctness
Review round: round 5 comprehensive convergence check
Reviewed head SHA: `3acdba26d142cff9f9b004975fa5e29dca327dd5`

Summary: Round 5 is mostly converged, but one blocking wrapper-level gap remains: the sandbox launcher is invoked through an inherited shell/path environment, so the real seatbelt authority can be spoofed before it protects `data/raw/**`.

Invariant Matrix Coverage:
- Governing invariant: missing - `bash` raw writes are blocked when the real seatbelt runs, but the wrapper does not pin/sanitize the launcher path; see Finding 1.
- Source-of-truth identity/contract: covered - denial payloads carry rule, profile id, `ErrorRecord.remediation`, `tool.failed` mapping, and audit rows.
- Producers: missing - sandbox/profile/audit producers are present, but the bash producer delegates to bare `sandbox-exec` through Zero `BashTool`.
- Validators/preflight: missing - tests cover R4 regressions, but not PATH/BASH_ENV launcher spoofing; advisory also has a grouped-`cd` false positive.
- Storage/cache/query: covered - audit reservation, symlink/hardlink checks, `workspace/tasks` evidence protection, and profile cleanup are covered.
- Public routes/entrypoints: covered - no full route surface in scope; registry factory wraps bash/edit/spawn and rebuilds spawn against final registry.
- Frontend/downstream consumers: covered - M1 `tool.failed` skeleton is built from real raw-denial payloads with remediation/profile fields.
- Failure paths/rollback/stale state: missing - stale/contaminated process environment can affect the outer shell before the sandbox starts.
- Evidence/audit/readiness: missing - in the launcher-spoof scenario a raw mutation can be recorded as an allowed call instead of denial evidence.
- Six escape classes: covered under honest `/usr/bin/sandbox-exec` - tests exercise interpreter, pipeline/stdin, dynamic target, shell state/children, symlink/`../`, rename/unlink.
- Legal raw read and workspace write: missing - simple cases are covered, but grouped subshell workspace writes can be advisory-denied; see Finding 2.
- Pre-existing hardlink residual: covered - residual mutation is demonstrated and bounded `nlink>1` scan only traverses explicit protected roots.
- Advisory static raw write: missing - obvious root writes are covered, but fail-open behavior still has a legal workspace false positive.
- Zero clean: covered - zero remains pinned at `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6` with no diff observed.

Findings:
- Candidate finding 1: sandbox launcher can be resolved through an untrusted outer shell environment.
  Severity: P1
  Failure class: wrapper
  Violated contract/invariant: The execution-layer OS sandbox must be the authority for bash raw-write denial; protected `data/raw/**` bytes must not be mutable through the SHUD bash wrapper.
  Evidence with file:line: `packages/core/src/tools/raw-data-sandbox.ts:326` builds a string starting with bare `sandbox-exec`; `packages/core/src/tools/raw-data-sandbox.ts:329` delegates it to the inner Zero `BashTool`; `zero/packages/core/src/tool/bash.ts:350` runs that string via `bash -c`; `zero/packages/core/src/tool/bash.ts:355` passes inherited env; `zero/packages/core/src/tool/process-env.ts:3` copies `process.env`.
  Concrete scenario: Runtime is launched with `PATH` containing a project-writable bin directory before `/usr/bin`, or with a stale `BASH_ENV`. A prior allowed workspace write leaves a fake `sandbox-exec` in that bin directory. A later dynamic command such as `d=data; r=raw; p="$d/$r/input.csv"; printf MUTATED > "$p"` is not advisory-denied, the outer unsandboxed `bash -c` resolves the fake launcher, and the raw write executes without seatbelt enforcement.
  Consequence: The governing invariant can be violated with a valid bash call; the result can look like a successful allowed command and append an allowed audit row, leaving no raw-denial evidence.
  Fix direction: Do not launch the authority through a shell-resolved command. Spawn the verified absolute `/usr/bin/sandbox-exec` directly with argv, or add an equivalent direct launcher helper; sanitize launcher env at minimum by removing `BASH_ENV`/`ENV`/shell-function vectors and pinning PATH. Preserve the user command only as the sandboxed `bash -c` payload.
  Required verification: Add macOS regression tests that put a fake `sandbox-exec` earlier in `PATH` and assert a dynamic raw write is still denied by the real sandbox; add a `BASH_ENV` prelude that attempts to write raw before the command and assert raw remains unchanged and the call is denied/fails safely. Re-run `bun run check`.
  Sibling surfaces to audit: `createShudSandboxedBashTool`, envSecrets names such as `PATH`/`BASH_ENV`, future Linux sandbox backend, fuse-list behavior when launcher is no longer routed through Zero `BashTool`.
  Blocking status: Blocking.
- Candidate finding 2: advisory parsing can false-deny a legal workspace write inside a grouped `cd`.
  Severity: P2
  Failure class: contract
  Violated contract/invariant: Advisory checks are fail-open and must not block legal workspace writes that the sandbox would allow.
  Evidence with file:line: `packages/core/src/tools/raw-data-sandbox.ts:1160` splits on `&` without modeling grouping; `packages/core/src/tools/raw-data-sandbox.ts:828` only marks cwd ambiguous for exact `cd` command names; `packages/core/src/tools/raw-data-sandbox.ts:1298` treats relative `data/raw/...` as protected when ambiguity was not detected.
  Concrete scenario: `mkdir -p workspace/data/raw; (cd workspace && printf ok > data/raw/out.txt)` writes to `workspace/data/raw/out.txt`, not protected root `data/raw/**`. The tokenizer sees `(cd workspace` instead of `cd`, fails to mark cwd ambiguous, then sees `printf ... > data/raw/out.txt)` and returns `denied_by_advisory` before the OS sandbox can allow the legal workspace write.
  Consequence: A valid workspace write is blocked and misreported as a raw-data policy denial, creating incorrect audit evidence and reducing compatibility for common shell grouping patterns.
  Fix direction: Make advisory fail open when grouping/subshell syntax prevents reliable cwd tracking, or explicitly parse grouped `cd` forms before treating relative `data/raw` as protected. Keep the sandbox as the authority for uncertain cases.
  Required verification: Add positive tests for `(cd workspace && printf ok > data/raw/out.txt)`, `{ cd workspace; printf ok > data/raw/out.txt; }`, and child-shell grouped variants; keep root `printf nope > data/raw/root.txt` and suppressed raw-write negatives denied.
  Sibling surfaces to audit: `hasDynamicRawDataWriteRisk`, child-shell `bash -c` advisory recursion, failed-result denial classification using broad `data/raw` literal signals.
  Blocking status: Non-blocking P2; should be fixed or explicitly deferred because sandbox authority remains intact.

Non-blocking notes:
- The R4 fixes for audit reservation fail-close, protected `workspace/tasks`, public audit append requiring protected roots, registry wrapping/rebuilt spawn, WS remediation triplet, and legal raw-read denial-like output are all reflected in code/tests.
- I did not rerun the full test suite in this leaf review; this report is based on read-only diff/code inspection plus the supplied local verification summary.
