import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z, type ZodType } from "zod";

import { ArtifactSchema } from "../../packages/dsh-shud-core/src/schemas/artifact.ts";
import { ArtifactManifestSchema } from "../../packages/dsh-shud-core/src/schemas/artifact-manifest.ts";
import { BuildRecordSchema } from "../../packages/dsh-shud-core/src/schemas/build-record.ts";
import { ChangeRequestSchema } from "../../packages/dsh-shud-core/src/schemas/change-request.ts";
import { DataProvenanceSchema } from "../../packages/dsh-shud-core/src/schemas/data-provenance.ts";
import { ErrorRecordSchema } from "../../packages/dsh-shud-core/src/schemas/error.ts";
import {
  EvidenceReportSchema,
  PiGateDecisionSchema,
} from "../../packages/dsh-shud-core/src/schemas/evidence-report.ts";
import { IdempotencyRecordSchema } from "../../packages/dsh-shud-core/src/schemas/idempotency.ts";
import { LockRecordSchema } from "../../packages/dsh-shud-core/src/schemas/lock.ts";
import { RunJobSchema } from "../../packages/dsh-shud-core/src/schemas/run-job.ts";
import { RunRecordSchema } from "../../packages/dsh-shud-core/src/schemas/run-record.ts";
import { StackLockSchema } from "../../packages/dsh-shud-core/src/schemas/stack-lock.ts";
import { TaskCardSchema } from "../../packages/dsh-shud-core/src/schemas/task.ts";
import { VerificationCaseSchema } from "../../packages/dsh-shud-core/src/schemas/verification-case.ts";

export type SchemaDefinition = {
  name: string;
  slug: string;
  sourcePath: string;
  exportName: string;
  schema: ZodType;
  strictInput?: boolean;
  exampleOverrides?: Readonly<Record<string, unknown>>;
};

type ObjectSchemaExport = {
  exportName: string;
  sourcePath: string;
  schema: ZodType;
};

export type IgnoredObjectSchemaExport = {
  exportName: string;
  sourcePath: string;
  reason: string;
};

