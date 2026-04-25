## Context

The canonical docs separate source submodules from runtime workspace state. Phase 1 must create the runtime directories and task snapshots without implementing job execution or artifact collection yet.

## Goals / Non-Goals

**Goals:**

- Initialize a workspace tree matching Phase 1 conventions.
- Persist TaskCard snapshots as schema-validated files.
- Provide atomic write behavior to avoid partial snapshots.
- Support reload after process restart.

**Non-Goals:**

- No RunJob execution, WebSocket event replay, or SHUD artifact collection.
- No multi-user locking beyond basic LockRecord skeleton compatibility.
- No database requirement; filesystem persistence is sufficient for Phase 1.

## Decisions

- Use a single configured workspace root, defaulting to `workspace/` unless overridden. This avoids the `workspace/` vs `shud-workspace/` drift by choosing one implementation path.
- Store TaskCard snapshots under `workspace/tasks/<task_id>/task.json` or equivalent schema-validated file.
- Use write-temp-then-rename for atomic persistence.
- Keep ID allocation monotonic and local to the workspace for Phase 1. Distributed ID allocation is out of scope.

## Risks / Trade-offs

- Filesystem persistence is not enough for later analytics. Mitigation: DuckDB/Parquet integration remains a later phase concern.
- Atomic renames vary across filesystems. Mitigation: require temp files and final files to live in the same directory.
- Path handling bugs can write outside workspace. Mitigation: normalize and reject paths escaping the configured workspace root.

## Migration Plan

- Add workspace service and snapshot service.
- Add tests using temporary directories.
- Update task API change to depend on these services instead of writing files directly.

## Open Questions

- JSON vs YAML persistence should be fixed during implementation. JSON is simpler for schema roundtrip; YAML may align with docs.
