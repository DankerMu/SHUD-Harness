import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z, type ZodType } from "zod";

import { DataProvenanceSchema } from "../../packages/dsh-shud-core/src/schemas/data-provenance.ts";
import { TaskCardSchema } from "../../packages/dsh-shud-core/src/schemas/task.ts";
import { recreateGeneratedDirectory } from "./generated-paths.ts";
import {
  discoverObjectSchemaExportsFromModule,
  schemaDefinitions,
  validateSchemaRegistryCoverage,
  type IgnoredObjectSchemaExport,
  type SchemaDefinition,
} from "./registry.ts";
import {
  buildExample,
  buildJsonSchema,
  buildMarkdown,
  flattenFields,
  nonNullSchema,
  yamlLines,
  type JsonSchema,
} from "./render.ts";

const intentionalOpenRecordBoundary = {
  name: "DataProvenance",
  exportName: "DataProvenanceSchema",
  schema: DataProvenanceSchema,
  path: "DataProvenance.preprocess.params",
} as const;

function parseGeneratedYaml(lines: string[]): unknown {
  const tokens = lines.map((line, index) => {
    const content = line.trimStart();
    return {
      content,
      indent: line.length - content.length,
      lineNumber: index + 1,
    };
  });

  if (tokens.length === 0) {
    throw new Error("empty YAML document");
  }

  const [value, nextIndex] = parseGeneratedYamlBlock(tokens, 0, tokens[0].indent);
  if (nextIndex !== tokens.length) {
    throw new Error(`unexpected content at line ${tokens[nextIndex].lineNumber}`);
  }
  return value;
}

type GeneratedYamlToken = {
  content: string;
  indent: number;
  lineNumber: number;
};

function parseGeneratedYamlBlock(
  tokens: GeneratedYamlToken[],
  startIndex: number,
  indent: number,
): [unknown, number] {
  const first = tokens[startIndex];
  if (first === undefined || first.indent !== indent) {
    throw new Error(`expected indentation ${indent}`);
  }

  return first.content.startsWith("-")
    ? parseGeneratedYamlArray(tokens, startIndex, indent)
    : parseGeneratedYamlObject(tokens, startIndex, indent);
}

function parseGeneratedYamlObject(
  tokens: GeneratedYamlToken[],
  startIndex: number,
  indent: number,
): [Record<string, unknown>, number] {
  const value: Record<string, unknown> = {};
  let index = startIndex;

  while (index < tokens.length && tokens[index].indent === indent) {
    const token = tokens[index];
    if (token.content.startsWith("-")) break;
    const separator = token.content.indexOf(":");
    if (separator <= 0) {
      throw new Error(`expected object field at line ${token.lineNumber}`);
    }
    const key = token.content.slice(0, separator);
    const scalar = token.content.slice(separator + 1).trim();
    index += 1;

    if (scalar !== "") {
      value[key] = parseGeneratedYamlScalar(scalar, token.lineNumber);
      continue;
    }
    const child = tokens[index];
    if (child === undefined || child.indent <= indent) {
      value[key] = null;
      continue;
    }
    [value[key], index] = parseGeneratedYamlBlock(tokens, index, child.indent);
  }

  return [value, index];
}

function parseGeneratedYamlArray(
  tokens: GeneratedYamlToken[],
  startIndex: number,
  indent: number,
): [unknown[], number] {
  const value: unknown[] = [];
  let index = startIndex;

  while (index < tokens.length && tokens[index].indent === indent) {
    const token = tokens[index];
    if (!token.content.startsWith("-")) break;
    const scalar = token.content.slice(1).trim();
    index += 1;

    if (scalar !== "") {
      value.push(parseGeneratedYamlScalar(scalar, token.lineNumber));
      continue;
    }
    const child = tokens[index];
    if (child === undefined || child.indent <= indent) {
      value.push(null);
      continue;
    }
    const [childValue, nextIndex] = parseGeneratedYamlBlock(tokens, index, child.indent);
    value.push(childValue);
    index = nextIndex;
  }

  return [value, index];
}

