import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z, type ZodType } from "zod";

import { ArtifactSchema } from "../../packages/dsh-shud-core/src/schemas/artifact.ts";
import { ArtifactManifestSchema } from "../../packages/dsh-shud-core/src/schemas/artifact-manifest.ts";
import { DataProvenanceSchema } from "../../packages/dsh-shud-core/src/schemas/data-provenance.ts";
import { ErrorRecordSchema } from "../../packages/dsh-shud-core/src/schemas/error.ts";
import { IdempotencyRecordSchema } from "../../packages/dsh-shud-core/src/schemas/idempotency.ts";
import { LockRecordSchema } from "../../packages/dsh-shud-core/src/schemas/lock.ts";
import { RunJobSchema } from "../../packages/dsh-shud-core/src/schemas/run-job.ts";
import { RunRecordSchema } from "../../packages/dsh-shud-core/src/schemas/run-record.ts";
import { StackLockSchema } from "../../packages/dsh-shud-core/src/schemas/stack-lock.ts";
import { TaskCardSchema } from "../../packages/dsh-shud-core/src/schemas/task.ts";

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
      data_id: "DATA-22222222-2222-4222-8222-222222222222",
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
