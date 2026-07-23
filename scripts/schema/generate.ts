import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z, type ZodType } from "zod";

import { ArtifactSchema } from "../../packages/core/src/domain/schemas/artifact";
import { ArtifactManifestSchema } from "../../packages/core/src/domain/schemas/artifact-manifest";
import { DataProvenanceSchema } from "../../packages/core/src/domain/schemas/data-provenance";
import { ErrorRecordSchema } from "../../packages/core/src/domain/schemas/error";
import { IdempotencyRecordSchema } from "../../packages/core/src/domain/schemas/idempotency";
import { LockRecordSchema } from "../../packages/core/src/domain/schemas/lock";
import { StackLockSchema } from "../../packages/core/src/domain/schemas/stack-lock";
import { TaskCardSchema } from "../../packages/core/src/domain/schemas/task";

type JsonSchema = {
  $schema?: string;
  $id?: string;
  title?: string;
  type?: string | string[];
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  default?: unknown;
  pattern?: string;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  format?: string;
};

type SchemaDefinition = {
  name: string;
  slug: string;
  sourcePath: string;
  exportName: string;
  schema: ZodType;
  strictInput?: boolean;
};

type FieldRow = {
  field: string;
  required: string;
  nullable: string;
  type: string;
  constraints: string;
};

type ObjectSchemaExport = {
  exportName: string;
  sourcePath: string;
  schema: ZodType;
};

type IgnoredObjectSchemaExport = {
  exportName: string;
  sourcePath: string;
  reason: string;
};

type GeneratedPathContext = {
  generatedRootPath: string;
};

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const schemaSourceDir = join(repoRoot, "packages/core/src/domain/schemas");
const generatedRoot = join(repoRoot, "docs/generated");
const markdownDir = join(repoRoot, "docs/generated/schema");
const jsonSchemaDir = join(repoRoot, "docs/generated/json-schema");

const schemaDefinitions: SchemaDefinition[] = [
  {
    name: "TaskCard",
    slug: "task-card",
    sourcePath: "packages/core/src/domain/schemas/task.ts",
    exportName: "TaskCardSchema",
    schema: TaskCardSchema
  },
  {
    name: "StackLock",
    slug: "stack-lock",
    sourcePath: "packages/core/src/domain/schemas/stack-lock.ts",
    exportName: "StackLockSchema",
    schema: StackLockSchema,
    strictInput: true
  },
  {
    name: "DataProvenance",
    slug: "data-provenance",
    sourcePath: "packages/core/src/domain/schemas/data-provenance.ts",
    exportName: "DataProvenanceSchema",
    schema: DataProvenanceSchema,
    strictInput: true
  },
  {
    name: "Artifact",
    slug: "artifact",
    sourcePath: "packages/core/src/domain/schemas/artifact.ts",
    exportName: "ArtifactSchema",
    schema: ArtifactSchema,
    strictInput: true
  },
  {
    name: "ArtifactManifest",
    slug: "artifact-manifest",
    sourcePath: "packages/core/src/domain/schemas/artifact-manifest.ts",
    exportName: "ArtifactManifestSchema",
    schema: ArtifactManifestSchema,
    strictInput: true
  },
  {
    name: "ErrorRecord",
    slug: "error-record",
    sourcePath: "packages/core/src/domain/schemas/error.ts",
    exportName: "ErrorRecordSchema",
    schema: ErrorRecordSchema
  },
  {
    name: "IdempotencyRecord",
    slug: "idempotency-record",
    sourcePath: "packages/core/src/domain/schemas/idempotency.ts",
    exportName: "IdempotencyRecordSchema",
    schema: IdempotencyRecordSchema
  },
  {
    name: "LockRecord",
    slug: "lock-record",
    sourcePath: "packages/core/src/domain/schemas/lock.ts",
    exportName: "LockRecordSchema",
    schema: LockRecordSchema
  }
];