export const schemaDefinitions: SchemaDefinition[] = [
  {
    name: "TaskCard",
    slug: "task-card",
    sourcePath: "packages/dsh-shud-core/src/schemas/task.ts",
    exportName: "TaskCardSchema",
    schema: TaskCardSchema,
    exampleOverrides: {
      task_id: "TASK-20261027T080005-3f9c",
      stack_id: null,
      data_id: null,
      linked_jobs: ["JOB-20261027T081000-0123"],
      linked_reports: ["REPORT-20261027T090000-5b10"],
    },
  },
  {
    name: "StackLock",
    slug: "stack-lock",
    sourcePath: "packages/dsh-shud-core/src/schemas/stack-lock.ts",
    exportName: "StackLockSchema",
    schema: StackLockSchema,
    strictInput: true,
    exampleOverrides: {
      stack_id: "STACK-20261027T080000-3f9a",
      repos: {
        SHUD: {
          commit: "9b55b0cb9b55b0cb9b55b0cb9b55b0cb9b55b0cb",
          branch: "master",
          dirty: false,
          dirty_paths: [],
          dirty_paths_truncated: false,
        },
        rSHUD: {
          commit: "d162db3d162db3d162db3d162db3d162db3d162d",
          branch: "master",
          dirty: false,
          dirty_paths: [],
          dirty_paths_truncated: false,
        },
        AutoSHUD: {
          commit: "1cbec6f1cbec6f1cbec6f1cbec6f1cbec6f1cbe",
          branch: "master",
          dirty: false,
          dirty_paths: [],
          dirty_paths_truncated: false,
        },
      },
      runtime: { os: "Darwin 24.6.0", sundials_version: null, host_version: "0.2.1-rc.2" },
      harness: { version: "0.9.0" },
      llm: {
        base_url: "https://www.dmxapi.cn",
        request_alias: "deepseek-flash-guan",
        response_model: "deepseek-flash-guan",
      },
    },
  },
  {
    name: "DataProvenance",
    slug: "data-provenance",
    sourcePath: "packages/dsh-shud-core/src/schemas/data-provenance.ts",
    exportName: "DataProvenanceSchema",
    schema: DataProvenanceSchema,
    strictInput: true,
    exampleOverrides: {
      data_id: "DATA-20261027T081000-7d2e",
      basin: "ccw",
      event_window: { start: null, end: null },
      sources: {
        input_root: "/workspace/input/ccw",
        files: [{ path: "ccw.sp.mesh", sha256: "sha256:mesh", size_bytes: 1024 }],
      },
      preprocess: null,
      uncertainty_notes: null,
    },
  },
  {
    name: "EvidenceReport",
    slug: "evidence-report",
    sourcePath: "packages/dsh-shud-core/src/schemas/evidence-report.ts",
    exportName: "EvidenceReportSchema",
    schema: EvidenceReportSchema,
    strictInput: true,
    exampleOverrides: {
      report_id: "REPORT-20261027T090000-5b10",
      task_id: "TASK-20261027T080005-3f9c",
      status: "draft",
      summary: "Two ccw runs provide evidence from distinct stacks and inputs.",
      observations: ["Both runs produced output artifacts."],
      limitations: ["No scientific metrics were collected."],
      pi_questions: ["Should these runs proceed to scientific review?"],
      linked_runs: ["RUN-20261027T083000-b2c3", "RUN-20261027T082000-a1b2"],
      stack_ids: ["STACK-20261027T081500-b2c3", "STACK-20261027T080000-a1b2"],
      data_ids: ["DATA-20261027T081500-8e3f", "DATA-20261027T081000-7d2e"],
      llm_response_models: ["deepseek-flash-guan"],
      decision_history: [],
      created_at: "2026-10-27T09:00:00Z",
      updated_at: "2026-10-27T09:00:00Z",
    },
  },
  {
    name: "PiGateDecision",
    slug: "pi-gate-decision",
    sourcePath: "packages/dsh-shud-core/src/schemas/evidence-report.ts",
    exportName: "PiGateDecisionSchema",
    schema: PiGateDecisionSchema,
    strictInput: true,
    exampleOverrides: {
      decision_id: "DEC-20261027T093012-c4e7",
      report_id: "REPORT-20261027T090000-5b10",
      approval_ref: "call-report-submit-1",
      outcome: "accepted",
      comment: null,
      decided_at: "2026-10-27T09:30:12Z",
    },
  },
  {
    name: "Artifact",
    slug: "artifact",
    sourcePath: "packages/dsh-shud-core/src/schemas/artifact.ts",
    exportName: "ArtifactSchema",
    schema: ArtifactSchema,
    strictInput: true,
  },
  {
    name: "ArtifactManifest",
    slug: "artifact-manifest",
    sourcePath: "packages/dsh-shud-core/src/schemas/artifact-manifest.ts",
    exportName: "ArtifactManifestSchema",
    schema: ArtifactManifestSchema,
    strictInput: true,
    exampleOverrides: {
      manifest_id: "MANIFEST-33333333-3333-4333-8333-333333333333",
      superseded_by: "MANIFEST-44444444-4444-4444-8444-444444444444",
    },
  },
  {
    name: "ErrorRecord",
    slug: "error-record",
    sourcePath: "packages/dsh-shud-core/src/schemas/error.ts",
    exportName: "ErrorRecordSchema",
    schema: ErrorRecordSchema,
  },
  {
    name: "IdempotencyRecord",
    slug: "idempotency-record",
    sourcePath: "packages/dsh-shud-core/src/schemas/idempotency.ts",
    exportName: "IdempotencyRecordSchema",
    schema: IdempotencyRecordSchema,
  },
  {
    name: "LockRecord",
    slug: "lock-record",
    sourcePath: "packages/dsh-shud-core/src/schemas/lock.ts",
    exportName: "LockRecordSchema",
    schema: LockRecordSchema,
  },
  {
    name: "RunJob",
    slug: "run-job",
    sourcePath: "packages/dsh-shud-core/src/schemas/run-job.ts",
    exportName: "RunJobSchema",
    schema: RunJobSchema,
    strictInput: true,
    exampleOverrides: {
      job_id: "JOB-20261022T031500-a1b2",
      run_id: "RUN-20261022T031500-a1b2",
      task_id: null,
      stack_id: null,
      data_id: null,
      backend: "local_job",
      status: "submitted",
      project: "ccw",
      label: "Run the ccw example",
      input_dir: "/models/input/ccw",
      run_dir: "/workspace/runs/RUN-20261022T031500-a1b2",
      command: ["/usr/local/bin/shud", "-o", "output/ccw.out", "ccw"],
      end_days: 30,
      owner_session: null,
      dsh_job_id: null,
      dsh_job_ids: [],
      pid: null,
      pid_started_at: null,
      input_bytes: 1024,
      submitted_at: "2026-10-22T03:15:00Z",
      started_at: null,
      finished_at: null,
      cancel_requested_at: null,
      exit_code: null,
      llm: {
        response_model: "deepseek-chat",
        response_model_source: "response",
      },
      notify: {
        status: "pending",
        attempts: 0,
        at: null,
        detail: null,
      },
    },
  },
  {
    name: "RunRecord",
    slug: "run-record",
    sourcePath: "packages/dsh-shud-core/src/schemas/run-record.ts",
    exportName: "RunRecordSchema",
    schema: RunRecordSchema,
    strictInput: true,
    exampleOverrides: {
      run_id: "RUN-20261022T031500-a1b2",
      job_id: "JOB-20261022T031500-a1b2",
      task_id: null,
      stack_id: null,
      data_id: null,
      status: "succeeded",
      command: ["/usr/local/bin/shud", "-o", "output/ccw.out", "ccw"],
      exit_code: 0,
      exit_class: "ok",
      artifacts: {
        stdout: "/workspace/runs/RUN-20261022T031500-a1b2/stdout.log",
        stderr: "/workspace/runs/RUN-20261022T031500-a1b2/stderr.log",
        shud_output: "/workspace/runs/RUN-20261022T031500-a1b2/output/ccw.out",
        files: [{ path: "flow.dat", size_bytes: 1024 }],
      },
      numerical_health: {
        water_balance_residual: null,
        cvode_failures: null,
        negative_state_count: null,
        max_solver_dt: null,
      },
      resources: { wall_seconds: 60, peak_memory_mb: null },
      llm: {
        response_model: "deepseek-flash-guan",
        response_model_source: "configured",
      },
      collected_at: "2026-10-22T03:16:00Z",
    },
  },
  {
    name: "ChangeRequest",
    slug: "change-request",
    sourcePath: "packages/dsh-shud-core/src/schemas/change-request.ts",
    exportName: "ChangeRequestSchema",
    schema: ChangeRequestSchema,
    strictInput: true,
    exampleOverrides: {
      change_id: "CHG-20261102T093000-4a1f",
      task_id: "TASK-20261102T090000-3f9c",
      source_path: "repos/SHUD",
      base_commit: "9a422e5eb708df7d2f8b4066a3083a031d679a82",
      files_changed: ["Makefile", "src/Model/MD_rhs_core.cpp"],
      semantic_level: "numerical_implementation",
      semantic_floor: "numerical_implementation",
      floor_categories: ["numerical_implementation"],
      risk: "high",
      patch_path: "patches/CHG-20261102T093000-4a1f.patch",
      patch_sha256: "a".repeat(64),
      status: "proposed",
      approval_ref: null,
      approved_at: null,
      description: "Restore the RHS build flag for the replay.",
      created_by: "coder",
      created_at: "2026-11-02T09:30:00Z",
      updated_at: "2026-11-02T09:30:00Z",
    },
  },
  {
    name: "VerificationCase",
    slug: "verification-case",
    sourcePath: "packages/dsh-shud-core/src/schemas/verification-case.ts",
    exportName: "VerificationCaseSchema",
    schema: VerificationCaseSchema,
    strictInput: true,
    exampleOverrides: {
      vc_id: "VC-20261102T101500-0c3e",
      task_id: "TASK-20261102T090000-3f9c",
      change_id: "CHG-20261102T093000-4a1f",
      bundle_id: null,
      case_type: "regression",
      expected_result_source: "baseline_regression",
      target_code_targets: ["Makefile", "src/Model/MD_rhs_core.cpp"],
      description: "Compare the pinned base and candidate rivqdown outputs.",
      expected_result: "Identical rivqdown bytes at one thread.",
      pass_criteria: "sha256(candidate rivqdown.dat) == sha256(base rivqdown.dat)",
      base_run_id: "RUN-20261102T100100-a1b2",
      candidate_run_id: "RUN-20261102T101000-b2c3",
      base_build_id: "BUILD-20261102T100000-7b2d",
      candidate_build_id: "BUILD-20261102T100500-8c3e",
      artifact_refs: [
        "runs/RUN-20261102T100100-a1b2/output/keliya.out/keliya.rivqdown.dat",
        "runs/RUN-20261102T101000-b2c3/output/keliya.out/keliya.rivqdown.dat",
      ],
      observed: {
        compared_path: "output/keliya.out/keliya.rivqdown.dat",
        base_sha256: "a".repeat(64),
        candidate_sha256: "a".repeat(64),
      },
      status: "passed",
      failure_reason: null,
      reviewed_by: "reviewer",
      reviewer_notes: ["The compared output bytes match for this replay."],
      compatibility_verdict: "compatible",
      created_at: "2026-11-02T10:15:00Z",
    },
  },
  {
    name: "BuildRecord",
    slug: "build-record",
    sourcePath: "packages/dsh-shud-core/src/schemas/build-record.ts",
    exportName: "BuildRecordSchema",
    schema: BuildRecordSchema,
    strictInput: true,
    exampleOverrides: {
      build_id: "BUILD-20261102T100000-7b2d",
      task_id: "TASK-20261102T090000-3f9c",
      change_id: null,
      patch_sha256: null,
      source_path: "repos/SHUD",
      source_commit: "9a422e5eb708df7d2f8b4066a3083a031d679a82",
      source_branch: "replay/base",
      dirty_paths: [],
      make_argv: [
        "make",
        "-C",
        "builds/.tmp-BUILD-20261102T100000-7b2d/src",
        "shud",
        "SUNDIALS_DIR=/opt/sundials",
      ],
      sundials_dir: "/opt/sundials",
      rhs_openmp: false,
      compiler: "Apple clang version 17.0.0",
      exit_code: 0,
      duration_seconds: 8.25,
      binary_path: "builds/BUILD-20261102T100000-7b2d/shud",
      binary_sha256: "b".repeat(64),
      stdout_path: "builds/BUILD-20261102T100000-7b2d/make.stdout.log",
      stderr_path: "builds/BUILD-20261102T100000-7b2d/make.stderr.log",
      created_at: "2026-11-02T10:00:00Z",
    },
  },
];

