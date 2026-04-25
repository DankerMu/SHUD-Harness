# Manifest

## 新增正式文档

```text
docs/00_INDEX/PRD_Spec_Gap_Audit_v0_8_2.md
docs/00_INDEX/PRD_Spec_Merge_Map.md
docs/00_INDEX/Requirements_Catalog.md
docs/00_INDEX/Requirements_Numbering_Conventions.md

docs/03_SPEC/Observability_Monitoring_Spec.md
docs/03_SPEC/Alerting_Thresholds_Spec.md
docs/03_SPEC/Log_Aggregation_Spec.md
docs/03_SPEC/Performance_NFR_Spec.md

docs/04_IMPLEMENTATION/Operations_Runbook.md
docs/04_IMPLEMENTATION/Dependency_Versioning_Policy.md
docs/04_IMPLEMENTATION/Performance_Test_Plan.md
docs/04_IMPLEMENTATION/Observability_Test_Plan.md
```

## 逐文件补丁说明

```text
patches/00_INDEX/MASTER_INDEX__additions.md
patches/00_INDEX/CANONICAL_CONTRACTS__additions.md

patches/03_SPEC/Support_Schema_Contracts__additions.md
patches/03_SPEC/WebSocket_Protocol__additions.md
patches/03_SPEC/Config_Secrets_And_Environment_Spec__additions.md
patches/03_SPEC/Error_Handling_Spec__additions.md
patches/03_SPEC/Cost_Inference_Budget__additions.md

patches/04_IMPLEMENTATION/Schemas_APIs_CLIs__additions.md
patches/04_IMPLEMENTATION/Deployment_Architecture__additions.md
patches/04_IMPLEMENTATION/Testing_Strategy__additions.md
patches/04_IMPLEMENTATION/CICD_Release__additions.md
patches/04_IMPLEMENTATION/DOD_and_Risks__additions.md
patches/04_IMPLEMENTATION/Traceability_Matrix__additions.md
patches/04_IMPLEMENTATION/Phased_Plan__additions.md
```

## 合并后建议新增生成物

实现阶段建议从 Zod 自动生成：

```text
docs/generated/schema/observability.md
docs/generated/schema/requirements.md
docs/generated/schema/dependency-lock.md
docs/generated/schema/ops-incident.md
```