const ignoredNestedObjectSchemaExports: IgnoredObjectSchemaExport[] = [
  {
    exportName: "ErrorRemediationSchema",
    sourcePath: "packages/core/src/domain/schemas/error.ts",
    reason: "nested helper for ErrorRecordSchema.remediation"
  },
  {
    exportName: "InferenceBudgetSchema",
    sourcePath: "packages/core/src/domain/schemas/task.ts",
    reason: "nested helper for TaskCardSchema.inference_budget"
  }
];

const generatedPathContext: GeneratedPathContext = {
  generatedRootPath: generatedRoot
};

async function main(): Promise<void> {
  if (process.argv.includes("--self-test")) {
    await runSelfTest();
    return;
  }

  await assertSchemaRegistryComplete();
  await recreateGeneratedDirectory(markdownDir);
  await recreateGeneratedDirectory(jsonSchemaDir);

  for (const definition of schemaDefinitions) {
    const jsonSchema = buildJsonSchema(definition);
    const markdown = buildMarkdown(definition, jsonSchema);

    await writeGeneratedFile(
      join(jsonSchemaDir, `${definition.slug}.json`),
      `${JSON.stringify(jsonSchema, null, 2)}\n`,
      generatedPathContext
    );
    await writeGeneratedFile(join(markdownDir, `${definition.slug}.md`), markdown, generatedPathContext);
  }
}

async function recreateGeneratedDirectory(path: string, context = generatedPathContext): Promise<void> {
  await assertGeneratedPathSafe(path, context);
  await rm(path, { recursive: true, force: true });
  await assertGeneratedPathSafe(path, context);
  await mkdir(path, { recursive: true });
}

async function writeGeneratedFile(path: string, content: string, context = generatedPathContext): Promise<void> {
  await assertGeneratedPathSafe(path, context);
  await writeFile(path, content, "utf8");
}

function buildJsonSchema(definition: SchemaDefinition): JsonSchema {
  const generated = z.toJSONSchema(definition.schema, { io: "input" }) as JsonSchema;
  const { $schema, ...schemaBody } = generated;

  return {
    $schema: $schema ?? "https://json-schema.org/draft/2020-12/schema",
    $id: `https://shud-harness.local/generated/json-schema/${definition.slug}.json`,
    title: definition.name,
    ...schemaBody
  };
}

function buildMarkdown(definition: SchemaDefinition, jsonSchema: JsonSchema): string {
  const fields = flattenFields(jsonSchema);
  const enumFields = fields.filter((field) => field.constraints.startsWith("values: "));
  const example = buildExample(jsonSchema);
  const changelogLines = buildChangelogDiff(definition, jsonSchema, fields);

  const lines = [
    "<!-- Generated by scripts/schema/generate.ts. Do not edit manually. -->",
    "",
    `# ${definition.name} Schema`,
    "",
    `Source: \`${definition.sourcePath}\` (\`${definition.exportName}\`)`,
    "",
    "Required is evaluated within the immediate parent object.",
    "",
    "## Fields",
    "",
    "| Field | Required | Nullable | Type | Constraints / values |",
    "|---|---|---|---|---|",
    ...fields.map(
      (field) =>
        `| ${cell(field.field)} | ${cell(field.required)} | ${cell(field.nullable)} | ${cell(
          field.type
        )} | ${cell(field.constraints)} |`
    )
  ];

  if (enumFields.length > 0) {
    lines.push(
      "",
      "## Enums",
      "",
      "| Field | Values |",
      "|---|---|",
      ...enumFields.map((field) => `| ${cell(field.field)} | ${cell(stripValuesPrefix(field.constraints))} |`)
    );
  }

  lines.push(
    "",
    "## Example YAML",
    "",
    "```yaml",
    ...yamlLines(example),
    "```",
    "",
    "## Changelog Diff",
    "",
    "```diff",
    ...changelogLines,
    "```"
  );

  return `${lines.join("\n")}\n`;
}