function parseGeneratedYamlScalar(value: string, lineNumber: number): unknown {
  if (value === "{}") return {};
  if (value === "[]") return [];
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`unsupported scalar at line ${lineNumber}`, { cause: error });
  }
}

export async function runSelfTest(): Promise<void> {
  const mockSchema = z.object({});
  const wrongMockSchema = z.object({ wrong: z.string() });
  const mockDefinitions: SchemaDefinition[] = [
    {
      name: "TaskCard",
      slug: "task-card",
      sourcePath: "packages/dsh-shud-core/src/schemas/task.ts",
      exportName: "TaskCardSchema",
      schema: mockSchema,
    },
  ];
  const ignored: IgnoredObjectSchemaExport[] = [
    {
      exportName: "InferenceBudgetSchema",
      sourcePath: "packages/dsh-shud-core/src/schemas/task.ts",
      reason: "nested helper for TaskCardSchema.inference_budget",
    },
  ];

  validateSchemaRegistryCoverage(
    [
      {
        exportName: "TaskCardSchema",
        sourcePath: "packages/dsh-shud-core/src/schemas/task.ts",
        schema: mockSchema,
      },
      {
        exportName: "InferenceBudgetSchema",
        sourcePath: "packages/dsh-shud-core/src/schemas/task.ts",
        schema: z.object({}),
      },
    ],
    mockDefinitions,
    ignored,
  );

  const discoveredFromSyntheticModule = discoverObjectSchemaExportsFromModule(
    "packages/dsh-shud-core/src/schemas/run-job.ts",
    {
      RunJobSchema: z.object({ run_id: z.string() }).extend({ status: z.string() }),
      helperObject: z.object({ ignored: z.string() }),
      RunJobStatusSchema: z.enum(["created"]),
    },
  );
  if (
    discoveredFromSyntheticModule.length !== 1 ||
    discoveredFromSyntheticModule[0]?.exportName !== "RunJobSchema"
  ) {
    throw new Error(
      "object schema discovery should include composed *Schema exports and ignore non-schema helpers",
    );
  }

  assertThrows(
    () =>
      validateSchemaRegistryCoverage(
        [
          {
            exportName: "TaskCardSchema",
            sourcePath: "packages/dsh-shud-core/src/schemas/task.ts",
            schema: mockSchema,
          },
          {
            exportName: "RunJobSchema",
            sourcePath: "packages/dsh-shud-core/src/schemas/run-job.ts",
            schema: z.object({}),
          },
        ],
        mockDefinitions,
        ignored,
      ),
    "missing generated schema registry entry for RunJobSchema",
  );

  assertThrows(
    () => validateSchemaRegistryCoverage([], mockDefinitions, []),
    "stale generated schema registry entry TaskCardSchema",
  );

  assertThrows(
    () =>
      validateSchemaRegistryCoverage(
        [
          {
            exportName: "TaskCardSchema",
            sourcePath: "packages/dsh-shud-core/src/schemas/task.ts",
            schema: mockSchema,
          },
        ],
        [
          {
            ...mockDefinitions[0],
            sourcePath: "packages/dsh-shud-core/src/schemas/wrong.ts",
          },
        ],
        [],
      ),
    "wrong sourcePath for TaskCardSchema",
  );

  assertThrows(
    () =>
      validateSchemaRegistryCoverage(
        [
          {
            exportName: "TaskCardSchema",
            sourcePath: "packages/dsh-shud-core/src/schemas/task.ts",
            schema: mockSchema,
          },
        ],
        [
          {
            ...mockDefinitions[0],
            schema: wrongMockSchema,
          },
        ],
        [],
      ),
    "schema object mismatch for TaskCardSchema",
  );

  assertThrows(
    () =>
      validateSchemaRegistryCoverage(
        [
          {
            exportName: "TaskCardSchema",
            sourcePath: "packages/dsh-shud-core/src/schemas/task.ts",
            schema: mockSchema,
          },
        ],
        [
          mockDefinitions[0],
          {
            ...mockDefinitions[0],
            name: "TaskCardDuplicate",
            slug: "task-card-duplicate",
          },
        ],
        [],
      ),
    "duplicate generated schema registry entry TaskCardSchema",
  );

  await assertGeneratedPathRejectsSymlinkAncestor();
  assertTaskCardUnknownKeyParity();
  assertGeneratorSemanticContracts();
  for (const definition of schemaDefinitions) {
    const jsonSchema = buildJsonSchema(definition);
    if (definition.strictInput) {
      assertStrictInputClosed(jsonSchema, definition);
    } else {
      assertNoAdditionalPropertiesFalse(jsonSchema, definition.name);
    }
  }

  console.log("schema generator self-test passed");
}

