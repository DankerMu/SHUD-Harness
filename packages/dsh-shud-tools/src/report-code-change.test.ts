import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  evaluateClosure,
  readChangePatch,
  readWorkspaceRecord,
  renderReport,
  type ClosureRunJob,
} from "@shud-harness/dsh-shud-records";
import {
  DRAFT,
  generated,
  reportHarness,
  reportPath,
  seedCodeChangeEvidence,
  resultValue,
} from "./report-workflow/test-harness.ts";
import { getCard, treeOrAbsent } from "./task-linked/test-harness.ts";

test("code_change generation publishes a canonical draft from approved change and passed verification evidence without mutating inputs", async () => {
  const h = await reportHarness();
  try {
    const { card, change, verification, runs } = await seedCodeChangeEvidence(h);
    const protectedPaths = [
      "runs",
      "stacks",
      "provenance",
      "changes",
      "patches",
      "verifications",
      "builds",
    ].map((name) => join(h.cwd, name));
    protectedPaths.push(
      h.inputDir,
      join(h.stateDir, "active.json"),
      join(h.stateDir, "completed.json"),
    );
    const before = await Promise.all(protectedPaths.map(treeOrAbsent));

    // Qualify actual indexed, collected evidence before the report tool's positive assertion.
    // Approval and build records are fixtures; no solver, Web or PI interaction is claimed.
    const jobs = await h.registry.listRunJobsByTask(card.task_id);
    expect(jobs).toEqual(runs.map(({ job }) => job));
    expect(jobs.map(({ status }) => status)).toEqual(["collected", "collected"]);
    const records = await Promise.all(
      jobs.map(({ run_id }) => h.registry.collectShud(run_id, { readonly: true })),
    );
    expect(records).toEqual(runs.map(({ run }) => run));
    expect(records.map(({ status }) => status)).toEqual(["succeeded", "succeeded"]);
    for (const { run, stack, data } of runs) {
      expect(run.stack_id).toBe(stack.stack_id);
      expect(run.data_id).toBe(data.data_id);
      expect(readWorkspaceRecord(h.cwd, "stack", stack.stack_id, { readonly: true })).toEqual(
        stack,
      );
      expect(readWorkspaceRecord(h.cwd, "data", data.data_id, { readonly: true })).toEqual(data);
    }
    const loaders = {
      readChange: (id: typeof change.change_id) =>
        readWorkspaceRecord(h.cwd, "change", id, { readonly: true }),
      readPatch: (id: typeof change.change_id) => readChangePatch(h.cwd, id, { readonly: true }),
      readVerification: (id: typeof verification.vc_id) =>
        readWorkspaceRecord(h.cwd, "verification", id, { readonly: true }),
    };
    expect(loaders.readChange(change.change_id).status).toBe("approved");
    expect(loaders.readPatch(change.change_id).toString("utf8")).toBe("abc");
    expect(loaders.readVerification(verification.vc_id)).toMatchObject({
      status: "passed",
      change_id: change.change_id,
      reviewed_by: "reviewer",
      reviewer_notes: ["Byte equality is a regression fact, not scientific acceptance."],
    });
    const evidence: ClosureRunJob[] = await Promise.all(
      jobs.map(async (job) => ({
        job,
        collect_error_attempts: await h.registry.readCollectErrorAttempts(job.job_id),
      })),
    );
    const fresh = readWorkspaceRecord(h.cwd, "task", card.task_id, { readonly: true });
    const closure = evaluateClosure(fresh, evidence, records, DRAFT, loaders);
    expect(closure.ok, JSON.stringify(closure)).toBe(true);
    expect(await Promise.all(protectedPaths.map(treeOrAbsent))).toEqual(before);

    const report = generated(h, await h.invoke("report_generate", DRAFT));
    expect(report).toMatchObject({
      task_id: card.task_id,
      status: "draft",
      change_ids: fresh.linked_changes,
      verification_ids: fresh.linked_verifications,
      linked_runs: ["RUN-20261022T031500-1001", "RUN-20261022T031500-1002"],
      stack_ids: [runs[0].stack.stack_id],
      data_ids: [runs[0].data.data_id],
      summary: DRAFT.summary,
      observations: DRAFT.observations,
      pi_questions: DRAFT.pi_questions,
      decision_history: [],
    });
    const updated = getCard(h);
    expect(updated).toEqual({
      ...fresh,
      status: "reporting",
      runtime_phase: null,
      linked_reports: [report.report_id],
      updated_at: updated.updated_at,
    });
    const markdown = await readFile(reportPath(h, report.report_id, "md"), "utf8");
    expect(markdown).toBe(renderReport(h.cwd, report.report_id));
    expect(markdown.split("\n")[1]).toBe("DRAFT — not accepted by PI");
    expect(markdown).toContain(change.change_id);
    expect(markdown).toContain(verification.vc_id);
    expect(await Promise.all(protectedPaths.map(treeOrAbsent))).toEqual(before);
  } finally {
    await h.dispose();
  }
});

