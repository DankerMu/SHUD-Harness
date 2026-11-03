import { execFileSync } from "node:child_process";
import * as io from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { TaskIdSchema } from "@shud-harness/dsh-shud-core";
import { ShudJobRegistry } from "./index.ts";
import { actualRegistry, submissionProducer } from "./submit-shud/test-harness.ts";
import { buildFixture, fileSnapshot, names } from "./submit-shud-build/test-harness.ts";

async function pathEvidence(paths: string[]) {
  return Promise.all(
    paths.map(async (path) => {
      try {
        const stat = await io.lstat(path, { bigint: true });
        return {
          path,
          ino: stat.ino,
          mode: stat.mode,
          mtimeNs: stat.mtimeNs,
          bytes: stat.isFile() ? await io.readFile(path) : null,
          link: stat.isSymbolicLink() ? await io.readlink(path) : null,
        };
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          ["ENOENT", "ENOTDIR"].includes(String(error.code))
        )
          return { path, code: error.code };
        throw error;
      }
    }),
  );
}

const pathCases = ["root", "directory", "record", "binary"].flatMap((layer) =>
  [
    "missing",
    "symlink",
    "fifo",
    ...(layer === "root" || layer === "directory" ? ["file"] : ["directory"]),
  ].map((kind) => ({ layer, kind })),
);

test.each(pathCases)(
  "unsafe build $layer ($kind) rejects before evidence capture or producer",
  async ({ layer, kind }) => {
    const h = await buildFixture();
    const execution = submissionProducer();
    try {
      const paths = {
        root: join(h.cwd, "builds"),
        directory: h.buildDir,
        record: h.recordPath,
        binary: h.source,
      };
      const path = paths[layer as keyof typeof paths];
      const saved = join(h.root, "original-build-entry");
      await io.rename(path, saved);
      if (kind === "symlink") await io.symlink(saved, path);
      if (kind === "fifo") execFileSync("mkfifo", [path]);
      if (kind === "file") await io.writeFile(path, "foreign entry\n");
      if (kind === "directory") await io.mkdir(path);
      const watched = [...Object.values(paths), saved];
      const before = await pathEvidence(watched);
      await h.apply(ShudJobRegistry, h.config);
      const registry = actualRegistry(h.ctx);
      await expect(registry.submitShud(h.buildRequest, execution.start)).rejects.toThrow(
        h.build.build_id,
      );
      expect(execution.handles).toEqual([]);
      expect(registry.indexes.read()).toEqual({ active: [], completed: [] });
      expect(await names(join(h.cwd, "runs"))).toEqual([]);
      expect(await names(join(h.cwd, "stacks"))).toEqual([]);
      expect(await names(join(h.cwd, "provenance"))).toEqual([]);
      expect(await pathEvidence(watched)).toEqual(before);
      for (const [name, bytes] of Object.entries(h.originals))
        expect(await io.readFile(join(h.inputDir, name))).toEqual(bytes);
    } finally {
      await execution.finish();
      await h.dispose();
    }
  },
);

test.each([
  { kind: "json", reason: /record|JSON|parse/iu },
  { kind: "schema", reason: /schema|compiler|record/iu },
  { kind: "identity", reason: /identity|build_id|mismatch/iu },
  { kind: "task", reason: /task_id/iu },
  { kind: "binary-path", reason: /binary_path|path|schema/iu },
  { kind: "mode", reason: /executable|permission|mode/iu },
  { kind: "hash", reason: /sha256|hash/iu },
])(
  "invalid build $kind gives a check-specific failure without fallback",
  async ({ kind, reason }) => {
    const h = await buildFixture();
    const execution = submissionProducer();
    try {
      let request = h.buildRequest;
      if (kind === "json") await io.writeFile(h.recordPath, "not JSON\n");
      if (kind === "schema")
        await io.writeFile(h.recordPath, JSON.stringify({ ...h.build, compiler: 42 }));
      if (kind === "identity") {
        const id = "BUILD-20261102T090000-ffff";
        await io.writeFile(
          h.recordPath,
          JSON.stringify({
            ...h.build,
            build_id: id,
            binary_path: `builds/${id}/shud`,
            stdout_path: `builds/${id}/make.stdout.log`,
            stderr_path: `builds/${id}/make.stderr.log`,
          }),
        );
      }
      if (kind === "task")
        request = { ...request, task_id: TaskIdSchema.parse("TASK-20261102T090000-ffff") };
      if (kind === "binary-path")
        await io.writeFile(
          h.recordPath,
          JSON.stringify({ ...h.build, binary_path: "../outside/shud" }),
        );
      if (kind === "mode") await io.chmod(h.source, 0o644);
      if (kind === "hash") await io.writeFile(h.source, "#!/bin/sh\nexit 77\n");
      const source = await fileSnapshot(h.source);
      const record = await fileSnapshot(h.recordPath);
      await h.apply(ShudJobRegistry, h.config);
      const registry = actualRegistry(h.ctx);
      const outcome: unknown = await registry
        .submitShud(request, execution.start)
        .catch((error: unknown) => error);
      expect(outcome).toBeInstanceOf(Error);
      if (!(outcome instanceof Error)) throw new Error("Invalid build unexpectedly executed");
      expect(outcome.message).toContain(h.build.build_id);
      expect(outcome.message).toMatch(reason);
      expect(execution.handles).toEqual([]);
      expect(registry.indexes.read()).toEqual({ active: [], completed: [] });
      expect(await names(join(h.cwd, "runs"))).toEqual([]);
      expect(await names(join(h.cwd, "stacks"))).toEqual([]);
      expect(await names(join(h.cwd, "provenance"))).toEqual([]);
      expect(await fileSnapshot(h.source)).toEqual(source);
      expect(await fileSnapshot(h.recordPath)).toEqual(record);
    } finally {
      await execution.finish();
      await h.dispose();
    }
  },
);
