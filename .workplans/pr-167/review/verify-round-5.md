# Round 5 finding verification

Reviewed head: `0b832a825af9b352ccbb659c459f1acccf4c8618`

Independent verifier batch:

- `r5-design-01`: CONFIRMED / FIX_NOW / blocking;
- `r5-path-01`: CONFIRMED / FIX_NOW / blocking;
- `r5-evidence-01`: CONFIRMED / FIX_NOW / blocking.

Each passed T1/T2/T3 against the exact OpenSpec, Issue #164 must-preserve and
acceptance text, implementation, and public tests. Strict OpenSpec structural
validation being green does not resolve the semantic ownership contradiction.

Fresh gap sweep found `r5-compat-01`. A separate verifier reproduced the exact
capacity formula and 78/79 boundary, but classified the final-manifest trigger
as PLAUSIBLE because OpenSpec has no closed mandatory-file lower bound proving
the final set must reach 79. Under the expanded high-risk fixture, the plausible
P1 remains FIX_NOW and blocking.

No candidate includes #166 live implementation, #162 aggregate collection
budgets, or network security. See `round-5-candidate-synthesis-0b832a8.md` for
the complete failure-class synthesis and terminal gate result.