test("code_change validation rejects a changed candidate artifact without changing the draft or evidence", async () => {
  const h = await reportHarness();
  try {
    const { verification } = await seedCodeChangeEvidence(h);
    const report = generated(h, await h.invoke("report_generate", DRAFT));
    const markdownPath = reportPath(h, report.report_id, "md");
    const markdown = await readFile(markdownPath, "utf8");
    expect(markdown).toBe(renderReport(h.cwd, report.report_id));
    expect(markdown.split("\n")[1]).toBe("DRAFT — not accepted by PI");
    expect(getCard(h)).toMatchObject({
      status: "reporting",
      runtime_phase: null,
      linked_reports: [report.report_id],
    });
    expect(report.decision_history).toEqual([]);
    expect(report.verification_ids).toEqual([verification.vc_id]);

    const relativeArtifact = verification.artifact_refs[1];
    const artifactPath = join(h.cwd, relativeArtifact);
    expect(await readFile(artifactPath, "utf8")).toBe("abc");
    expect(verification.observed.candidate_sha256).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    // Change one byte after the immutable VC recorded the published SHA-256 "abc" vector.
    await writeFile(artifactPath, "abd");
    const protectedPaths = [
      h.cwd,
      h.inputDir,
      join(h.stateDir, "active.json"),
      join(h.stateDir, "completed.json"),
    ];
    // Entry is already consistent; any later write is a validation side effect, not repair.
    const before = await Promise.all(protectedPaths.map(treeOrAbsent));
    const result = resultValue(await h.invoke("report_validate", { report_id: report.report_id }));
    expect(result).toMatchObject({
      report_id: report.report_id,
      status: "draft",
      ok: false,
    });
    const checks = result.checks as Array<{
      id: number;
      pass: boolean;
      vacuous: boolean;
      details: unknown[];
    }>;
    expect(checks.map(({ id, pass }) => ({ id, pass }))).toEqual([
      { id: 1, pass: true },
      { id: 2, pass: true },
      { id: 3, pass: true },
      { id: 4, pass: true },
      { id: 5, pass: true },
      { id: 6, pass: true },
      { id: 7, pass: true },
      { id: 8, pass: true },
      { id: 9, pass: true },
      { id: 10, pass: true },
      { id: 11, pass: true },
      { id: 12, pass: true },
      { id: 13, pass: true },
      { id: 14, pass: true },
      { id: 15, pass: false },
    ]);
    expect(checks[14].vacuous).toBe(false);
    const diagnostic = JSON.stringify(checks[14].details);
    expect(diagnostic).toContain(verification.vc_id);
    expect(diagnostic).toContain(relativeArtifact);
    expect(diagnostic).not.toContain(h.cwd);
    expect(readWorkspaceRecord(h.cwd, "report", report.report_id, { readonly: true })).toEqual(
      report,
    );
    expect(getCard(h).status).toBe("reporting");
    expect(await Promise.all(protectedPaths.map(treeOrAbsent))).toEqual(before);
  } finally {
    await h.dispose();
  }
});