const ignoredNestedObjectSchemaExports: IgnoredObjectSchemaExport[] = [
  {
    exportName: "ErrorRemediationSchema",
    sourcePath: "packages/dsh-shud-core/src/schemas/error.ts",
    reason: "nested helper for ErrorRecordSchema.remediation",
  },
  {
    exportName: "InferenceBudgetSchema",
    sourcePath: "packages/dsh-shud-core/src/schemas/task.ts",
    reason: "nested helper for TaskCardSchema.inference_budget",
  },
];

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const schemaSourceDir = join(repoRoot, "packages/dsh-shud-core/src/schemas");

export async function assertSchemaRegistryComplete(): Promise<void> {
  const sourceExports = await discoverObjectSchemaExports();
  validateSchemaRegistryCoverage(
    sourceExports,
    schemaDefinitions,
    ignoredNestedObjectSchemaExports,
  );
}

async function discoverObjectSchemaExports(): Promise<ObjectSchemaExport[]> {
  const files = (await readdir(schemaSourceDir))
    .filter((file) => file.endsWith(".ts") && file !== "index.ts" && !file.endsWith(".test.ts"))
    .sort();
  const exports: ObjectSchemaExport[] = [];

  for (const file of files) {
    const sourcePath = `packages/dsh-shud-core/src/schemas/${file}`;
    const moduleExports = (await import(pathToFileURL(join(schemaSourceDir, file)).href)) as Record<
      string,
      unknown
    >;

    exports.push(...discoverObjectSchemaExportsFromModule(sourcePath, moduleExports));
  }

  return exports.sort((left, right) => left.exportName.localeCompare(right.exportName));
}

