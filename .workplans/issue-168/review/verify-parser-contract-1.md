# Verifier — parser-contract-1

Reviewed head SHA: `89eb2aad7895d837617d243a8ce82e3cdc45b211`

- `contract-01`: **CONFIRMED / FIX_NOW**. Reproduction returned
  `CONTRACT_JSON_MALFORMED` for 511 elements plus trailing comma,
  `CONTRACT_JSON_ITEM_LIMIT` for 512 plus comma, and
  `CONTRACT_JSON_NODE_LIMIT` for 2,047 plus comma under relaxed items. The
  parser counts a nonexistent post-comma value before syntax validation,
  violating the actual-element counting and stable malformed receipt contract.
