# PR #167 terminal split Stage 5.5 verification

Parent issue: #164
Superseded PR: #167
Children: #168 -> #169
Result: clean

The initial alignment review found three P1 gaps:

1. #169 did not turn the dependency capability wiring into a task and public
   acceptance proof for all four committed-oracle reads.
2. #169 did not require OpenSpec Task 1.1a to represent the child DAG and remain
   incomplete until both children close.
3. #168 had no finite capacity oracle while claiming implementation readiness.

The first two gaps were closed in #169's tasks and acceptance criteria. For the
third, the user selected a single admitted-set source-record shape: primary and
witness retain only status plus source-input/manifest digests and entry count.
The parser counting rules and byte/depth/node/item limits remain unchanged. The
new item formula is `38 + 2n`; an independent parser replay produced:

```text
237 entries, 4803 bytes: success (512 items)
238 entries, 4819 bytes: CONTRACT_JSON_ITEM_LIMIT (514 items)
```

Independent verification found all three findings resolved and no regression
across missing coverage, boundary, dependency, scope, references, or content
drift. Both issues carry the complete Stage 5 implementation-ready fields;
#169 has a literal `Depends on #168` line. Live Git authority (#166), aggregate
evidence budgets (#162), and network security remain excluded.
