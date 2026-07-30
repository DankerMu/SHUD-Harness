# PR #170 Round 2 test/evidence and OpenSpec review

Reviewed head: `f49ac2704619bafa31504691daee2a2360ce3452`
Verdict: not clean; two P1 candidates.

## P1 test-evidence — referenced Phase 6.2 audit is absent from HEAD

The manifest names
`.workplans/issue-168/review/phase-6-2-invariant-audit-052cb07.md`, but the ignored
file was not force-added: `git show`/`git cat-file` cannot resolve it at the
reviewed HEAD. A clean clone therefore cannot audit the two Phase 6.2 findings.
Track that file or an equivalent complete artifact and rerun evidence hygiene.
Blocking: yes.

## P1 task-boundary — existing workflow modification conflicts with the fixture

The PR adds focused commands to the existing Linux and macOS jobs while the
Issue/OpenSpec overlay marks workflows out and the governing spec says existing
workflows remain unchanged in favor of an isolated spike CI path. The evidence
simultaneously says workflows remain absent and calls this an accepted
deviation, without an approval anchor in the fixture. Reconcile the
implementation with the frozen boundary or record an explicit approved
exception and keep the OpenSpec/PR/evidence claims consistent. Blocking: yes.

Darwin 24/531, Linux 24/483, direct commands, both red-patch applicability,
fixed canonical bytes, exact depth/capacity, strict OpenSpec and the evidence
linter were checked. Network security and #162/#166/#169-exclusive scope were
excluded.
