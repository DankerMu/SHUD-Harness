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
  },
  {
    name: "StackLock",
    slug: "stack-lock",
    sourcePath: "packages/dsh-shud-core/src/schemas/stack-lock.ts",
    exportName: "StackLockSchema",
    schema: StackLockSchema,
    strictInput: true,
    exampleOverrides: {
      stack_id: "STACK-11111111-1111-4111-8111-111111111111",
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
