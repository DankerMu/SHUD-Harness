import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";
import type { ToolCallId } from "@deepseek-ai/dsh-llm";
import {
  MAX_COLLECT_ATTEMPTS,
  RunRecordSchema,
  type RunJob,
  type RunRecord,
} from "@shud-harness/dsh-shud-core";
import type { RunMetrics } from "@shud-harness/dsh-shud-records";
import { readCard } from "../analysis-create/test-harness.ts";
import { planHarness, seedPriorJob } from "../shud-run-plan/test-harness.ts";
import { putCard } from "../task-linked/test-harness.ts";
import {
  DRAFT,
  installMetrics,
  passingMetrics,
  seedStackAndData,
} from "../report-workflow/test-harness.ts";

/**
 * Evidence one sensitivity job leaves behind: a collected succeeded/failed RunRecord, an
 * uncollected terminal job (RunJob `failed`, or `succeeded` with an exhausted collect ledger),
 * or a live `running` job. Every job carries the plan binding and the shared stack/data ids.
 */
export type SensitivityRunKind =
  "succeeded" | "failed" | "uncollected-failed" | "exhausted" | "running";

export interface SeededSensitivityRun {
  job: RunJob;
  record: RunRecord | null;
}

export type SensitivityHarness = Awaited<ReturnType<typeof sensitivityHarness>>;

export const sha256 = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** The residual-warn variant of passingMetrics; 0.02 is warn per the numerical-health floors. */
export function warnMetrics(): RunMetrics {
  const metrics = passingMetrics();
  metrics.water_balance.residual = 0.02;
  metrics.numerical_health.water_balance_residual = 0.02;
  metrics.verdicts.water_balance_residual = "warn";
  return metrics;
}

/**
 * Real ToolRuntime workspace with a sensitivity card whose 4-set plan (baseline, GEOL_KSATH x0.5,
 * GEOL_KSATH x2, LC_ROUGH x2) was created and linked by analysis_create. The plan file is then
 * rewritten with the same JSON in non-canonical bytes (tab indentation, no trailing newline).
 */
export async function sensitivityHarness() {
  const h = await planHarness();
  try {
    const plan = await h.createPlan();
    const planPath = join(h.cwd, "analyses", `${plan}.json`);
    const planBytes = Buffer.from(
      JSON.stringify(JSON.parse(fs.readFileSync(planPath, "utf8")), null, "\t"),
    );
    fs.writeFileSync(planPath, planBytes);
    const { stack, data } = seedStackAndData(h);
    const invoke = (name: "report_generate" | "report_validate", args: unknown) =>
      h.runtime.execute({
        callId: "report-sensitivity-667" as ToolCallId,
        name,
        arguments: args,
        agent: h.agent,
        signal: new AbortController().signal,
      });
    return {
      ...h,
      plan,
      planPath,
      planBytes,
      invoke,
      generate: (args: unknown = DRAFT) => invoke("report_generate", args),
      async seedRun(
        suffix: string,
        parameterSetId: string,
        kind: SensitivityRunKind,
        metrics: RunMetrics = passingMetrics(),
      ): Promise<SeededSensitivityRun> {
        const failed = kind === "failed" || kind === "uncollected-failed";
        const job = await seedPriorJob(
          h,
          suffix,
          {
            analysis_plan_id: plan,
            parameter_set_id: parameterSetId,
            stack_id: stack.stack_id,
            data_id: data.data_id,
            status:
              kind === "succeeded" || kind === "failed"
                ? "collected"
                : kind === "uncollected-failed"
                  ? "failed"
                  : kind === "exhausted"
                    ? "succeeded"
                    : "running",
            exit_code: kind === "running" ? null : failed ? 19 : 0,
            pid: kind === "running" ? 4242 : null,
            pid_started_at: kind === "running" ? "2026-11-08T09:31:00Z" : null,
            submitted_at: "2026-11-08T09:31:00Z",
            started_at: "2026-11-08T09:31:00Z",
            finished_at: kind === "running" ? null : "2026-11-08T09:41:00Z",
          },
          {
            // Completed-index entries are never signalled or polled by harness teardown.
            index: "completed",
            ...(kind === "succeeded" || kind === "failed"
              ? {
                  record: {
                    analysis_plan_id: plan,
                    parameter_set_id: parameterSetId,
                    status: failed ? "failed" : "succeeded",
                    exit_code: failed ? 19 : 0,
                    exit_class: failed ? "cvode" : "ok",
                  },
                }
              : {}),
            ...(kind === "exhausted"
              ? {
                  ledger: {
                    attempts: MAX_COLLECT_ATTEMPTS,
                    last_error: "collect failed",
                    at: "2026-11-08T09:42:00Z",
                  },
                }
              : {}),
          },
        );
        if (kind !== "succeeded" && kind !== "failed") return { job, record: null };
        const record = RunRecordSchema.parse(
          JSON.parse(fs.readFileSync(join(job.run_dir, "run-record.json"), "utf8")),
        );
        if (kind === "succeeded") installMetrics(job.run_dir, record, metrics);
        return { job, record };
      },
      /** Publish the running card already reconciled to these jobs, so reconcile is a no-op. */
      link(runs: readonly SeededSensitivityRun[]) {
        return putCard(h, {
          ...readCard(h),
          status: "running",
          runtime_phase: null,
          linked_jobs: runs.map(({ job }) => job.job_id).sort(),
          stack_id: stack.stack_id,
          data_id: data.data_id,
        });
      },
    };
  } catch (error) {
    await h.dispose();
    throw error;
  }
}

/** The four-set acceptance batch: one effective run per set, every one collected and succeeded. */
export async function seedAcceptanceBatch(h: SensitivityHarness) {
  const runs = [
    await h.seedRun("0001", "PSET-1", "succeeded"),
    await h.seedRun("0002", "PSET-2", "succeeded"),
    await h.seedRun("0003", "PSET-3", "succeeded"),
    await h.seedRun("0004", "PSET-4", "succeeded"),
  ];
  h.link(runs);
  return runs;
}
