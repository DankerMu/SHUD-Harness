# Verifier — object format config

Reviewed SHA: `011a20c7569a71d152341edfe7145b2ac8a14bca`

`cand-object-format`: CONFIRMED / FIX_NOW (P1 `contract`). The unscoped regex can accept unsupported `[extensions] objectFormat` as SHA-1 or treat an unrelated section key as SHA-256. T1 reaches the common config in normal/linked flows; T2 changes the public exact receipt; T3 is anchored by OpenSpec exact source authority. Fix belongs to this PR.
