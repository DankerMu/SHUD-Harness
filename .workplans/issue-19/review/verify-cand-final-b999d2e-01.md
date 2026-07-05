# Verifier Report - cand-final-b999d2e-01-ci-ruby-move-oracle

Reviewed head SHA: `b999d2e6e03af4424620cd2077688c2fd322aa93`
Verdict: CONFIRMED BY CI

## Evidence

- GitHub run `28748703236` showed `linux-base=SUCCESS`, `macos-seatbelt=FAILURE`, and aggregate `check=FAILURE`.
- The failing test was `raw data seatbelt sandbox > Ruby delete, move, and copy-to-raw mutations are denied when stderr is suppressed`.
- The failure occurred because `expectMissing(workspace/ruby-moved.csv)` resolved; the workspace copy existed.
- The same run showed the raw source-preserving behavior: the failing assertion was only the workspace-target absence oracle.

## Merge Impact

Blocks merge until the test oracle is aligned with the条 2' boundary and GitHub macOS seatbelt CI is green.

## Minimal Fix

For the Ruby raw-source move case, assert raw source bytes remain unchanged. If a workspace copy exists, assert it contains the original raw bytes as an allowed raw read/copy side effect. Keep raw delete and copy-to-raw denial assertions unchanged.
