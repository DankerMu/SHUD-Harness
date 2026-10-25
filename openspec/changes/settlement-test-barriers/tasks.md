# Tasks

## 1. Consumer barriers

- [x] 1.1 Preserved real site-1 RED in issue-349/check-fix1.txt and comment 6400746544; both poll-shud sites now drive completed-state barriers with existing assertions and pre-release drain unchanged. Focused native cases pass.
- [x] 1.2 Bad-record isolation now checks bad bytes/completed/cancellation on every iteration before healthy completion; existing post-wait assertions and protected siblings remain unchanged. All identity cases pass.
- [x] 1.3 Immediate native exit waits for explicit validated durable collectible state; full record/identity/artifact assertions remain. Issue comment 6401041840 documents the nonexistent completed-array correction; both exit codes pass.

## 2. Integration and delivery

- [x] 2.1 Three changed files pass 38/38 native tests; full pnpm run check passes 74 files, 1738 tests/1 existing skip, and strict OpenSpec validates. Diff audit shows only four sites plus two imports changed; all production/protected code remains unchanged. Outputs retained under issue-352; unobserved historical windows are not claimed reproduced.
- [ ] 2.2 Complete expanded review, exact-head CI and merge/close #352; archive only this fixture, preserving pending M2 PI acceptance.

## Risk packs

- Selected: Concurrency / shared state / ordering — tasks 1.1–1.3 assert true prerequisites, drive each iteration, preserve independent bad-entry invariants.
- Selected: Error handling / rollback / partial outputs — tasks 1.2/1.3 retain damaged-byte evidence, cleanup and rejected collection behavior; bounded waiter remains unchanged.
- Selected: Documentation / migration notes — design and task 1.3 record real fixture correction; no runtime behavior/documentation migration.
- Not selected: Public API / CLI / script entry; Config / project setup; Release / packaging / dependency compatibility — no API, entrypoint, config, dependencies or default changes.
- Not selected: File IO / path safety / overwrite; Schema / columns / units / field names; Auth / permissions / secrets — no production IO/schema/permission changes; existing evidence assertions retained by 1.1–1.3.
- Not selected: Resource limits / large input / discovery; Legacy compatibility / examples — reuse existing bounded helper unchanged, no new compatibility surface.
- Domain boundary: no scientific claims, SHUD/submodule edits, dsh host changes or PI gate closure; task 2.2 preserves acceptance boundary.
