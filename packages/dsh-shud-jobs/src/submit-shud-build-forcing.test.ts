import * as io from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { DataProvenanceSchema, StackLockSchema } from "@shud-harness/dsh-shud-core";
import { captureStackLock } from "@shud-harness/dsh-shud-records";
import { ShudJobRegistry } from "./index.ts";
import { actualRegistry, submissionProducer } from "./submit-shud/test-harness.ts";
import { buildFixture, fileSnapshot, names } from "./submit-shud-build/test-harness.ts";

test.each([false, true])(
  "external forcing is hashed without mutation; build=%s",
  async (withBuild) => {
    const h = await buildFixture();
    const execution = submissionProducer();
    try {
      const external = join(h.root, "external forcing");
      await io.mkdir(external);
      const station = join(external, "station.csv");
      await io.writeFile(station, "abc");
      await io.writeFile(
        join(h.inputDir, "tiny.tsd.forc"),
        `1 20000101\n${external}\nID Filename\n1 station.csv\n`,
      );
      const before = await fileSnapshot(station);
      const manifest = await fileSnapshot(join(h.inputDir, "tiny.tsd.forc"));
      await h.apply(ShudJobRegistry, h.config);
      const job = await actualRegistry(h.ctx).submitShud(
        withBuild ? h.buildRequest : h.request,
        execution.start,
      );
      const data = DataProvenanceSchema.parse(
        JSON.parse(await io.readFile(join(h.cwd, "provenance", `${job.data_id}.json`), "utf8")),
      );
      expect(data.sources.external_files).toEqual([
        {
          path: await io.realpath(station),
          size_bytes: 3,
          sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        },
      ]);
      expect(await fileSnapshot(station)).toEqual(before);
      expect(await fileSnapshot(join(h.inputDir, "tiny.tsd.forc"))).toEqual(manifest);
      expect(await fileSnapshot(h.source)).toEqual(h.before.source);
      expect(await fileSnapshot(h.recordPath)).toEqual(h.before.record);
      expect(job.build_id).toBe(withBuild ? h.build.build_id : null);
    } finally {
      await execution.finish();
      await h.dispose();
    }
  },
);

test.each(
  [false, true].flatMap((withBuild) =>
    ["missing-manifest", "missing-external", "invalid-manifest"].map((kind) => ({
      withBuild,
      kind,
    })),
  ),
)(
  "$kind failure after capture retains immutable locks only; build=$withBuild",
  async ({ withBuild, kind }) => {
    const h = await buildFixture();
    const execution = submissionProducer();
    try {
      const old = captureStackLock(
        { ...h.config, cwd: h.cwd, hostVersion: "previous-host" },
        h.request.llm,
      );
      const oldPath = join(h.cwd, "stacks", `${old.stack_id}.json`);
      const before = await fileSnapshot(oldPath);
      const foreign = join(h.cwd, "provenance", "DATA-20261102T090000-ffff.json");
      await io.mkdir(join(h.cwd, "provenance"));
      await io.writeFile(foreign, "unrelated provenance\n");
      const foreignBefore = await fileSnapshot(foreign);
      const manifest = join(h.inputDir, "tiny.tsd.forc");
      if (kind === "missing-manifest") await io.unlink(manifest);
      else
        await io.writeFile(
          manifest,
          kind === "missing-external"
            ? `1 20000101\n${h.root}/absent-forcing\nID Filename\n1 station.csv\n`
            : "not a valid forcing manifest\n",
        );
      await h.apply(ShudJobRegistry, h.config);
      const registry = actualRegistry(h.ctx);
      await expect(
        registry.submitShud(withBuild ? h.buildRequest : h.request, execution.start),
      ).rejects.toThrow(/tsd\.forc|forcing|provenance/iu);
      expect(execution.handles).toEqual([]);
      expect(registry.indexes.read()).toEqual({ active: [], completed: [] });
      expect(await names(join(h.cwd, "runs"))).toEqual([]);
      expect(await names(join(h.cwd, "provenance"))).toEqual(["DATA-20261102T090000-ffff.json"]);
      expect(await fileSnapshot(foreign)).toEqual(foreignBefore);
      expect(await fileSnapshot(oldPath)).toEqual(before);
      const locks = await names(join(h.cwd, "stacks"));
      expect(locks).toHaveLength(2);
      const captured = locks.find((name) => name !== `${old.stack_id}.json`);
      expect(captured).toBeDefined();
      if (!captured) throw new Error("Expected the submission's retained immutable lock");
      const lock = StackLockSchema.parse(
        JSON.parse(await io.readFile(join(h.cwd, "stacks", captured), "utf8")),
      );
      expect(lock.build_id).toBe(withBuild ? h.build.build_id : null);
      expect(await fileSnapshot(h.source)).toEqual(h.before.source);
      expect(await fileSnapshot(h.recordPath)).toEqual(h.before.record);
    } finally {
      await execution.finish();
      await h.dispose();
    }
  },
);
