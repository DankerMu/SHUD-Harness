# Verifier — resource-cleanup-1

Reviewed head SHA: `89eb2aad7895d837617d243a8ce82e3cdc45b211`

- `res-01`: **CONFIRMED / FIX_NOW**. `readBoundedFile` selects a primary
  `CONTRACT_BYTES_LIMIT`, then `closeAll` can throw
  `CONTRACT_SCHEMA_INVALID` from `finally` and overwrite it. Fault injection
  reproduced the wrong public code while showing all closes were attempted.
  Admission cleanup has the same ordering. Preserve the selected primary,
  settle every close, and test admission/post-admission cleanup faults.
