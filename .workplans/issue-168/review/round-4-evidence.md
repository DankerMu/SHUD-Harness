# PR #170 Round 4 evidence/OpenSpec review

Reviewed head: `cc89c89da7af3d68e0004766b495e5e72988036e`
Verdict: not clean; one P1 candidate.

## P1 task-boundary — capability owner is absent from the explicit In list

The PR adds `contracts/lib/capabilities.ts`, while the #168.A task's exact `In`
list names ingress, checker, canonical-json, constants and schemas only. The
Issue authorizes retained descriptor-capability ingress, but the fixture fails
to assign the new owner. Add `capabilities.ts` to the fixture's explicit owner
list and align design/PR/evidence without weakening behavior. Blocking: yes.

All 37 tracked evidence references resolved; evidence hygiene, red proof,
Darwin 25/541, Linux 25/493, direct commands, typecheck, full check, strict
OpenSpec, workflow equality and other scope exclusions were clean. Linux CI was
still running and remains a later gate.
