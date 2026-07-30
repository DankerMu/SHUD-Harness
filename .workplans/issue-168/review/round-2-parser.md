# PR #170 Round 2 parser/contract review

Reviewed head: `f49ac2704619bafa31504691daee2a2360ce3452`
Verdict: not clean; one P1 candidate.

## P1 contract — valid non-finite number overrides a pending limit

After 512 array elements, a 513th syntactically valid JSON number `1e9999`
crosses the item ceiling, but `number()` immediately throws
`CONTRACT_SCHEMA_INVALID`; both public kinds therefore lose the pending
`CONTRACT_JSON_ITEM_LIMIT`. With a relaxed item ceiling, 2,047 scalars followed
by `1e9999` similarly loses the pending node limit. This makes a valid +1
capacity rejection depend on the scalar's representability.

Delay the non-finite semantic error until syntax completes and settle errors in
this order: malformed/duplicate/depth, first pending item/node limit, then
schema-invalid. Required controls cover both public kinds, the relaxed-node
profile, and standalone `1e9999`, while retaining all existing exact/+1 tests.
Blocking: yes.

Focused tests were 24/24 with 531 assertions; malformed, duplicate, depth,
237/238, 2,048/2,049, 38+2n, tuple, four-SHA, canonical-byte and receipt surfaces
were inspected without another candidate.
