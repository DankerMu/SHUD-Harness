import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AnalysisPlanIdSchema,
  DataProvenanceSchema,
  type RunJob,
} from "@shud-harness/dsh-shud-core";
import type { SubmitShudRequest } from "../index.ts";
import { submissionFixture } from "../submit-shud/test-harness.ts";

export const PLAN_ID = AnalysisPlanIdSchema.parse("PLAN-20261108T093000-5c1e");

export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const CCW = fileURLToPath(new URL("../../../../SHUD/input/ccw/", import.meta.url));

/** Pinned ccw top-level input files (the solver's cfg/para/sp/tsd inputs) in a scratch input root. */
export async function ccwPlanFixture() {
  const h = await submissionFixture();
  try {
    const input = join(h.root, "ccw");
    await mkdir(input);
    const source: Record<string, Buffer> = {};
    for (const entry of await readdir(CCW, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      await copyFile(join(CCW, entry.name), join(input, entry.name));
      source[entry.name] = await readFile(join(input, entry.name));
    }
    const digests = (...names: string[]) =>
      Object.fromEntries(names.map((name) => [name, sha256(source[name])]));
    const planRequest = (fields: Partial<SubmitShudRequest> = {}): SubmitShudRequest => ({
      ...h.request,
      input_dir: input,
      project: "ccw",
      analysis_plan_id: PLAN_ID,
      parameter_set_id: "PSET-1",
      calib_overrides: [],
      threads: 1,
      input_digests: digests("ccw.cfg.calib"),
      ...fields,
    });
    return { ...h, input, source, digests, planRequest };
  } catch (error) {
    await h.dispose();
    throw error;
  }
}

/** The copied bytes SHUD reads, and their sha256 in this run's persisted DataProvenance. */
export async function submittedFile(cwd: string, record: RunJob, name: string) {
  const bytes = await readFile(join(record.run_dir, "input", record.project, name));
  const data = DataProvenanceSchema.parse(
    JSON.parse(await readFile(join(cwd, "provenance", `${record.data_id}.json`), "utf8")),
  );
  return { bytes, provenance: data.sources.files.find((file) => file.path === name)?.sha256 };
}
