# Round 1 — Resource / Path / Performance

Reviewer agent: `issue164_r1_resource_path`
Reviewed head SHA: `e984729b30db43bdc22af738ddacc23fbbb8a751`

Summary: three P1 candidates affecting source authority, independent limits, and bounded current-source IO.

## Findings

### P1 — Current authority accepts staged-vs-HEAD drift and misses non-spike candidates

- Failure class: `data-integrity`
- Invariant: manifest/current authority must bind the current HEAD complete candidate set.
- Scenario: stage changed covered bytes while HEAD differs, or add an untracked OpenSpec/workflow candidate; checker succeeds.
- Evidence: `current-source.ts:93-201` reads index/worktree only and inventories only `spikes/**`; temporary reproduction succeeded with distinct HEAD/index blobs and untracked spec.
- Consequence: downstream evidence can be based on uncommitted or incomplete source authority.
- Fix: bind to explicit HEAD/source commit tree and compare every candidate lane.
- Required proof: staged covered drift and untracked spec/workflow fail; clean HEAD/index/worktree succeeds.
- Siblings: index reader, filesystem inventory, manifest sync, #165/#166 reuse.
- Blocks merge: yes.

### P1 — Node limit is dominated by item limit

- Failure class: `contract`
- Invariant: byte/depth/node/item bounds are independently exact/+1 with stable codes.
- Scenario: production source/metadata profiles reach item limit before the advertised node limit; node error is unreachable.
- Evidence: profiles 2048/512 and 32768/8192; parser counts; tests relax sibling limits; real profile returns item-limit.
- Consequence: frozen taxonomy and evidence claim cannot be met.
- Fix: align counting semantics/profile/spec to make each boundary independently reachable, or explicitly redefine the contract with recorded authority.
- Required proof: real public profiles exact/+1 with exact codes.
- Siblings: future profiles/owners.
- Blocks merge: yes.

### P1 — Current-source discovery and file reads are unbounded

- Failure class: `resource`
- Invariant: selected file/resource pack must fail deterministically within frozen bounds.
- Scenario: huge tracked covered file or very wide untracked spike tree causes whole-file allocation or unbounded traversal before mismatch.
- Evidence: recursive `readdir`/path accumulation at `current-source.ts:137-153`, whole-file `readFile` at `:171-180`.
- Consequence: OOM/termination can bypass the single bounded receipt.
- Fix: freeze/enforce count/depth/file/aggregate budgets and incremental hashing.
- Required proof: exact/+1 large file and discovery cases with no write/child process.
- Siblings: filesystem inventory, worktree verification, later expansion.
- Blocks merge: yes.

## Invariant Matrix

Producer oracle covered; validator/current-authority and node bounds have findings; storage none; entrypoint exact receipt covered but false-success/resource paths remain; downstream can inherit; ordinary failures are bounded but OOM can bypass; 24 focused tests pass. Network/auth excluded.
