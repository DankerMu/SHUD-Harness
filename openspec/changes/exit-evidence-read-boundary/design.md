## Context

The existing parser uses pathname readFile. Online/startup/cancellation paths call it seven times; collection additionally calls regularFile first. The latter owns established SYMLINK/NOT_REGULAR diagnostics and must remain.

## Decisions

- Change surface: shud-exit.ts, reader regression tests, poll-shud.test.ts, existing fault-adapter tests, active M2 design.
- Governing invariant: only bytes read from the same opened regular nonsymlink exit descriptor can authorize a numeric settlement; unsafe evidence remains unreadable, never absent or fabricated success.
- Use the file-output.ts precedent: O_RDONLY | O_NOFOLLOW | O_NONBLOCK, descriptor stat/isFile, descriptor readFile, finally close. No pre-lstat-only fix or per-callsite validation copy.
- Genuine missing open remains undefined. Final symlinks (including dangling links), FIFO, directories and read/stat/close failures return unreadable through the existing controlled diagnostic path. Strict integer parsing remains unchanged.
- Preserve the existing reader signature and all seven poll/reconcile callsites plus collection. Collector regularFile remains defense-in-depth and owns its static SYMLINK/NOT_REGULAR vocabulary, not the descriptor safety proof. ELOOP is already in the existing filesystem error vocabulary.
- Must preserve: valid zero/nonzero/signed safe integers, invalid text classification, EACCES/EIO unreadable causes, exit-first/reread precedence, failed/null/not-lost diagnostics, immutable source bytes, cancellation intent and collection retry behavior.
- Sibling surfaces: poll-shud-identity EACCES/diagnostic injection; kill-shud-faults held-read and permission injection; kill-shud-races two accepted-snapshot barriers; collect-shud-safety unreadable injection and protected-content tracking; collect-shud-retry exit-read accounting; reconcile-shud-terminal no-reread observations. Migrate these to the actual open/descriptor read seam at the equivalent ordering point, retaining unrelated pathname read faults. Qualify both read counters with an actual positive read through the shared reader (an existing eligible consumer scenario or a disposable probe), so zero/differential assertions cannot pass vacuously; do not add permanent wiring-only tests.
- Resource proof: real acquired handles are closed after success, nonregular rejection and read/stat failures; a close failure must not authorize numeric success or escape the result model. Do not introduce a new filesystem abstraction or retry policy.
- FIFO regression runs the reader in a Node child with an external finite timeout and forced child cleanup on timeout. Thus removal of O_NONBLOCK fails the test without leaving Vitest's worker blocked. The timeout is test containment, not a runtime fallback.

## Evidence and scope

- Tests-first semantic RED: an external regular target containing0 remains untouched yet the old reader accepts its number; the new reader rejects it. Registry proof must observe failed/null, unreadable detail without numeric-exit/lost wording, and collector's existing error behavior.
- FIFO without writer and a directory return unreadable; ordinary valid/invalid/missing controls remain correct. Real descriptors plus targeted I/O fault injection qualify cleanup/error boundaries, not mock echoes.
- Run focused reader/poll/collect/kill/reconcile suites, pnpm run check, pnpm run profile:smoke, pnpm run shud:tiny and pnpm run shud:restart on the final build. Real restart TERM/KILL must each satisfy existing assertions and delivered wake; these are engineering checks, not PI acceptance.
- No stochastic TOCTOU claim: descriptor binding removes dependence on path identity between validation and content read; do not claim a race was experimentally reproduced unless it was.
- No new schema fields, size caps, hardlink/inode identity tracking, ancestor-directory defense, writer changes, raw/host edits, runtime knobs or acceptance-gate relaxation.
- Review uses the invoked subagent-workflow expanded cap of three seats: correctness+invariant-state; test-evidence+spec-compliance; security-perf+integration. All Critical Path2/4 risks are covered within that cap.
- Rollback is a revert of this issue's commit through the normal PR gate; no parallel reader or compatibility shim is retained. The active m2-run-chain change and #293/#318 remain unclosed until PI acceptance.
