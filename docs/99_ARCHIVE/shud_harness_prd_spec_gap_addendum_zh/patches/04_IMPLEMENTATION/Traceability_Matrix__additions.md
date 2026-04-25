# Patch: Traceability_Matrix additions

**目标文档**：`docs/04_IMPLEMENTATION/Traceability_Matrix.md`  
**插入位置**：matrix 定义或附录。

## 建议表头

```markdown
| Requirement ID | Type | Priority | Source Doc | Implementation Module | Test ID | Phase | Release Gate | Status |
|---|---|---:|---|---|---|---|---|---|
```

## 示例行

```markdown
| FR-009 | functional | P0 | Observability_Monitoring_Spec.md | apps/server/health | OBS-HEALTH-001 | W1 | skeleton | approved |
| NFR-PERF-001 | non_functional | P0 | Performance_NFR_Spec.md | apps/server/api | PERF-API-001 | W1 | skeleton | approved |
| NFR-REL-001 | non_functional | P0 | Dependency_Versioning_Policy.md | CI | DEP-LOCK-001 | W0/W1 | skeleton | approved |
| GR-001 | governance | P0 | Auth_Permission_Design.md | apps/server/pi-gates | PI-DECISION-001 | W7 | mvp | approved |
```

## 规则

- P0/P1 release 前必须有 Test ID；
- status=verified 必须有通过记录；
- deprecated requirement 不删除，只标记；
- Traceability check 进入 CI。
