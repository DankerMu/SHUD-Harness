import { createHash } from "node:crypto";
import * as io from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { BuildRecordSchema } from "@shud-harness/dsh-shud-core";
import { buildCase } from "../../../dsh-shud-records/src/workspace-files-test-harness.ts";
import { submissionFixture } from "../submit-shud/test-harness.ts";

// Real executable bytes, independent of the production digest/copy helpers.
export const binaryBytes = Buffer.from(
  '#!/bin/sh\nprintf \'%s\\n\' "$0" > invoked-path\nprintf \'%s\\n\' "${OMP_NUM_THREADS-unset}" "${SHUD_RHS_THREADS-unset}" "${SHUD_BUILD_TEST_MARKER-unset}" > thread-receipt\nprintf \'%s\\n\' "$@" > argv-receipt\nwhile [ ! -f allow-exit ]; do sleep 0.02; done\nexit 0\n',
);
export const binarySha256 = createHash("sha256").update(binaryBytes).digest("hex");

export async function fileSnapshot(path: string) {
  const stat = await io.stat(path, { bigint: true });
  return {
    bytes: await io.readFile(path),
    ino: stat.ino,
    mtimeNs: stat.mtimeNs,
    mode: stat.mode,
  };
}

export async function names(path: string): Promise<string[]> {
  try {
    return (await io.readdir(path)).sort();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

export async function buildFixture(project = "tiny") {
  const h = await submissionFixture(undefined, "held", "absent", project);
  try {
    // submissionFixture uses a repository script symlink; unlink it before installing real bytes.
    await io.unlink(h.shudBin);
    await io.writeFile(h.shudBin, "#!/bin/sh\nexit 13\n", { mode: 0o755 });
    const build = BuildRecordSchema.parse({ ...buildCase.value, binary_sha256: binarySha256 });
    const cwd = await io.realpath(h.cwd);
    const buildDir = join(cwd, "builds", build.build_id);
    const source = join(buildDir, "shud");
    const recordPath = join(buildDir, "build-record.json");
    await io.mkdir(buildDir, { recursive: true });
    await io.writeFile(source, binaryBytes, { mode: 0o751 });
    await io.chmod(source, 0o751);
    await io.writeFile(recordPath, `${JSON.stringify(build)}\n`);
    const before = { source: await fileSnapshot(source), record: await fileSnapshot(recordPath) };
    const originals = await Promise.all(
      Object.keys(h.originals).map(async (name) => ({
        path: join(h.inputDir, name),
        snapshot: await fileSnapshot(join(h.inputDir, name)),
      })),
    );
    return {
      ...h,
      cwd,
      build,
      buildDir,
      source,
      recordPath,
      before,
      buildRequest: { ...h.request, task_id: build.task_id, build_id: build.build_id },
      async assertReadonly() {
        expect(await fileSnapshot(source)).toEqual(before.source);
        expect(await fileSnapshot(recordPath)).toEqual(before.record);
        expect(await names(buildDir)).toEqual(["build-record.json", "shud"]);
        for (const original of originals)
          expect(await fileSnapshot(original.path)).toEqual(original.snapshot);
      },
    };
  } catch (error) {
    await h.dispose();
    throw error;
  }
}
