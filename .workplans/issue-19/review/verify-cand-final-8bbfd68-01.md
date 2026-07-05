Verifier verdict for: cand-final-8bbfd68-01-raw-ancestor-rename
Reviewed head SHA: 8bbfd68eb474e9d27386fe13a05fb1b549bb5198
Verdict: CONFIRMED
Evidence: `raw-data-sandbox.ts:238-257` emits allow rules for every `allowedWriteRoot` and deny rules only for protected raw/evidence leaf/subpaths; ancestor literal deny generation is evidence-only at `raw-data-sandbox.ts:206-207` and `414-434`. Tests construct the reachable broad-root setup with `allowedWriteRoots: [fixture.root]` at `raw-data-sandbox.test.ts:3952-3954`, while advisory `mv` detection only flags operands inside `data/raw` (`raw-data-sandbox.ts:2216-2226`, `3308-3315`), so `mv data data.moved; printf MUTATED > data.moved/raw/input.csv` is not guarded by raw ancestor denial despite the rename invariant in `design.md:168` / `spec.md:34-35`.
Note: Audit ancestor rename is protected by evidence-only ancestor literals; raw ancestors have no analogous guard or regression.
