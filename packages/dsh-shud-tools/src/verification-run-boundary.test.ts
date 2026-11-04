import { readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { VerificationCaseSchema, VerificationIdSchema } from "@shud-harness/dsh-shud-core";
import { readWorkspaceRecord } from "@shud-harness/dsh-shud-records";
import { fileSnapshot, resultValue } from "./report-workflow/test-harness.ts";
import { expectToolError, treeOrAbsent } from "./task-linked/test-harness.ts";
import {
  COMPARED_PATH,
  OUTPUT_SHA256,
  PRIOR_VERIFICATION,
  REVIEWER_NOTES,
  verificationHarness,
} from "./verification-run/test-harness.ts";

// Standard SHA-256 empty-input vector; no production hash helper supplies this oracle.
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

test("verification_run records and links a failed verdict for unequal rivqdown bytes", async () => {
  const h = await verificationHarness();
  try {
    await writeFile(join(h.candidate.job.run_dir, COMPARED_PATH), "");
    const before = await h.evidenceSnapshot();
    const value = resultValue(await h.invoke());
    const id = VerificationIdSchema.parse(value.vc_id);
    const observed = {
      compared_path: COMPARED_PATH,
      base_sha256: OUTPUT_SHA256,
      candidate_sha256: EMPTY_SHA256,
    };
    const { failure_reason: failureReason, ...verdict } = value;
    expect(verdict).toEqual({
      vc_id: id,
      status: "failed",
      observed,
    });
    expect(failureReason).toBeTypeOf("string");
    expect(failureReason).toContain(OUTPUT_SHA256);
    expect(failureReason).toContain(EMPTY_SHA256);
    const verification = VerificationCaseSchema.parse(
      readWorkspaceRecord(h.cwd, "verification", id, { readonly: true }),
    );
    expect(verification).toMatchObject({
      vc_id: id,
      task_id: "TASK-20261102T090000-c3d4",
      change_id: h.change.change_id,
      case_type: "regression",
      expected_result_source: "baseline_regression",
      pass_criteria: "sha256(candidate rivqdown.dat) == sha256(base rivqdown.dat)",
      bundle_id: null,
      base_run_id: "RUN-20261022T031500-1001",
      candidate_run_id: "RUN-20261022T031500-1002",
      base_build_id: "BUILD-20261102T090000-1001",
      candidate_build_id: "BUILD-20261102T090000-a7b8",
      target_code_targets: ["docs/build.md", "scripts/build.sh"],
      artifact_refs: [
        "runs/RUN-20261022T031500-1001/output/tiny.out/tiny.rivqdown.dat",
        "runs/RUN-20261022T031500-1002/output/tiny.out/tiny.rivqdown.dat",
      ],
      status: "failed",
      observed,
      reviewed_by: "reviewer",
      reviewer_notes: REVIEWER_NOTES,
      // An authored compatible verdict must not override the unequal-byte result.
      compatibility_verdict: "compatible",
    });
    expect(verification.failure_reason).toContain(OUTPUT_SHA256);
    expect(verification.failure_reason).toContain(EMPTY_SHA256);
    expect(verification.failure_reason).toBe(value.failure_reason);
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

test("verification_run rejects missing rivqdown evidence without publishing or linking", async () => {
  const h = await verificationHarness();
  try {
    const candidateOutput = join(h.candidate.job.run_dir, COMPARED_PATH);
    await unlink(candidateOutput);
    const cardPath = join(h.cwd, "tasks", h.card.task_id, "task.json");
    const verificationPath = join(h.cwd, "verifications");
    expect(await treeOrAbsent(verificationPath)).toBeNull();
    // Snapshot after the deliberate deletion; recursive snapshots retain all remaining evidence.
    const beforeCard = await fileSnapshot(cardPath);
    const beforeEvidence = await h.evidenceSnapshot();
    const beforeWorkspace = await treeOrAbsent(h.root);

    const message = expectToolError(await h.invoke(), /missing/iu);
    expect(message).toContain(COMPARED_PATH);
    expect(message).toContain(h.candidate.job.run_id);
    expect(await treeOrAbsent(candidateOutput)).toBeNull();
    expect(await treeOrAbsent(verificationPath)).toBeNull();
    expect(await fileSnapshot(cardPath)).toEqual(beforeCard);
    expect(await h.evidenceSnapshot()).toEqual(beforeEvidence);
    expect(await treeOrAbsent(h.root)).toEqual(beforeWorkspace);
  } finally {
    await h.dispose();
  }
});
