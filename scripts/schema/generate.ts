import { join } from "node:path";

import {
  generatedPathContext,
  jsonSchemaDir,
  markdownDir,
  recreateGeneratedDirectory,
  writeGeneratedFile,
} from "./generated-paths.ts";
import { assertSchemaRegistryComplete, schemaDefinitions } from "./registry.ts";
import { buildJsonSchema, buildMarkdown } from "./render.ts";
import { runSelfTest } from "./self-test.ts";

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
      generatedPathContext,
    );
    await writeGeneratedFile(
      join(markdownDir, `${definition.slug}.md`),
      markdown,
      generatedPathContext,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
