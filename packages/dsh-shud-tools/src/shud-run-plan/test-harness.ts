import * as fs from "node:fs";
import * as io from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AnalysisPlanIdSchema,
  type AnalysisPlanId,
  type RunJob,
  type RunRecordInput,
} from "@shud-harness/dsh-shud-core";
import { makeRunRecord } from "../../../dsh-shud-records/src/task-lifecycle-test-harness.ts";
import { binaryBytes } from "../../../dsh-shud-jobs/src/submit-shud-build/test-harness.ts";
import {
  indexed,
  queryRecord,
  writeQueryRecord,
} from "../../../dsh-shud-jobs/src/list-run-jobs/test-harness.ts";
import {
  analysisHarness,
  seedCard,
  successValue,
  validArgs,
  workspaceSnapshot,
} from "../analysis-create/test-harness.ts";
import { TASK } from "../task-linked/test-harness.ts";

const CCW = fileURLToPath(new URL("../../../../SHUD/input/ccw/", import.meta.url));

export type PlanHarness = Awaited<ReturnType<typeof planHarness>>;

/**
 * analysisHarness plus the complete top-level ccw input (every submission hashes the tsd.forc
 * forcing) and a solver that records its thread environment, then waits for `allow-exit`.
 */
export async function planHarness() {
  const h = await analysisHarness();
  try {
    for (const entry of fs.readdirSync(CCW, { withFileTypes: true })) {
      if (entry.isFile()) fs.copyFileSync(join(CCW, entry.name), join(h.input, entry.name));
    }
    // The solver path is a link owned by this isolated harness; replace it, never write through.
    await io.unlink(h.shudBin);
    await io.writeFile(h.shudBin, binaryBytes, { mode: 0o755 });
    return {
      ...h,
      /** Seed a sensitivity card and create its linked plan through the real analysis_create. */
      async createPlan(overrides: Record<string, unknown> = {}): Promise<AnalysisPlanId> {
        seedCard(h);
        const value = successValue(await h.invoke({ ...validArgs, ...overrides }));
        return AnalysisPlanIdSchema.parse(value.analysis_plan_id);
      },
      run(plan: AnalysisPlanId, fields: Record<string, unknown> = {}) {
        return h.call({
          task_id: TASK,
          input_dir: "input/ccw",
          analysis_plan_id: plan,
          parameter_set_id: "PSET-3",
          ...fields,
        });
      },
      /** Every workspace surface and both indexes; a rejected submission leaves all unchanged. */
      async effects() {
        return { ...(await workspaceSnapshot(h)), indexes: h.registry.indexes.read() };
      },
    };
  } catch (error) {
    await h.dispose();
    throw error;
  }
}

export interface SeededEvidence {
  record?: Partial<RunRecordInput>;
  ledger?: object;
  index?: "active" | "completed";
}

/** Index a prior RunJob of this card directly, as an earlier host lifetime would have left it. */
export async function seedPriorJob(
  h: PlanHarness,
  suffix: string,
  changes: Partial<RunJob>,
  { record, ledger, index = "active" }: SeededEvidence = {},
): Promise<RunJob> {
  const job = queryRecord(h, suffix, { task_id: TASK, ...changes });
  await writeQueryRecord(job);
  if (record) {
    await io.writeFile(
      join(job.run_dir, "run-record.json"),
      JSON.stringify(makeRunRecord(job, record)),
    );
  }
  if (ledger) await io.writeFile(join(job.run_dir, "collect-error.json"), JSON.stringify(ledger));
  await h.registry.indexes.addActive(indexed(job));
  if (index === "completed") await h.registry.indexes.completeActive(job.run_id);
  return job;
}

/** The run-local copy of one input file the solver reads. */
export function copied(job: RunJob, name: string) {
  return fs.readFileSync(join(job.run_dir, "input", job.project, name), "latin1");
}
