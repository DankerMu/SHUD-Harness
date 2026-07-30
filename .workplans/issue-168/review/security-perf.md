# PR #170 Round 1 — security/performance (path/resource)

Reviewer agent: security-performance
Reviewed head SHA: `89eb2aad7895d837617d243a8ce82e3cdc45b211`
Summary: One blocking parser-contract candidate; network security excluded.

## Finding

### P1 contract — trailing-comma arrays consume a nonexistent item before syntax validation

- Contract: item count covers actual members/elements and malformed JSON returns `CONTRACT_JSON_MALFORMED`.
- Scenario/evidence: with 512 scalar elements plus a trailing comma, `array()` calls `countItem()` before detecting the missing value and returns `CONTRACT_JSON_ITEM_LIMIT`; 511 plus comma returns malformed. Under relaxed item limits the same pattern can consume a nonexistent node.
- Consequence: the stable rejection taxonomy changes solely because malformed input lies near a resource boundary.
- Fix/proof: detect `]`/invalid value-start after comma before item/node accounting; public regressions for both kinds at 512+comma and parser regression at the node boundary.
- Siblings: every `parseBoundedJson` profile. Blocking: yes.

Invariant matrix: descriptor/no-follow/resource pairing and bounded read are covered by current code; parser ordering is not.
