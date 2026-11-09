import * as io from "node:fs/promises";
import { join } from "node:path";
import type * as NodeIo from "node:fs/promises";
import { beforeEach, expect, test, vi } from "vitest";
import { ShudJobRegistry, type SubmitShudRequest } from "./index.ts";
import {
  actualRegistry,
  snapshotTree,
  submissionFixture,
  submissionProducer,
} from "./submit-shud/test-harness.ts";
import { PLAN_ID, sha256 } from "./submit-shud-plan/test-harness.ts";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof NodeIo>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const actualIo = await vi.importActual<typeof NodeIo>("node:fs/promises");
beforeEach(() => {
  vi.mocked(io.rename).mockReset().mockImplementation(actualIo.rename);
});

const CALIB = "GEOL_KSATH\t1\nLC_ROUGH\t1\n";

/** Fail the nth atomic replacement of one run-copy input file. */
function failNthWrite(name: string, nth: number) {
  let writes = 0;
  vi.mocked(io.rename).mockImplementation(async (source, target) => {
    if (String(target).endsWith(`/input/tiny/${name}`) && ++writes === nth)
      throw new Error(`injected ${name} write failure`);
    await actualIo.rename(source, target);
  });
}

type Case = {
  calib?: string;
  fields?: (digest: Record<string, string>) => Partial<SubmitShudRequest>;
  inject?: () => void;
  reason: string;
};

const cases: Record<string, Case> = {
  "digest mismatch": {
    fields: (digest) => ({
      input_digests: { "tiny.cfg.calib": "0".repeat(64), "tiny.cfg.para": digest["tiny.cfg.para"] },
    }),
    reason: "tiny.cfg.calib",
  },
  "listed file missing from the copy": {
    fields: (digest) => ({
      input_digests: { "tiny.cfg.calib": digest["tiny.cfg.calib"], "tiny.para.lc": "0".repeat(64) },
    }),
    reason: "tiny.para.lc",
  },
  "listed path is a directory": {
    fields: (digest) => ({
      input_digests: { "tiny.cfg.calib": digest["tiny.cfg.calib"], "nested/empty": "0".repeat(64) },
    }),
    reason: "nested/empty",
  },
  "calib key without an effective line": {
    calib: "# GEOL_KSATH 1\nLC_ROUGH\t1\n",
    reason: "GEOL_KSATH",
  },
  "calib key with two effective lines": {
    calib: "GEOL_KSATH\t1\ngeol_ksath 1\n",
    reason: "GEOL_KSATH",
  },
  "non-finite calib value": { calib: "GEOL_KSATH\tinf\n", reason: "GEOL_KSATH" },
  // No end_days: the first cfg.para replacement is DT_YE_IC, the second NUM_OPENMP.
  "NUM_OPENMP write failure": {
    inject: () => failNthWrite("tiny.cfg.para", 2),
    reason: "injected tiny.cfg.para write failure",
  },
  "calib write failure": {
    inject: () => failNthWrite("tiny.cfg.calib", 1),
    reason: "injected tiny.cfg.calib write failure",
  },
};

test.each(Object.entries(cases))(
  "%s rolls back completely and keeps an earlier run's StackLock",
  async (_name, { calib = CALIB, fields, inject, reason }) => {
    const h = await submissionFixture();
    const earlier = submissionProducer();
    const execution = submissionProducer();
    try {
      await io.writeFile(join(h.inputDir, "tiny.cfg.calib"), calib);
      await h.apply(ShudJobRegistry, h.config);
      const registry = actualRegistry(h.ctx);
      const first = await registry.submitShud(h.request, earlier.start);
      const lock = join(h.cwd, "stacks", `${first.stack_id}.json`);
      const lockBefore = await io.stat(lock, { bigint: true });
      const evidence = {
        stacks: await snapshotTree(join(h.cwd, "stacks")),
        provenance: await snapshotTree(join(h.cwd, "provenance")),
        input: await snapshotTree(h.inputDir),
        runs: await io.readdir(join(h.cwd, "runs")),
        indexes: registry.indexes.read(),
      };
      const digest: Record<string, string> = {};
      for (const name of ["tiny.cfg.calib", "tiny.cfg.para"])
        digest[name] = sha256(await io.readFile(join(h.inputDir, name)));
      inject?.();
      await expect(
        registry.submitShud(
          {
            ...h.request,
            analysis_plan_id: PLAN_ID,
            parameter_set_id: "PSET-2",
            calib_overrides: [{ key: "GEOL_KSATH", multiplier: 2 }],
            threads: 1,
            input_digests: { "tiny.cfg.calib": digest["tiny.cfg.calib"] },
            ...fields?.(digest),
          },
          execution.start,
        ),
      ).rejects.toThrow(reason);
      expect(execution.handles).toEqual([]);
      expect({
        stacks: await snapshotTree(join(h.cwd, "stacks")),
        provenance: await snapshotTree(join(h.cwd, "provenance")),
        input: await snapshotTree(h.inputDir),
        runs: await io.readdir(join(h.cwd, "runs")),
        indexes: registry.indexes.read(),
      }).toEqual(evidence);
      const lockAfter = await io.stat(lock, { bigint: true });
      expect([lockAfter.ino, lockAfter.mtimeNs]).toEqual([lockBefore.ino, lockBefore.mtimeNs]);
      expect(registry.list().map((job) => job.id)).toEqual([first.dsh_job_id]);
    } finally {
      await execution.finish();
      await earlier.finish();
      await h.dispose();
    }
  },
);
