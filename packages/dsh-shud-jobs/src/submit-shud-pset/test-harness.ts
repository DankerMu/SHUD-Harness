import * as io from "node:fs/promises";
import { join } from "node:path";
import {
  AnalysisPlanIdSchema,
  type RunJob,
  type RunRecordInput,
} from "@shud-harness/dsh-shud-core";
import { makeRunRecord } from "../../../dsh-shud-records/src/task-lifecycle-test-harness.ts";
import { ShudJobRegistry, type SubmitShudRequest } from "../index.ts";
import {
  indexed,
  QUERY_POLL_MS,
  queryRecord,
  TARGET_TASK,
  writeQueryRecord,
} from "../list-run-jobs/test-harness.ts";
import {
  actualRegistry,
  submissionFixture,
  submissionProducer,
} from "../submit-shud/test-harness.ts";
import { PLAN_ID, sha256 } from "../submit-shud-plan/test-harness.ts";

export const OTHER_PLAN = AnalysisPlanIdSchema.parse("PLAN-20261108T093000-5c1f");
export const DUPLICATE =
  /PSET-2 of analysis plan PLAN-20261108T093000-5c1e already has a non-failed run/u;
export const PRIVATE_LEDGER = "PRIVATE_LEDGER_ERROR_661";

export function ledger(attempts: number) {
  return { attempts, last_error: PRIVATE_LEDGER, at: "2026-10-22T03:16:00Z" };
}

export interface SeedEvidence {
  /** A RunRecord override object, or literal file bytes. */
  record?: Partial<RunRecordInput> | string;
  /** A ledger object, or literal file bytes. */
  ledger?: object | string;
  index?: "active" | "completed";
}

function bytes(value: object | string): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * Plan-bound submissions with registry polling effectively disabled, so seeded jobs keep their
 * bytes; each SHUD wrapper keeps a short own cadence so fixture cleanup settles promptly.
 */
export async function psetFixture() {
  const h = await submissionFixture();
  const producers: ReturnType<typeof submissionProducer>[] = [];
  try {
    await h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: QUERY_POLL_MS });
    const registry = actualRegistry(h.ctx);
    const request = (fields: Partial<SubmitShudRequest> = {}): SubmitShudRequest => ({
      ...h.request,
      task_id: TARGET_TASK,
      analysis_plan_id: PLAN_ID,
      parameter_set_id: "PSET-2",
      calib_overrides: [],
      threads: 1,
      input_digests: { "tiny.cfg.para": sha256(h.originals["tiny.cfg.para"]) },
      ...fields,
    });
    const submit = (fields?: Partial<SubmitShudRequest>) => {
      const producer = submissionProducer();
      producers.push(producer);
      return registry.submitShud(request(fields), (record, handle) =>
        producer.start(record, handle, 50),
      );
    };
    const unbound = { analysis_plan_id: null, parameter_set_id: null, input_digests: null };
    async function seed(suffix: string, changes: Partial<RunJob>, evidence: SeedEvidence = {}) {
      const job = queryRecord(h, suffix, {
        analysis_plan_id: PLAN_ID,
        parameter_set_id: "PSET-2",
        ...changes,
      });
      await writeQueryRecord(job);
      const { record, ledger: retained, index = "active" } = evidence;
      if (record !== undefined)
        await io.writeFile(
          join(job.run_dir, "run-record.json"),
          typeof record === "string" ? record : JSON.stringify(makeRunRecord(job, record)),
        );
      if (retained !== undefined)
        await io.writeFile(join(job.run_dir, "collect-error.json"), bytes(retained));
      await registry.indexes.addActive(indexed(job));
      if (index === "completed") await registry.indexes.completeActive(job.run_id);
      return job;
    }
    return {
      ...h,
      registry,
      request,
      submit,
      unbound,
      seed,
      async close() {
        try {
          for (const producer of producers) await producer.finish();
        } finally {
          await h.dispose();
        }
      },
    };
  } catch (error) {
    await h.dispose();
    throw error;
  }
}
