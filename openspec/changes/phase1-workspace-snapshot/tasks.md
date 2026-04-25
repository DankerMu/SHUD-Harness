## 1. Workspace Service

- [ ] 1.1 Add workspace configuration and default workspace root.
- [ ] 1.2 Implement workspace initialization directory creation.
- [ ] 1.3 Implement path normalization and workspace escape rejection.

## 2. Snapshot Service

- [ ] 2.1 Implement TaskCard snapshot write with schema validation.
- [ ] 2.2 Implement atomic temp-file rename persistence.
- [ ] 2.3 Implement TaskCard snapshot read and list operations.
- [ ] 2.4 Implement local monotonic ID allocation for TaskCard IDs.

## 3. Tests

- [ ] 3.1 Test workspace initialization in a temporary directory.
- [ ] 3.2 Test path traversal rejection.
- [ ] 3.3 Test snapshot write/read/reload behavior.
- [ ] 3.4 Test invalid snapshot does not replace a valid snapshot.
- [ ] 3.5 Test monotonic ID allocation.
