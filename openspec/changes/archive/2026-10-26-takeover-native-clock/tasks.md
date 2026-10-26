## Risk packs

- Selected: Concurrency / shared state / ordering — native clock coherence, preserved fake interval registration and exact cancellation thresholds; tasks1.1–1.3.
- Selected: Error handling / rollback / partial outputs — failure diagnostics survive file cleanup without altering original exceptions, cleanup order or global restoration; task1.2.
- Selected: Documentation / migration notes — this fixture and public diagnosis/PR distinguish controlled mechanism from historical CI attribution; task1.4.
- Not selected: Public API / CLI / script entry; Config / project setup; File IO / path safety / overwrite; Schema / columns / units / field names; Auth / permissions / secrets; Resource limits / large input / discovery; Legacy compatibility / examples; Release / packaging / dependency compatibility — no production APIs, file semantics, formats, configuration, dependencies or release policy change. Existing fixture-only diagnostic reads are bounded to this test's owned run and must not change cleanup.

## 1. Coherent native startup and failure diagnostics

- [x] 1.1 Record the controlled Linux RED with1200ms post-freeze delay, lost result/live wrapper/zero registration, and Date-only startup GREEN preserving fake intervals and every original assertion. Restore temporary source byte-for-byte before implementation; publish the causal limit on historical CI.
- [x] 1.2 Implement the coherent startup Date boundary and failure-only diagnostics in the existing shared R3/R5 test. Prove identical1200ms injection GREEN; inject a body assertion failure with nested harness errors and a post-cleanup failure to verify actual default-reporter output includes original error, full harness errors, labelled durable fields and registration count. Exercise unavailable evidence and ensure diagnostics cannot mask the primary failure. Prove existing interval registration is not reinstalled/discarded and Date/timer restoration holds. Remove all probes/delays/DEBUG output before permanent verification.
- [x] 1.3 Run the entire takeover-shud-lifecycle file20 consecutive times on Linux and20 on macOS, all four tests each time; preserve every existing assertion and all production bytes. Run pnpm run check and exact-head CI. No retries/skips or threshold relaxation.
- [x] 1.4 Complete one correctness+test-evidence Critical Path4 white-box review, publish exact commands/outcomes/platform limits and the unchanged packages relationship to docs-only #372; preserve #293/#318 PI gates and active m2-run-chain.
