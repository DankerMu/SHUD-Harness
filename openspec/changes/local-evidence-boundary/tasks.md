# Tasks

## 1. Preserve and demonstrate the boundary

- [x] 1.1 Parent snapshots existing evidence hashes and observes a disposable valid-but-unformatted change-name JSON fail formatting before edits; record issue-/PR-prefix controls without rerunning or modifying the original user-reported oracle files.
- [x] 1.2 Replace the issue-only Git rule with the one approved root evidence rule. Remove only the obsolete local PR-evidence exclude line; preserve unrelated local rules and separate review-gate exclusions. No formatter/CI command changes or extra ignore source.
- [x] 1.3 Add independent proposed ADR-0009 with PI decision, naming/ownership, no-oracle-rewrite and no-deliverables policy. Reference it once from the issue-workflow project-profile seam; canonical repository instructions explicitly route design/pipeline evidence writers to that profile and prohibit rewriting consumed evidence. Synchronize shared instruction matrix/enforcement and constraints. Parent renders generated instructions; never edit skill projections.

## 2. Verify and deliver

- [x] 2.1 Parent exercises actual Git/Prettier discovery for all three namespaces and format:check with probes present; verifies the same unformatted source control fails and formatted control passes. Prove saved evidence bytes and unrelated local excludes unchanged, no tracked evidence, and only owned probes removed.
- [ ] 2.2 Run full check, instruction/docs/ADR and strict fixture validation. Complete expanded review/adjudication, exact-head CI, merge/close #322 and archive only this independent change; #293/#318 remain unaccepted.

## Risk packs

- Selected Public API / CLI / script entry: 1.1/2.1 actual unchanged format command and public Git/Prettier discovery, source negative/positive controls.
- Selected Config / project setup: 1.2 single distributed ignore source; exact local migration separated from portable tracked change.
- Selected File IO / path safety / overwrite: 1.1 hashes, 1.2 precise local rule removal, 2.1 byte preservation and owned probe cleanup; no evidence rewrites/deletes.
- Selected Legacy compatibility / examples: 1.2 preserve review-gate and unrelated rules; 2.1 source-format controls remain blocking.
- Selected Documentation / migration notes: 1.3 ADR/control-plane mirrors and existing skill project-profile seam, 2.2 generated docs/links.
- Not selected Schema / columns / units / field names; Auth / permissions / secrets; Concurrency / shared state / ordering; Resource limits / large input / discovery; Error handling / rollback / partial outputs; Release / packaging / dependency compatibility: no runtime schema, credentials, shared algorithm, publication mechanism or dependencies change. Bounded local discovery probes and exact cleanup are covered above; no new scanners, retries or runtime rollback paths.
- Selected domain Scientific governance / PI gate / evidence lineage: 1.1/1.3/2.1 PI approval, independent ADR, unchanged evidence hashes and no-oracle-rewrite policy.
- Not selected domain Hydrology runtime / SHUD-rSHUD-AutoSHUD compatibility; dsh seam / profile / outbound-channel governance: no scientific execution, dsh runtime configuration or outbound behavior changes; the edited profile is workflow guidance only.

Minimal mergeable slice: the approved ignore contract, owned writer reference and mirrors, evidence preservation, and discriminating formatter/Git probes in one small change. No permanent test of literal ignore-file spelling; behavior is proven by throwaway public-command probes.