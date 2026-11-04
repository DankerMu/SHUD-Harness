import * as fs from "node:fs";
import * as io from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import {
  ChangeIdSchema,
  ChangeRequestSchema,
  JobRecordIdSchema,
  VerificationIdSchema,
} from "@shud-harness/dsh-shud-core";
import { createChangeRequest, createVerificationCase } from "@shud-harness/dsh-shud-records";
import { barrier } from "../../dsh-shud-jobs/src/state-indexes/test-harness.ts";
import { enteredBeforeCompletion } from "../../dsh-shud-jobs/src/list-run-jobs/test-harness.ts";
import { cardSnapshot, getCard, putCard, treeOrAbsent } from "./task-linked/test-harness.ts";
import {
  DRAFT,
  OTHER_REPORT,
  expectReportError,
  generated,
  reportHarness,
  seedCodeChangeEvidence,
} from "./report-workflow/test-harness.ts";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof io>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
const native = await vi.importActual<typeof io>("node:fs/promises");
beforeEach(() => {
  vi.mocked(io.readFile).mockReset().mockImplementation(native.readFile);
});

for (const boundary of ["query", "evidence"] as const) {
  test.each([
    "fields",
    "links",
    "remove-change",
    "remove-verification",
    "missing-change",
    "missing-verification",
    "job",
    "unlink-base",
    "unlink-candidate",
    "type",
    "state",
  ] as const)(
    `code_change fresh ${boundary} boundary preserves or rejects concurrent %s`,
    async (mutation) => {
      const h = await reportHarness();
      const entered = barrier();
      const release = barrier();
      let pending: Promise<unknown> | undefined;
      try {
        const { change, verification, runs } = await seedCodeChangeEvidence(h);
        const proposed = createChangeRequest(
          h.cwd,
          ChangeRequestSchema.parse({
            ...change,
            change_id: "CHG-20261102T090000-ffff",
            patch_path: "patches/CHG-20261102T090000-ffff.patch",
            status: "proposed",
            approval_ref: null,
            approved_at: null,
          }),
        );
        fs.writeFileSync(join(h.cwd, "fresh-candidate.dat"), "");
        const failed = createVerificationCase(h.cwd, {
          ...verification,
          status: "failed",
          failure_reason: "Fresh candidate differs.",
          artifact_refs: [verification.artifact_refs[0], "fresh-candidate.dat"],
          observed: {
            ...verification.observed,
            candidate_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          },
        });
        const target = join(
          runs[0].job.run_dir,
          boundary === "query" ? "run-job.json" : "run-record.json",
        );
        let held = false;
        vi.mocked(io.readFile).mockImplementation(async (...args) => {
          if (args[0] === target && !held) {
            held = true;
            entered.release();
            await release.waiting;
          }
          return native.readFile(...args);
        });
        const operation = h.invoke("report_generate", DRAFT);
        pending = operation;
        await enteredBeforeCompletion(entered.waiting, operation);
        const current = getCard(h);
        if (mutation === "fields" || mutation === "links")
          putCard(h, {
            ...current,
            title: "Concurrent PI title",
            current_owner: "pi",
            linked_reports: [OTHER_REPORT],
            ...(mutation === "links"
              ? {
                  linked_changes: [proposed.change_id, change.change_id, proposed.change_id],
                  linked_verifications: [failed.vc_id, verification.vc_id, failed.vc_id],
                }
              : {}),
          });
        else if (mutation === "remove-change") putCard(h, { ...current, linked_changes: [] });
        else if (mutation === "remove-verification")
          putCard(h, { ...current, linked_verifications: [] });
        else if (mutation === "missing-change")
          putCard(h, {
            ...current,
            linked_changes: [
              ...current.linked_changes,
              ChangeIdSchema.parse("CHG-20991231T235959-ffff"),
            ],
          });
        else if (mutation === "missing-verification")
          putCard(h, {
            ...current,
            linked_verifications: [
              ...current.linked_verifications,
              VerificationIdSchema.parse("VC-20991231T235959-ffff"),
            ],
          });
        else if (mutation === "job")
          putCard(h, {
            ...current,
            linked_jobs: [
              ...current.linked_jobs,
              JobRecordIdSchema.parse("JOB-20991231T235959-ffff"),
            ],
          });
        else if (mutation === "unlink-base" || mutation === "unlink-candidate")
          putCard(h, {
            ...current,
            linked_jobs: [runs[mutation === "unlink-base" ? 1 : 0].job.job_id],
          });
        else if (mutation === "type")
          putCard(h, { ...current, type: "ops", source_base_commit: null });
        else putCard(h, { ...current, status: "done" });
        const afterWriter = await cardSnapshot(h);
        release.release();
        const result = await operation;
        if (
          mutation === "fields" ||
          mutation === "links" ||
          (boundary === "query" && (mutation === "unlink-base" || mutation === "unlink-candidate"))
        ) {
          const report = generated(h, result);
          if (mutation === "fields" || mutation === "links")
            expect(getCard(h)).toMatchObject({
              title: "Concurrent PI title",
              current_owner: "pi",
              linked_reports: [OTHER_REPORT, report.report_id],
            });
          else expect(getCard(h).linked_jobs).toEqual(runs.map(({ job }) => job.job_id));
          expect(report.change_ids).toEqual(
            mutation === "links" ? [proposed.change_id, change.change_id] : [change.change_id],
          );
          expect(report.verification_ids).toEqual(
            mutation === "links" ? [failed.vc_id, verification.vc_id] : [verification.vc_id],
          );
        } else {
          expectReportError(result, /closure|type.*ops|state.*done/u);
          expect(await cardSnapshot(h)).toEqual(afterWriter);
          expect(await treeOrAbsent(join(h.cwd, "reports"))).toBeNull();
        }
      } finally {
        release.release();
        await pending;
        vi.mocked(io.readFile).mockImplementation(native.readFile);
        await h.dispose();
      }
    },
  );
}

test("code_change closure failure retains only independently committed reconciliation", async () => {
  const h = await reportHarness();
  try {
    const { change, runs } = await seedCodeChangeEvidence(h);
    putCard(h, { ...getCard(h), linked_jobs: [] });
    fs.unlinkSync(join(h.cwd, change.patch_path));
    const evidence = await treeOrAbsent(join(h.cwd, "runs"));
    expectReportError(await h.invoke("report_generate", DRAFT), /patch_read_error/u);
    expect(getCard(h)).toMatchObject({
      status: "running",
      linked_jobs: runs.map(({ job }) => job.job_id),
      linked_reports: [],
    });
    expect(await treeOrAbsent(join(h.cwd, "reports"))).toBeNull();
    expect(await treeOrAbsent(join(h.cwd, "runs"))).toEqual(evidence);
    const reconciled = await treeOrAbsent(h.cwd);
    expectReportError(await h.invoke("report_generate", DRAFT), /patch_read_error/u);
    expect(await treeOrAbsent(h.cwd)).toEqual(reconciled);
  } finally {
    await h.dispose();
  }
});
