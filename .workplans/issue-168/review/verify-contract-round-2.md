# Round 2 verifier — contract

Reviewed head: `f49ac2704619bafa31504691daee2a2360ce3452`

Candidate: `contract-02`
Verdict: CONFIRMED
Disposition: FIX_NOW

The parser records pending item/node limits, but `number()` immediately throws
`CONTRACT_SCHEMA_INVALID` when a valid JSON number converts to infinity. Paired
reproductions showed 512 finite elements plus one finite value returns the item
limit, while the same shape ending in `1e9999` returns schema-invalid. Under a
relaxed item ceiling the equivalent 2,047-element pair returns node-limit versus
schema-invalid. This changes the public receipt after the same capacity crossing
and violates the specified accounting-before-semantic-trust order.
