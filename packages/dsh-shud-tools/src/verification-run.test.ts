import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { VerificationCaseSchema, VerificationIdSchema } from "@shud-harness/dsh-shud-core";
import { readWorkspaceRecord } from "@shud-harness/dsh-shud-records";
import { resultValue } from "./report-workflow/test-harness.ts";
import {
  COMPARED_PATH,
  OUTPUT_SHA256,
  PRIOR_VERIFICATION,
  REVIEWER_NOTES,
  verificationHarness,
} from "./verification-run/test-harness.ts";

test("verification_run records a passed byte replay and links it without changing collected evidence", async () => {
  const h = await verificationHarness();
  try {
    // Qualify the constructed evidence through the actual readonly registry before the tool call.
    // No solver is submitted, and the approved CR is fixture data, not an approval interaction.
    expect(await h.registry.listRunJobsByTask(h.card.task_id)).toEqual([
      h.base.job,
      h.candidate.job,
    ]);
    expect(await h.registry.collectShud(h.base.job.run_id, { readonly: true })).toEqual(h.base.run);
    expect(await h.registry.collectShud(h.candidate.job.run_id, { readonly: true })).toEqual(
      h.candidate.run,
    );
    const before = await h.evidenceSnapshot();

    // The preimplementation RED must reach this positive assertion (UNKNOWN_TOOL), not fail setup.
    const value = resultValue(await h.invoke());
    const id = VerificationIdSchema.parse(value.vc_id);
    const observed = {
      compared_path: COMPARED_PATH,
      base_sha256: OUTPUT_SHA256,
      candidate_sha256: OUTPUT_SHA256,
    };
    expect(value).toEqual({
      vc_id: id,
      status: "passed",
      observed,
      failure_reason: null,
    });
    const verification = VerificationCaseSchema.parse(
      readWorkspaceRecord(h.cwd, "verification", id, { readonly: true }),
    );
    expect(verification).toMatchObject({
      vc_id: id,
      task_id: "TASK-20261102T090000-c3d4",
      change_id: h.change.change_id,
      bundle_id: null,
      case_type: "regression",
      expected_result_source: "baseline_regression",
      target_code_targets: ["docs/build.md", "scripts/build.sh"],
      base_run_id: "RUN-20261022T031500-1001",
      candidate_run_id: "RUN-20261022T031500-1002",
      base_build_id: "BUILD-20261102T090000-1001",
      candidate_build_id: "BUILD-20261102T090000-a7b8",
      artifact_refs: [
        "runs/RUN-20261022T031500-1001/output/tiny.out/tiny.rivqdown.dat",
        "runs/RUN-20261022T031500-1002/output/tiny.out/tiny.rivqdown.dat",
      ],
      observed,
      status: "passed",
      failure_reason: null,
      // The current projection is reviewer even though the session header still says worker.
      reviewed_by: "reviewer",
      reviewer_notes: REVIEWER_NOTES,
      compatibility_verdict: "compatible",
    });
    expect(id).not.toBe(PRIOR_VERIFICATION);
    expect(await readdir(join(h.cwd, "verifications"))).toEqual([`${id}.json`]);

    const card = readWorkspaceRecord(h.cwd, "task", h.card.task_id, { readonly: true });
    expect(card).toEqual({
      ...h.card,
      linked_verifications: [PRIOR_VERIFICATION, id].sort(),
      updated_at: card.updated_at,
    });
    expect(card.status).toBe("running");
    expect(card.runtime_phase).toBe("running_local");
    expect(await h.evidenceSnapshot()).toEqual(before);
  } finally {
    await h.dispose();
  }
});
