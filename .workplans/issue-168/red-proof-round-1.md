# Issue #168 Round 1 behavioral red proof

Command:

`npx --yes bun@1.2.19 test spikes/git-status-capability/contracts/tests`

Mutation source: `.workplans/issue-168/red-proof-round-1.patch`. The patch is
source-only and compiling. It bypasses descriptor verification and the central
authority import boundary, overwrites a primary error on cleanup failure,
reintroduces post-comma accounting, rejects legal depth 12, lowers the item
ceiling, permits result-shape extras, removes canonical key sorting, and accepts
four-SHA drift.

Applicability check: `git apply --unidiff-zero --check
.workplans/issue-168/red-proof-round-1.patch` passes against the restored fixed
source.

Observed result: exit `1`; `13 pass`, `10 fail`, `141 expect() calls`.

Named failures:

- `canonical source records preserve canonical JSON and byte-identical repeat receipts`
- `central capability boundary is the only OS authority import and direct commands preserve input bytes`
- `upper and parent symlinks plus ancestor and final replacements fail without reading replacement bytes`
- `success and every named failure restore descriptor baseline across repeated loops`
- `close faults preserve primary errors, settle every descriptor, and make cleanup-only failure stable`
- `each primary and witness tuple mismatch and any reintroduced admitted array is rejected`
- `237 entries are exactly 512 items and succeed while 238 are 514 and hit only the item limit`
- `a missing array value after comma is malformed before item or node accounting`
- `legal depth 12 reaches schema validation and depth 13 returns only the depth limit for both kinds`
- `every independent and synchronized strict-subset four-SHA forgery fails`

The fixed source was restored immediately with `apply_patch`; byte comparison
against the pre-mutation source snapshots passed, the focused suite then returned
`23 pass`, `0 fail`, `529 expect() calls`, and no stash was created.