export function discoverObjectSchemaExportsFromModule(
  sourcePath: string,
  moduleExports: Record<string, unknown>,
): ObjectSchemaExport[] {
  const discovered: ObjectSchemaExport[] = [];

  for (const [exportName, value] of Object.entries(moduleExports)) {
    if (exportName.endsWith("Schema") && isZodObjectSchema(value)) {
      discovered.push({ exportName, sourcePath, schema: value });
    }
  }

  return discovered;
}

function isZodObjectSchema(value: unknown): value is ZodType {
  return value instanceof z.ZodObject;
}

export function validateSchemaRegistryCoverage(
  sourceExports: ObjectSchemaExport[],
  definitions: SchemaDefinition[],
  ignoredNestedExports: IgnoredObjectSchemaExport[],
): void {
  const details: string[] = [];
  const sourceByName = new Map<string, ObjectSchemaExport>();
  const sourceKeys = new Set(sourceExports.map((sourceExport) => objectExportKey(sourceExport)));
  const ignoredKeys = new Set(
    ignoredNestedExports.map((sourceExport) => objectExportKey(sourceExport)),
  );
  const definitionsByName = new Map<string, SchemaDefinition>();

  for (const sourceExport of sourceExports) {
    const existing = sourceByName.get(sourceExport.exportName);
    if (existing !== undefined) {
      details.push(
        `duplicate exported object schema name ${sourceExport.exportName} in ${existing.sourcePath} and ${sourceExport.sourcePath}`,
      );
      continue;
    }
    sourceByName.set(sourceExport.exportName, sourceExport);
  }

  for (const definition of definitions) {
    const existing = definitionsByName.get(definition.exportName);
    if (existing !== undefined) {
      details.push(
        `duplicate generated schema registry entry ${definition.exportName} in ${existing.sourcePath} and ${definition.sourcePath}`,
      );
      continue;
    }
    definitionsByName.set(definition.exportName, definition);

    if (!isZodObjectSchema(definition.schema)) {
      details.push(
        `generated schema registry entry ${definition.exportName} is not a Zod object schema`,
      );
    }
  }

  const missing = sourceExports.filter(
    (sourceExport) =>
      !ignoredKeys.has(objectExportKey(sourceExport)) &&
      !definitionsByName.has(sourceExport.exportName),
  );
  const staleIgnored = ignoredNestedExports.filter(
    (ignoredExport) => !sourceKeys.has(objectExportKey(ignoredExport)),
  );

  details.push(
    ...missing.map(
      (sourceExport) =>
        `missing generated schema registry entry for ${sourceExport.exportName} from ${sourceExport.sourcePath}`,
    ),
    ...staleIgnored.map(
      (ignoredExport) =>
        `stale ignored nested schema entry ${ignoredExport.exportName} from ${ignoredExport.sourcePath}`,
    ),
  );

  for (const definition of definitions) {
    const sourceExport = sourceByName.get(definition.exportName);

    if (sourceExport === undefined) {
      details.push(`stale generated schema registry entry ${definition.exportName}`);
      continue;
    }

    if (sourceExport.sourcePath !== definition.sourcePath) {
      details.push(
        `wrong sourcePath for ${definition.exportName}: registry has ${definition.sourcePath}, actual export is ${sourceExport.sourcePath}`,
      );
    }

    if (sourceExport.schema !== definition.schema) {
      details.push(
        `schema object mismatch for ${definition.exportName}: registry schema is not identical to ${sourceExport.sourcePath} export`,
      );
    }
  }

  if (details.length > 0) {
    throw new Error(`Schema registry coverage failed:\n${details.join("\n")}`);
  }
}

function objectExportKey(
  sourceExport: Pick<ObjectSchemaExport, "sourcePath" | "exportName">,
): string {
  return `${sourceExport.sourcePath}#${sourceExport.exportName}`;
}