function assertGeneratorSemanticContracts(): void {
  const failures: string[] = [];

  for (const definition of schemaDefinitions) {
    const jsonSchema = buildJsonSchema(definition);
    const example = buildExample(jsonSchema, definition.exampleOverrides);
    const emittedYaml = extractExampleYamlLines(buildMarkdown(definition, jsonSchema));
    let yamlRoundTrip: unknown;
    try {
      yamlRoundTrip = parseGeneratedYaml(emittedYaml);
    } catch (error) {
      failures.push(
        `${definition.name} generated example YAML did not parse: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }
    if (JSON.stringify(yamlRoundTrip) !== JSON.stringify(example)) {
      failures.push(`${definition.name} generated example YAML did not round-trip`);
    }
    const parsed = definition.schema.safeParse(yamlRoundTrip);
    if (!parsed.success) {
      failures.push(`${definition.name} generated example is not valid source-schema input`);
    }
  }

  const dataProvenanceSchema = buildJsonSchema(
    schemaDefinitions.find((definition) => definition.name === "DataProvenance")!,
  );
  const dataProvenanceFields = flattenFields(dataProvenanceSchema).map((field) => field.field);
  if (!dataProvenanceFields.includes("sources.observations[].station")) {
    failures.push("DataProvenance fields omit sources.observations[].station");
  }
  const dataProvenanceDefinition = schemaDefinitions.find(
    (definition) => definition.name === "DataProvenance",
  )!;
  if (
    !yamlLines(
      buildExample(dataProvenanceSchema, dataProvenanceDefinition.exampleOverrides),
    ).includes("  params: {}")
  ) {
    failures.push("DataProvenance empty params record is not rendered as {}");
  }

  const artifactManifestSchema = buildJsonSchema(
    schemaDefinitions.find((definition) => definition.name === "ArtifactManifest")!,
  );
  const artifactManifestFields = flattenFields(artifactManifestSchema).map((field) => field.field);
  if (!artifactManifestFields.includes("artifacts[].llm_generated")) {
    failures.push("ArtifactManifest fields omit artifacts[].llm_generated");
  }

  const wrapperDescription = "Observed window | unknown\nsecond line";
  const fallbackDescription = "Inner annotation fallback";
  const shadowedDescription = "Inner annotation must not replace the whole-field meaning";
  const plain = z.strictObject({
    window: z.number().nonnegative().nullable(),
    fallback: z.number().min(1).nullable(),
    mode: z.enum(["fast", "careful"]),
    unannotated: z.string(),
  });
  const annotated = z.strictObject({
    window: z
      .number()
      .nonnegative()
      .describe(shadowedDescription)
      .nullable()
      .describe(wrapperDescription),
    fallback: z.number().min(1).describe(fallbackDescription).nullable(),
    mode: z.enum(["fast", "careful"]).describe("Execution mode semantics"),
    unannotated: z.string(),
  });
  const plainDefinition = syntheticStrictDefinition("SyntheticSemantics", plain);
  const annotatedDefinition = syntheticStrictDefinition("SyntheticSemantics", annotated);
  const plainJson = buildJsonSchema(plainDefinition);
  const annotatedJson = buildJsonSchema(annotatedDefinition);
  const plainMarkdown = buildMarkdown(plainDefinition, plainJson);
  const annotatedMarkdown = buildMarkdown(annotatedDefinition, annotatedJson);
  const wrapper = annotatedJson.properties?.window;
  if (
    !wrapper ||
    Reflect.get(wrapper, "description") !== wrapperDescription ||
    Reflect.get(nonNullSchema(wrapper), "description") !== shadowedDescription
  ) {
    failures.push("nullable whole-field and inner annotations are not preserved in JSON Schema");
  }
  if (
    !annotatedMarkdown.includes("Observed window \\| unknown second line") ||
    !annotatedMarkdown.includes(fallbackDescription) ||
    !annotatedMarkdown.includes("Execution mode semantics") ||
    annotatedMarkdown.includes(shadowedDescription)
  ) {
    failures.push(
      "Markdown field semantics lose nullable wrapper precedence, fallback or escaping",
    );
  }
  const [annotatedRows, plainRows] = [annotatedMarkdown, plainMarkdown].map((markdown) =>
    markdown.split("\n").filter((line) => line.startsWith("|")),
  );
  if (JSON.stringify(annotatedRows) !== JSON.stringify(plainRows)) {
    failures.push("semantic annotations changed field columns, constraints or enum values");
  }
  if (
    JSON.stringify(buildExample(annotatedJson)) !== JSON.stringify(buildExample(plainJson)) ||
    JSON.stringify(extractExampleYamlLines(annotatedMarkdown)) !==
      JSON.stringify(extractExampleYamlLines(plainMarkdown))
  ) {
    failures.push("semantic annotations changed example values or YAML");
  }
  if (
    !annotated.safeParse({ window: null, fallback: null, mode: "fast", unannotated: "" }).success ||
    annotated.safeParse({ window: -1, fallback: 1, mode: "fast", unannotated: "" }).success
  ) {
    failures.push("semantic annotations changed nullable or nonnegative validation");
  }

  try {
    const looseRootSchema = z.looseObject({ value: z.string() });
    assertThrows(
      () =>
        assertStrictInputClosed(
          z.toJSONSchema(looseRootSchema, { io: "input" }) as JsonSchema,
          syntheticStrictDefinition("SyntheticLooseRoot", looseRootSchema),
        ),
      "additionalProperties must be false",
    );
  } catch {
    failures.push("strict closure accepts a synthetic loose root object");
  }

  try {
    const looseNestedSchema = z.strictObject({
      nested: z.looseObject({ value: z.string() }),
    });
    assertThrows(
      () =>
        assertStrictInputClosed(
          z.toJSONSchema(looseNestedSchema, { io: "input" }) as JsonSchema,
          syntheticStrictDefinition("SyntheticLooseNested", looseNestedSchema),
        ),
      "additionalProperties must be false",
    );
  } catch {
    failures.push("strict closure accepts a synthetic loose nested object");
  }

  try {
    assertStrictInputClosed(dataProvenanceSchema, dataProvenanceDefinition);
  } catch (error) {
    failures.push(
      `intentional DataProvenance preprocess.params record was rejected: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (failures.length > 0) {
    throw new Error(`Generator semantic contract failed:\n${failures.join("\n")}`);
  }
}

function extractExampleYamlLines(markdown: string): string[] {
  const lines = markdown.split("\n");
  const start = lines.indexOf("```yaml");
  const end = start < 0 ? -1 : lines.indexOf("```", start + 1);
  if (start < 0 || end < 0) {
    throw new Error("generated Markdown does not contain a complete Example YAML fence");
  }
  return lines.slice(start + 1, end);
}

function syntheticStrictDefinition(name: string, schema: ZodType): SchemaDefinition {
  return {
    name,
    slug: name.toLowerCase(),
    sourcePath: "<synthetic>",
    exportName: `${name}Schema`,
    schema,
    strictInput: true,
  };
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
          generatedRootPath: join(fakeRepoRoot, "docs/generated"),
        }),
      "must not be a symlink",
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
      nested_trace: "accepted then stripped",
    },
    linked_jobs: [],
    linked_reports: [],
    created_at: "2026-07-06T00:00:00Z",
    updated_at: "2026-07-06T00:00:00Z",
    client_trace_id: "accepted then stripped",
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

function assertStrictInputClosed(
  schema: JsonSchema,
  definition: SchemaDefinition,
  path = definition.name,
): void {
  const schemaWithoutNull = nonNullSchema(schema);

  if (schemaWithoutNull.type === "object") {
    if (isIntentionalOpenRecordBoundary(schemaWithoutNull, definition, path)) {
      return;
    }
    if (schemaWithoutNull.additionalProperties !== false) {
      throw new Error(`${path} strict JSON Schema additionalProperties must be false`);
    }
    for (const [propertyName, propertySchema] of Object.entries(
      schemaWithoutNull.properties ?? {},
    )) {
      assertStrictInputClosed(propertySchema, definition, `${path}.${propertyName}`);
    }
  }

  if (schemaWithoutNull.type === "array" && schemaWithoutNull.items !== undefined) {
    assertStrictInputClosed(schemaWithoutNull.items, definition, `${path}[]`);
  }

  for (const [label, members] of [
    ["anyOf", schemaWithoutNull.anyOf],
    ["oneOf", schemaWithoutNull.oneOf],
    ["allOf", schemaWithoutNull.allOf],
  ] as const) {
    members?.forEach((member, index) => {
      assertStrictInputClosed(member, definition, `${path}.${label}[${index}]`);
    });
  }
}

function isIntentionalOpenRecordBoundary(
  schema: JsonSchema,
  definition: SchemaDefinition,
  path: string,
): boolean {
  return (
    definition.name === intentionalOpenRecordBoundary.name &&
    definition.exportName === intentionalOpenRecordBoundary.exportName &&
    definition.schema === intentionalOpenRecordBoundary.schema &&
    path === intentionalOpenRecordBoundary.path &&
    schema.properties === undefined &&
    typeof schema.additionalProperties === "object"
  );
}

function assertNoAdditionalPropertiesFalse(schema: JsonSchema, path: string): void {
  const schemaWithoutNull = nonNullSchema(schema);

  if (schemaWithoutNull.additionalProperties === false) {
    throw new Error(`${path} JSON Schema is stricter than Zod input semantics`);
  }

  if (schemaWithoutNull.type === "object") {
    for (const [propertyName, propertySchema] of Object.entries(
      schemaWithoutNull.properties ?? {},
    )) {
      assertNoAdditionalPropertiesFalse(propertySchema, `${path}.${propertyName}`);
    }
  }

  if (schemaWithoutNull.type === "array" && schemaWithoutNull.items !== undefined) {
    assertNoAdditionalPropertiesFalse(schemaWithoutNull.items, `${path}[]`);
  }

  for (const [label, members] of [
    ["anyOf", schemaWithoutNull.anyOf],
    ["oneOf", schemaWithoutNull.oneOf],
    ["allOf", schemaWithoutNull.allOf],
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
    throw new Error(`Expected error containing ${expectedMessage}, got ${message}`, {
      cause: error,
    });
  }
  throw new Error(`Expected error containing ${expectedMessage}`);
}

async function assertRejects(
  callback: () => Promise<void>,
  expectedMessage: string,
): Promise<void> {
  try {
    await callback();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(expectedMessage)) {
      return;
    }
    throw new Error(`Expected error containing ${expectedMessage}, got ${message}`, {
      cause: error,
    });
  }
  throw new Error(`Expected error containing ${expectedMessage}`);
}