async function assertSchemaRegistryComplete(): Promise<void> {
  const sourceExports = await discoverObjectSchemaExports();
  validateSchemaRegistryCoverage(sourceExports, schemaDefinitions, ignoredNestedObjectSchemaExports);
}

async function discoverObjectSchemaExports(): Promise<ObjectSchemaExport[]> {
  const files = (await readdir(schemaSourceDir))
    .filter((file) => file.endsWith(".ts") && file !== "index.ts" && !file.endsWith(".test.ts"))
    .sort();
  const exports: ObjectSchemaExport[] = [];

  for (const file of files) {
    const sourcePath = `packages/core/src/domain/schemas/${file}`;
    const moduleExports = (await import(pathToFileURL(join(schemaSourceDir, file)).href)) as Record<string, unknown>;

    exports.push(...discoverObjectSchemaExportsFromModule(sourcePath, moduleExports));
  }

  return exports.sort((left, right) => left.exportName.localeCompare(right.exportName));
}

function discoverObjectSchemaExportsFromModule(
  sourcePath: string,
  moduleExports: Record<string, unknown>
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

function validateSchemaRegistryCoverage(
  sourceExports: ObjectSchemaExport[],
  definitions: SchemaDefinition[],
  ignoredNestedExports: IgnoredObjectSchemaExport[]
): void {
  const details: string[] = [];
  const sourceByName = new Map<string, ObjectSchemaExport>();
  const sourceKeys = new Set(sourceExports.map((sourceExport) => objectExportKey(sourceExport)));
  const ignoredKeys = new Set(ignoredNestedExports.map((sourceExport) => objectExportKey(sourceExport)));
  const definitionsByName = new Map<string, SchemaDefinition>();

  for (const sourceExport of sourceExports) {
    const existing = sourceByName.get(sourceExport.exportName);
    if (existing !== undefined) {
      details.push(
        `duplicate exported object schema name ${sourceExport.exportName} in ${existing.sourcePath} and ${sourceExport.sourcePath}`
      );
      continue;
    }
    sourceByName.set(sourceExport.exportName, sourceExport);
  }

  for (const definition of definitions) {
    const existing = definitionsByName.get(definition.exportName);
    if (existing !== undefined) {
      details.push(
        `duplicate generated schema registry entry ${definition.exportName} in ${existing.sourcePath} and ${definition.sourcePath}`
      );
      continue;
    }
    definitionsByName.set(definition.exportName, definition);

    if (!isZodObjectSchema(definition.schema)) {
      details.push(`generated schema registry entry ${definition.exportName} is not a Zod object schema`);
    }
  }

  const missing = sourceExports.filter(
    (sourceExport) =>
      !ignoredKeys.has(objectExportKey(sourceExport)) && !definitionsByName.has(sourceExport.exportName)
  );
  const staleIgnored = ignoredNestedExports.filter((ignoredExport) => !sourceKeys.has(objectExportKey(ignoredExport)));

  details.push(
    ...missing.map(
      (sourceExport) =>
        `missing generated schema registry entry for ${sourceExport.exportName} from ${sourceExport.sourcePath}`
    ),
    ...staleIgnored.map(
      (ignoredExport) =>
        `stale ignored nested schema entry ${ignoredExport.exportName} from ${ignoredExport.sourcePath}`
    )
  );

  for (const definition of definitions) {
    const sourceExport = sourceByName.get(definition.exportName);

    if (sourceExport === undefined) {
      details.push(`stale generated schema registry entry ${definition.exportName}`);
      continue;
    }

    if (sourceExport.sourcePath !== definition.sourcePath) {
      details.push(
        `wrong sourcePath for ${definition.exportName}: registry has ${definition.sourcePath}, actual export is ${sourceExport.sourcePath}`
      );
    }

    if (sourceExport.schema !== definition.schema) {
      details.push(
        `schema object mismatch for ${definition.exportName}: registry schema is not identical to ${sourceExport.sourcePath} export`
      );
    }
  }

  if (details.length > 0) {
    throw new Error(`Schema registry coverage failed:\n${details.join("\n")}`);
  }
}

function objectExportKey(sourceExport: Pick<ObjectSchemaExport, "sourcePath" | "exportName">): string {
  return `${sourceExport.sourcePath}#${sourceExport.exportName}`;
}

async function assertGeneratedPathSafe(path: string, context = generatedPathContext): Promise<void> {
  const rootPath = resolve(context.generatedRootPath);
  const targetPath = resolve(path);

  if (!isPathInsideOrEqual(targetPath, rootPath)) {
    throw new Error(`Generated output path is unsafe: ${targetPath} is outside ${rootPath}`);
  }

  await assertExistingPathSegmentsNotSymlinks(rootPath);
  await assertExistingPathSegmentsNotSymlinks(targetPath);

  const rootStats = await lstat(rootPath);
  if (!rootStats.isDirectory()) {
    throw new Error(`Generated output path is unsafe: ${rootPath} must be a directory`);
  }

  const realRootPath = await realpath(rootPath);
  const existingTargetPath = await nearestExistingPath(targetPath);
  const realExistingTargetPath = await realpath(existingTargetPath);

  if (!isPathInsideOrEqual(realExistingTargetPath, realRootPath)) {
    throw new Error(`Generated output path is unsafe: ${realExistingTargetPath} resolves outside ${realRootPath}`);
  }
}

async function assertExistingPathSegmentsNotSymlinks(path: string): Promise<void> {
  const segments: string[] = [];
  let current = resolve(path);

  while (true) {
    segments.push(current);
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  for (const segment of segments.reverse()) {
    let stats;
    try {
      stats = await lstat(segment);
    } catch (error) {
      if (isNotFoundError(error)) {
        return;
      }
      throw error;
    }

    if (stats.isSymbolicLink()) {
      throw new Error(`Generated output path is unsafe: ${segment} must not be a symlink`);
    }
  }
}

async function nearestExistingPath(path: string): Promise<string> {
  let current = resolve(path);

  while (true) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }

    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`Generated output path is unsafe: no existing ancestor for ${path}`);
    }
    current = parent;
  }
}

