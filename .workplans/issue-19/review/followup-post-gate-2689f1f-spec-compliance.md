Reviewer agent: review-spec-compliance
Review round: post-gate follow-up after V73 fixes
Reviewed head SHA: 2689f1f9bb82b23a86acd51418e40f8fafba3d04
Summary: Mostly covered, but one P2 spec-compliance gap remains: command-analysis budget overflow can pre-deny legal raw reads/workspace writes and labels that static denial as `denied_by_sandbox`.

Invariant Matrix Coverage:
- Task 3.3 / policy-gate-spike 条 2': missing - seatbelt enforcement and V73 rows are covered, but over-budget legal commands can be rejected before execution, contrary to fail-open/legal-read-write compatibility.
- Governing invariant: covered - ordinary create/modify/delete/rename/truncate attempts are denied by wrapper/sandbox tests.
- Source-of-truth identity/contract: missing - pre-exec budget uncertainty is emitted as `decision=denied_by_sandbox` even though no OS sandbox denial occurred.
- Producers: covered - profile builder, SHUD bash wrapper, advisory rule, audit helper, hardlink scanner, and WS skeleton exist.
- Validators/preflight: missing - tests codify fail-closed behavior for a legal workspace write over budget instead of proving fail-open under OS authority.
- Storage/cache/query: covered - profile files are per-run temp artifacts; audit path reservation and hardlink/symlink protections are tested.
- Public routes/entrypoints: covered - M1 scope is skeleton-only; no new WS event type introduced.
- Failure paths/rollback/stale state: covered - audit reservation/path sabotage and running metadata V73 cases are covered.
- Evidence/audit/readiness: covered - raw denial payload, audit row, profile id, and WS-compatible payload are synchronized for normal denial paths.
- Six escape classes: covered - interpreter, pipeline/stdin, dynamic target, child/grandchild, symlink/`../`, rename/unlink are tested.
- Legal raw read/workspace write: missing - ordinary positive cases pass, but budget overflow can block legal commands before sandbox execution.
- Hardlink residual and bounded scan: covered - residual is demonstrated and `nlink>1` scanner is bounded to explicit protected roots.
- Zero unchanged: covered - `zero` is clean and pinned at `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.

Findings:
- Severity: P2
  Failure class: spec-compliance / fixture weakening
  Contract or invariant: 条 2' says `data/raw/**` authority lives in the execution-layer OS sandbox, legitimate `data/raw` reads and workspace writes must not be affected, and pre-exec static checks are advisory/fail-open.
  Evidence: `openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md:23`, `packages/core/src/tools/raw-data-sandbox.ts:611`, `packages/core/src/tools/raw-data-sandbox.ts:645`, `packages/core/src/tools/raw-data-sandbox.ts:332`, `packages/core/src/tools/raw-data-sandbox.test.ts:2434`
  Scenario or repro: A legal command longer than `128_000` chars, such as `cat data/raw/input.csv # <large filler>` or `printf ok > workspace/out.txt 2>/dev/null; true # <large filler>`, exceeds analysis budget. `analyzeRawDataCommand()` sets `hasHiddenEvidenceRisk: true` on budget failure, `evaluateSuppressedSandboxFailureGuard()` denies, and the wrapper returns `denied_by_sandbox` before running the command.
  Consequence: Legal raw reads/workspace writes can be blocked due to static uncertainty, and the evidence stream claims an OS sandbox denial that never happened. The added test currently locks in that narrower behavior.
  Fix direction: On budget overflow, preserve the ADR split: avoid unbounded analysis, but do not convert unknown legal commands into raw-data denials. Either fail open to the OS sandbox when no bounded raw-mutation signal is proven, or return a distinct non-raw policy/error classification that does not claim `denied_by_sandbox` and is explicitly accepted by OpenSpec.
  Required verification: Add over-budget positive tests for legal raw read and legal workspace write; add an over-budget hidden raw-write test only if the bounded pre-scan can prove a raw mutation target or the spec is amended to allow a separate fail-closed resource policy.
  Sibling surfaces: `evaluateRawDataWriteAdvisory`, `evaluateSuppressedSandboxFailureGuard`, post-exec denial normalization, V73-10 evidence tests, future long multiline bash/R/Python scripts.
  Blocks merge: No as a P2 candidate, but it blocks declaring 条 2' fully spec-clean unless fixed or explicitly accepted as an OpenSpec exception.

Non-blocking notes:
- `git diff --check main...HEAD` passed; `zero` diff is clean and HEAD is pinned correctly.
- I did not rerun Bun tests locally because `bun` is not on PATH in this review environment; I reviewed the reported verification plus source/test evidence.
