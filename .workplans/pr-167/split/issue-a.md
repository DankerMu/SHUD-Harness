Part of #164

Implementation Ready: yes

**Module / Scope:** Source file ingress capability and source-record capacity contract

**OpenSpec change:** `m2-capability-observer-spike`

## In Scope

- Make both direct source-input kinds consume a descriptor-capability chain whose
  authority remains descriptor-relative after admission.
- Preserve bounded reads, no-follow component admission, stable error receipts,
  no writes, and no child process.
- Normalize source records so the admitted path/mode set is stored once and the
  primary/witness results bind it by digest and entry count.
- Preserve the user-approved node/item option 1, counting rules, and current
  byte/depth/node/item limits.

## Out of Scope

- Committed-oracle manifest semantics and synchronized frame/sidecar public
  evidence, owned by the dependent split issue.
- Live Git configuration, index, tracked-set, mode, object-format, filesystem
  generation, or manifest equality owned by #166.
- Aggregate evidence-collection budgets or publication vocabulary owned by #162.
- Supply authority, runtime integration, workflows, and network security.

## Current behavior

The source file reader admits components with no-follow descriptors and pins the
final file, but later reconstructs and opens the ambient absolute path to check
for replacement. This violates the requirement that authority remain
descriptor-bound after admission. Separately, a schema-valid source record uses
`42 + 6n` counted items for `n` admitted entries because the complete path/mode
set is repeated at top level and in both encoder results: 78 entries fit the
frozen 512-item limit and 79 do not.

## Desired behavior

After admission, reads and replacement checks use only retained capabilities and
descriptor-relative names; no filesystem-root or ambient absolute pathname is
opened or discovered. Replacement attempts fail without reading replacement
content, every acquired descriptor is released on success and failure, and the
two direct public input kinds retain exact receipt behavior.

The normalized record stores `entry_count`, `admitted_paths`, and
`admitted_modes` once. Each primary/witness result contains only `status`,
`source_input_digest`, `manifest_digest`, and `entry_count`; both result tuples
must exactly equal the corresponding top-level digest/count tuple. Under the
unchanged counting rules this is exactly `38 + 2n` items: 237 entries reaches
the inclusive 512-item boundary and 238 returns `CONTRACT_JSON_ITEM_LIMIT`.
The byte ceiling remains independently authoritative for long paths.

## Key interfaces

- Bounded source-file admission returning retained directory/final-file
  capabilities with deterministic cleanup.
- Descriptor-relative replacement verification that never reopens `/` or an
  ambient absolute path after the admission seam.
- Source-record ingress profile: 65,536 bytes, depth 12, nodes 2,048, items 512,
  with the approved `nodes = items + 1` interpretation unchanged.
- Normalized source record: one admitted path/mode set; primary and witness bind
  it through identical source-input digest, manifest digest, and entry count.
- Stable success/error receipt contract for `source_input_record` and
  `source_identity_projection`.

## Decision record

The user approved normalization: one admitted set plus primary/witness
digest/count binding. The 512-item limit, 2,048-node limit, parser counting, and
the earlier node/item option 1 remain unchanged. Repeating the full set or
raising limits is not permitted in this issue.

## Tasks

- [ ] Replace post-admission ambient path reconstruction with retained-capability,
  descriptor-relative verification across both direct input kinds.
- [ ] Add public regressions and an open/syscall tripwire proving zero root or
  absolute-path reopen after admission, plus deterministic replacement rejection
  and descriptor cleanup.
- [ ] Normalize the source-record schema and fixtures to one admitted set plus
  primary/witness digest/count binding, with exact 237-entry and +1 public
  boundary evidence under the unchanged profile.

## Acceptance Criteria

- [ ] Both direct input kinds succeed on canonical files with exact receipts and
  remain byte-identical across repeats.
- [ ] Upper/parent symlinks and ancestor/final replacement attempts return exit 2,
  empty stdout, one exact LF-terminated error receipt, and read no replacement
  bytes.
- [ ] A deterministic tripwire proves that no root or ambient absolute pathname
  is opened after the admission hook; all later checks are relative to retained
  capabilities.
- [ ] Descriptor stress evidence shows no handle growth across repeated success
  and every named failure path on Darwin and Linux.
- [ ] Focused tests, all applicable direct public commands, typecheck, strict
  OpenSpec validation, full repository check, and no-write/scope hygiene pass.
- [ ] A schema-valid record with 237 short canonical entries succeeds at exactly
  512 counted items; the otherwise-equivalent 238-entry record returns
  `CONTRACT_JSON_ITEM_LIMIT`, and both stay below the byte ceiling.
- [ ] Primary and witness results omit repeated path/mode arrays and are rejected
  unless their source-input digest, manifest digest, and entry count all equal
  the single top-level admitted set's tuple.
- [ ] Exact depth/item and +1 behavior, node/item option 1, canonical JSON,
  four-SHA identity, and all existing oracle tests are unchanged.

## Required reading

| Priority | Document / anchor | Focus |
|---|---|---|
| P0 | Issue #164, Must-preserve behavior and acceptance criteria | Descriptor-bound authority and frozen ingress behavior. |
| P0 | OpenSpec change `m2-capability-observer-spike`, Task 1.1a | Source ingress profiles, ownership exclusions, evidence floor. |
| P0 | PR #167 Round 5 synthesis and verification | `r5-path-01` and `r5-compat-01` exact evidence and required proof. |
| P1 | Issue #166 | Boundary: live Git and manifest equality remain outside this issue. |

**PR Boundary:** Source file-ingress capability, normalized source-record schema
and fixtures, direct-input public tests, and exact capacity proof only. No committed-oracle current checker,
OpenSpec live-manifest ownership rewrite, #166 implementation, #162 budgets,
production/runtime/workflow, or network-security changes.

**Suggested fixture level:** expanded - native path capabilities, replacement
races, resource cleanup, two public kinds, and a frozen capacity boundary require
cross-platform adversarial evidence.

**Minimal mergeable slice:** Retained descriptor-capability ingress for the two
direct input kinds plus zero-ambient-reopen and cleanup regressions; it is
independently green without the committed-oracle current checker.