function isPathInsideOrEqual(path: string, rootPath: string): boolean {
  const pathRelativeToRoot = relative(rootPath, path);
  return pathRelativeToRoot === "" || (!pathRelativeToRoot.startsWith("..") && !isAbsolute(pathRelativeToRoot));
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function flattenFields(schema: JsonSchema, parentPath = ""): FieldRow[] {
  const objectSchema = nonNullSchema(schema);

  if (objectSchema.type !== "object" || objectSchema.properties === undefined) {
    throw new Error(`Expected object schema at ${parentPath || "<root>"}`);
  }

  const required = new Set(objectSchema.required ?? []);
  const rows: FieldRow[] = [];

  for (const [propertyName, propertySchema] of Object.entries(objectSchema.properties)) {
    const fieldPath = parentPath === "" ? propertyName : `${parentPath}.${propertyName}`;
    const propertyWithoutNull = nonNullSchema(propertySchema);

    rows.push({
      field: fieldPath,
      required: required.has(propertyName) ? "yes" : "no",
      nullable: isNullable(propertySchema) ? "yes" : "no",
      type: typeLabel(propertySchema),
      constraints: constraintLabel(propertySchema)
    });

    if (propertyWithoutNull.type === "object" && propertyWithoutNull.properties !== undefined) {
      rows.push(...flattenFields(propertyWithoutNull, fieldPath));
    }
  }

  return rows;
}

function nonNullSchema(schema: JsonSchema): JsonSchema {
  if (Array.isArray(schema.type)) {
    const nonNullTypes = schema.type.filter((type) => type !== "null");
    return { ...schema, type: nonNullTypes.length === 1 ? nonNullTypes[0] : nonNullTypes };
  }

  const union = schema.anyOf ?? schema.oneOf;
  const nonNullMembers = union?.filter((member) => member.type !== "null");
  if (nonNullMembers !== undefined && nonNullMembers.length === 1) {
    return nonNullMembers[0];
  }

  return schema;
}

function isNullable(schema: JsonSchema): boolean {
  if (Array.isArray(schema.type)) {
    return schema.type.includes("null");
  }

  const union = schema.anyOf ?? schema.oneOf;
  return union?.some((member) => member.type === "null") ?? false;
}

function typeLabel(schema: JsonSchema): string {
  const nullable = isNullable(schema);
  const schemaWithoutNull = nonNullSchema(schema);
  const label = typeLabelNonNull(schemaWithoutNull);

  return nullable ? `${label} | null` : label;
}

function typeLabelNonNull(schema: JsonSchema): string {
  if (schema.enum !== undefined) {
    return "enum<string>";
  }

  if (schema.type === "array") {
    return `array<${schema.items === undefined ? "unknown" : typeLabel(schema.items)}>`;
  }

  if (Array.isArray(schema.type)) {
    return schema.type.join(" | ");
  }

  if (schema.anyOf !== undefined) {
    return `anyOf<${schema.anyOf.map(typeLabel).join(" | ")}>`;
  }

  if (schema.oneOf !== undefined) {
    return `oneOf<${schema.oneOf.map(typeLabel).join(" | ")}>`;
  }

  if (schema.allOf !== undefined) {
    return `allOf<${schema.allOf.map(typeLabel).join(" & ")}>`;
  }

  return schema.type ?? "unknown";
}

function constraintLabel(schema: JsonSchema): string {
  const schemaWithoutNull = nonNullSchema(schema);
  const constraints: string[] = [];

  if (schemaWithoutNull.enum !== undefined) {
    constraints.push(`values: ${schemaWithoutNull.enum.map((value) => `\`${String(value)}\``).join(", ")}`);
  }

  if (schemaWithoutNull.minLength !== undefined) {
    constraints.push(`minLength=${schemaWithoutNull.minLength}`);
  }

  if (schemaWithoutNull.maxLength !== undefined) {
    constraints.push(`maxLength=${schemaWithoutNull.maxLength}`);
  }

  if (schemaWithoutNull.minimum !== undefined) {
    constraints.push(`minimum=${schemaWithoutNull.minimum}`);
  }

  if (schemaWithoutNull.maximum !== undefined) {
    constraints.push(`maximum=${schemaWithoutNull.maximum}`);
  }

  if (schemaWithoutNull.format !== undefined) {
    constraints.push(`format=${schemaWithoutNull.format}`);
  }

  if (schemaWithoutNull.pattern !== undefined) {
    constraints.push(`pattern=${schemaWithoutNull.pattern}`);
  }

  if (Object.prototype.hasOwnProperty.call(schemaWithoutNull, "default")) {
    constraints.push(`default=${JSON.stringify(schemaWithoutNull.default)}`);
  }

  if (schemaWithoutNull.type === "array" && schemaWithoutNull.items !== undefined) {
    const itemConstraints = constraintLabel(schemaWithoutNull.items);
    if (itemConstraints !== "-") {
      constraints.push(`items: ${itemConstraints}`);
    }
  }

  if (schemaWithoutNull.type === "object" && schemaWithoutNull.additionalProperties === false) {
    constraints.push("additionalProperties=false");
  }

  return constraints.length === 0 ? "-" : constraints.join("; ");
}

function buildExample(schema: JsonSchema): unknown {
  const schemaWithoutNull = nonNullSchema(schema);

  if (schemaWithoutNull.enum !== undefined) {
    return schemaWithoutNull.enum[0];
  }

  if (schemaWithoutNull.type === "object") {
    const example: Record<string, unknown> = {};
    for (const [propertyName, propertySchema] of Object.entries(schemaWithoutNull.properties ?? {})) {
      example[propertyName] = buildExample(propertySchema);
    }
    return example;
  }

  if (schemaWithoutNull.type === "array") {
    return [schemaWithoutNull.items === undefined ? "example" : buildExample(schemaWithoutNull.items)];
  }

  if (schemaWithoutNull.type === "integer" || schemaWithoutNull.type === "number") {
    return schemaWithoutNull.minimum ?? 0;
  }

  if (schemaWithoutNull.type === "boolean") {
    return false;
  }

  if (schemaWithoutNull.type === "null") {
    return null;
  }

  return "example";
}

function yamlLines(value: unknown, indent = 0): string[] {
  const prefix = " ".repeat(indent);

  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (isPlainObject(item)) {
        return [`${prefix}-`, ...yamlLines(item, indent + 2)];
      }
      return [`${prefix}- ${yamlScalar(item)}`];
    });
  }

  if (isPlainObject(value)) {
    return Object.entries(value).flatMap(([key, item]) => {
      if (isPlainObject(item) || Array.isArray(item)) {
        return [`${prefix}${key}:`, ...yamlLines(item, indent + 2)];
      }
      return [`${prefix}${key}: ${yamlScalar(item)}`];
    });
  }

  return [`${prefix}${yamlScalar(value)}`];
}

function yamlScalar(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(String(value));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildChangelogDiff(definition: SchemaDefinition, jsonSchema: JsonSchema, fields: FieldRow[]): string[] {
  const fingerprint = createHash("sha256").update(JSON.stringify(jsonSchema)).digest("hex");
  return [
    `+ schema ${definition.name} sha256:${fingerprint}`,
    ...fields.map(
      (field) =>
        `+ field ${field.field} required=${field.required} nullable=${field.nullable} type=${field.type} constraints=${field.constraints}`
    )
  ];
}

async function runSelfTest(): Promise<void> {
  const mockSchema = z.object({});
  const wrongMockSchema = z.object({ wrong: z.string() });
  const mockDefinitions: SchemaDefinition[] = [
    {
      name: "TaskCard",
      slug: "task-card",
      sourcePath: "packages/core/src/domain/schemas/task.ts",
      exportName: "TaskCardSchema",
      schema: mockSchema
    }
  ];
  const ignored: IgnoredObjectSchemaExport[] = [
    {
      exportName: "InferenceBudgetSchema",
      sourcePath: "packages/core/src/domain/schemas/task.ts",
      reason: "nested helper for TaskCardSchema.inference_budget"
    }
  ];

  validateSchemaRegistryCoverage(
    [
      { exportName: "TaskCardSchema", sourcePath: "packages/core/src/domain/schemas/task.ts", schema: mockSchema },
      {
        exportName: "InferenceBudgetSchema",
        sourcePath: "packages/core/src/domain/schemas/task.ts",
        schema: z.object({})
      }
    ],
    mockDefinitions,
    ignored
  );

  const discoveredFromSyntheticModule = discoverObjectSchemaExportsFromModule(
    "packages/core/src/domain/schemas/run-job.ts",
    {
      RunJobSchema: z.object({ run_id: z.string() }).extend({ status: z.string() }),
      helperObject: z.object({ ignored: z.string() }),
      RunJobStatusSchema: z.enum(["created"])
    }
  );
  if (
    discoveredFromSyntheticModule.length !== 1 ||
    discoveredFromSyntheticModule[0]?.exportName !== "RunJobSchema"
  ) {
    throw new Error("object schema discovery should include composed *Schema exports and ignore non-schema helpers");
  }

  assertThrows(
    () =>
      validateSchemaRegistryCoverage(
        [
          { exportName: "TaskCardSchema", sourcePath: "packages/core/src/domain/schemas/task.ts", schema: mockSchema },
          { exportName: "RunJobSchema", sourcePath: "packages/core/src/domain/schemas/run-job.ts", schema: z.object({}) }
        ],
        mockDefinitions,
        ignored
      ),
    "missing generated schema registry entry for RunJobSchema"
  );

  assertThrows(
    () =>
      validateSchemaRegistryCoverage([], mockDefinitions, []),
    "stale generated schema registry entry TaskCardSchema"
  );

  assertThrows(
    () =>
      validateSchemaRegistryCoverage(
        [{ exportName: "TaskCardSchema", sourcePath: "packages/core/src/domain/schemas/task.ts", schema: mockSchema }],
        [
          {
            ...mockDefinitions[0],
            sourcePath: "packages/core/src/domain/schemas/wrong.ts"
          }
        ],
        []
      ),
    "wrong sourcePath for TaskCardSchema"
  );

  assertThrows(
    () =>
      validateSchemaRegistryCoverage(
        [{ exportName: "TaskCardSchema", sourcePath: "packages/core/src/domain/schemas/task.ts", schema: mockSchema }],
        [
          {
            ...mockDefinitions[0],
            schema: wrongMockSchema
          }
        ],
        []
      ),
    "schema object mismatch for TaskCardSchema"
  );

  assertThrows(
    () =>
      validateSchemaRegistryCoverage(
        [{ exportName: "TaskCardSchema", sourcePath: "packages/core/src/domain/schemas/task.ts", schema: mockSchema }],
        [
          mockDefinitions[0],
          {
            ...mockDefinitions[0],
            name: "TaskCardDuplicate",
            slug: "task-card-duplicate"
          }
        ],
        []
      ),
    "duplicate generated schema registry entry TaskCardSchema"
  );

  await assertGeneratedPathRejectsSymlinkAncestor();
  assertTaskCardUnknownKeyParity();
  for (const definition of schemaDefinitions) {
    const jsonSchema = buildJsonSchema(definition);
    if (definition.strictInput) {
      assertStrictInputClosed(jsonSchema, definition.name);
    } else {
      assertNoAdditionalPropertiesFalse(jsonSchema, definition.name);
    }
  }

  console.log("schema generator self-test passed");
}

async function assertGeneratedPathRejectsSymlinkAncestor(): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), "schema-generator-path-"));
  const fakeRepoRoot = join(tempRoot, "repo");
  const outsideGeneratedRoot = join(tempRoot, "outside-generated");
  const outsideSchemaDir = join(outsideGeneratedRoot, "schema");
  const sentinelPath = join(outsideSchemaDir, "sentinel.txt");

  try {
    await mkdir(join(fakeRepoRoot, "docs"), { recursive: true });
    await mkdir(outsideSchemaDir, { recursive: true });
    await writeFile(sentinelPath, "untouched\n", "utf8");
    await symlink(outsideGeneratedRoot, join(fakeRepoRoot, "docs/generated"), "dir");

    await assertRejects(
      () =>
        recreateGeneratedDirectory(join(fakeRepoRoot, "docs/generated/schema"), {
          generatedRootPath: join(fakeRepoRoot, "docs/generated")
        }),
      "must not be a symlink"
    );

    const sentinel = await readFile(sentinelPath, "utf8");
    if (sentinel !== "untouched\n") {
      throw new Error("symlink ancestor validation mutated the outside generated target");
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function assertTaskCardUnknownKeyParity(): void {
  const candidate = {
    task_id: "TASK-0001",
    type: "engineering",
    status: "created",
    runtime_phase: null,
    title: "Schema parity fixture",
    question_or_goal: "Prove generated JSON Schema does not reject Zod-accepted unknown keys.",
    created_by: "codex",
    current_owner: "codex",
    reviewer: "reviewer",
    inference_budget: {
      mode: "normal",
      advisory_usd: 1,
      advisory_model_calls: 1,
      reviewer_enabled: false,
      nested_trace: "accepted then stripped"
    },
    linked_jobs: [],
    linked_reports: [],
    created_at: "2026-07-06T00:00:00Z",
    updated_at: "2026-07-06T00:00:00Z",
    client_trace_id: "accepted then stripped"
  };
  const parsed = TaskCardSchema.safeParse(candidate);

  if (!parsed.success) {
    throw new Error("TaskCard unknown-key parity fixture should parse successfully");
  }

  if ("client_trace_id" in (parsed.data as Record<string, unknown>)) {
    throw new Error("TaskCardSchema should strip unknown root keys");
  }

  if ("nested_trace" in (parsed.data.inference_budget as Record<string, unknown>)) {
    throw new Error("TaskCardSchema should strip unknown nested object keys");
  }
}

function assertStrictInputClosed(schema: JsonSchema, path: string): void {
  const schemaWithoutNull = nonNullSchema(schema);

  if (schemaWithoutNull.type === "object") {
    if (schemaWithoutNull.additionalProperties === undefined) {
      throw new Error(`${path} strict JSON Schema has an implicitly open object boundary`);
    }
    if (typeof schemaWithoutNull.additionalProperties === "object") {
      assertStrictInputClosed(schemaWithoutNull.additionalProperties, `${path}.*`);
    }
    for (const [propertyName, propertySchema] of Object.entries(
      schemaWithoutNull.properties ?? {}
    )) {
      assertStrictInputClosed(propertySchema, `${path}.${propertyName}`);
    }
  }

  if (schemaWithoutNull.type === "array" && schemaWithoutNull.items !== undefined) {
    assertStrictInputClosed(schemaWithoutNull.items, `${path}[]`);
  }

  for (const [label, members] of [
    ["anyOf", schemaWithoutNull.anyOf],
    ["oneOf", schemaWithoutNull.oneOf],
    ["allOf", schemaWithoutNull.allOf]
  ] as const) {
    members?.forEach((member, index) => {
      assertStrictInputClosed(member, `${path}.${label}[${index}]`);
    });
  }
}

function assertNoAdditionalPropertiesFalse(schema: JsonSchema, path: string): void {
  const schemaWithoutNull = nonNullSchema(schema);

  if (schemaWithoutNull.additionalProperties === false) {
    throw new Error(`${path} JSON Schema is stricter than Zod input semantics`);
  }

  if (schemaWithoutNull.type === "object") {
    for (const [propertyName, propertySchema] of Object.entries(schemaWithoutNull.properties ?? {})) {
      assertNoAdditionalPropertiesFalse(propertySchema, `${path}.${propertyName}`);
    }
  }

  if (schemaWithoutNull.type === "array" && schemaWithoutNull.items !== undefined) {
    assertNoAdditionalPropertiesFalse(schemaWithoutNull.items, `${path}[]`);
  }

  for (const [label, members] of [
    ["anyOf", schemaWithoutNull.anyOf],
    ["oneOf", schemaWithoutNull.oneOf],
    ["allOf", schemaWithoutNull.allOf]
  ] as const) {
    members?.forEach((member, index) => {
      assertNoAdditionalPropertiesFalse(member, `${path}.${label}[${index}]`);
    });
  }
}

function assertThrows(callback: () => void, expectedMessage: string): void {
  try {
    callback();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(expectedMessage)) {
      return;
    }
    throw new Error(`Expected error containing ${expectedMessage}, got ${message}`);
  }
  throw new Error(`Expected error containing ${expectedMessage}`);
}

async function assertRejects(callback: () => Promise<void>, expectedMessage: string): Promise<void> {
  try {
    await callback();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(expectedMessage)) {
      return;
    }
    throw new Error(`Expected error containing ${expectedMessage}, got ${message}`);
  }
  throw new Error(`Expected error containing ${expectedMessage}`);
}

function stripValuesPrefix(value: string): string {
  return value.replace(/^values: /, "");
}

function cell(value: string): string {
  return value.replace(/\|/g, "\\|");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
