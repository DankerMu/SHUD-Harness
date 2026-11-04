import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { BuildRecordSchema } from "@shud-harness/dsh-shud-core";
import {
  binaryBytes,
  binarySha256,
} from "../../../dsh-shud-jobs/src/submit-shud-build/test-harness.ts";
import { waitForRecovery } from "../../../dsh-shud-jobs/src/reconcile-shud/test-harness.ts";
import { buildCase } from "../../../dsh-shud-records/src/workspace-files-test-harness.ts";

export async function seedBuild(cwd: string) {
  const build = BuildRecordSchema.parse({ ...buildCase.value, binary_sha256: binarySha256 });
  const buildDir = join(await realpath(cwd), "builds", build.build_id);
  const source = join(buildDir, "shud");
  const recordPath = join(buildDir, "build-record.json");
  await mkdir(buildDir, { recursive: true });
  await writeFile(source, binaryBytes, { mode: 0o755 });
  await writeFile(recordPath, `${JSON.stringify(build)}\n`);
  return { build, buildDir, source, recordPath };
}

export async function expectNativeReceipt(runDir: string, name: string, expected: string) {
  const path = join(runDir, name);
  await waitForRecovery(async () => {
    try {
      return (await readFile(path, "utf8")) === expected;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
  }, `native ${name} publication`);
  expect(await readFile(path, "utf8")).toBe(expected);
}
