import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  ChangeRequestSchema,
  RunJobSchema,
  VerificationCaseSchema,
} from "@shud-harness/dsh-shud-core";
import { createChangeRequest, createVerificationCase } from "@shud-harness/dsh-shud-records";
import { observedStart } from "../../dsh-shud-jobs/src/detached-shud/test-harness.ts";
import { installUnsafe } from "../../dsh-shud-records/src/test-harness.ts";
import { OTHER_TASK, getCard, putCard, treeOrAbsent } from "./task-linked/test-harness.ts";
import {
  DRAFT,
  expectReportError,
  generated,
  reportHarness,
  reportPath,
  resultValue,
  seedCodeChangeEvidence,
} from "./report-workflow/test-harness.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, readdirSync: vi.fn(actual.readdirSync) };
});
afterEach(() => vi.clearAllMocks());

for (const status of ["planned", "running", "reporting"] as const) {
  test.each(["passed", "failed"] as const)(
    `code_change ${status} reports %s verification without PI approval`,
    async (verdict) => {
      const h = await reportHarness();
      try {
        const { verification, change } = await seedCodeChangeEvidence(h);
        if (verdict === "failed") {
          verification.status = "failed";
          verification.failure_reason = "Candidate differs from baseline.";
          verification.observed.candidate_sha256 =
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
          fs.writeFileSync(join(h.cwd, verification.artifact_refs[1]), "");
          fs.writeFileSync(
            join(h.cwd, "verifications", `${verification.vc_id}.json`),
            JSON.stringify(VerificationCaseSchema.parse(verification)),
          );
        }
        putCard(h, { ...getCard(h), status });
        const evidence = await treeOrAbsent(join(h.cwd, "runs"));
        const report = generated(h, await h.invoke("report_generate", DRAFT));
        expect(report.change_ids).toEqual([change.change_id]);
        expect(report.verification_ids).toEqual([verification.vc_id]);
        expect(report.decision_history).toEqual([]);
        const markdown = fs.readFileSync(reportPath(h, report.report_id, "md"), "utf8");
        const risks = markdown.split("## 7. 风险和失败项")[1].split("## 8.")[0];
        expect(risks.includes(verification.vc_id)).toBe(verdict === "failed");
        const validated = resultValue(
          await h.invoke("report_validate", { report_id: report.report_id }),
        );
        expect(validated).toMatchObject({ status: "reviewed", ok: true });
        expect(getCard(h).status).toBe("reporting");
        expect(await treeOrAbsent(join(h.cwd, "runs"))).toEqual(evidence);
      } finally {
        await h.dispose();
      }
    },
  );
}

const failures = [
  ["no-jobs", "no_linked_jobs"],
  ["observations", "missing_observations"],
  ["limitations", "missing_limitations"],
  ["pi_questions", "missing_pi_questions"],
  ["foreign-change", "foreign_change"],
  ["foreign-verification", "foreign_verification"],
  ["proposed", "no_approved_change"],
  ["no-changes", "no_approved_change"],
  ["missing-patch", "patch_read_error"],
  ["changed-patch", "patch_digest_mismatch"],
  ["wrong-change", "verification_change_not_qualified"],
  ["no-verifications", "no_qualifying_verification"],
  ["not_run", "verification_not_terminal"],
  ["running", "verification_not_terminal"],
  ["inconclusive", "verification_not_terminal"],
  ["waived_by_pi", "verification_not_terminal"],
  ["reviewer_notes", "verification_read_error"],
  ["reviewed_by", "verification_read_error"],
  ["base-outside", "verification_run_missing"],
  ["candidate-outside", "verification_run_missing"],
  ["corrupt-change", "change_read_error"],
  ["bad-change-sibling", "change_read_error"],
  ["bad-verification-sibling", "verification_read_error"],
] as const;

test.each(failures)(
  "code_change %s fails its canonical closure clause without publication",
  async (fault, reason) => {
    const h = await reportHarness();
    try {
      const { change, verification, runs } = await seedCodeChangeEvidence(h);
      const changePath = join(h.cwd, "changes", `${change.change_id}.json`);
      const vcPath = join(h.cwd, "verifications", `${verification.vc_id}.json`);
      const args = { ...DRAFT };
      let blamed: string | undefined;
      if (["observations", "limitations", "pi_questions"].includes(fault)) {
        args[fault as "observations" | "limitations" | "pi_questions"] = [];
      } else if (fault === "no-jobs" || fault === "base-outside" || fault === "candidate-outside") {
        const excluded = fault === "no-jobs" ? runs : [runs[fault === "base-outside" ? 0 : 1]];
        for (const { job } of excluded) {
          fs.writeFileSync(
            join(job.run_dir, "run-job.json"),
            JSON.stringify(RunJobSchema.parse({ ...job, task_id: OTHER_TASK })),
          );
        }
        putCard(h, {
          ...getCard(h),
          linked_jobs: runs.filter((run) => !excluded.includes(run)).map(({ job }) => job.job_id),
        });
        if (fault !== "no-jobs") blamed = excluded[0].run.run_id;
      } else if (fault === "foreign-change") {
        fs.writeFileSync(
          changePath,
          JSON.stringify(ChangeRequestSchema.parse({ ...change, task_id: OTHER_TASK })),
        );
        blamed = change.change_id;
      } else if (fault === "foreign-verification") {
        fs.writeFileSync(
          vcPath,
          JSON.stringify(VerificationCaseSchema.parse({ ...verification, task_id: OTHER_TASK })),
        );
        blamed = verification.vc_id;
      } else if (fault === "proposed") {
        fs.writeFileSync(
          changePath,
          JSON.stringify(
            ChangeRequestSchema.parse({
              ...change,
              status: "proposed",
              approval_ref: null,
              approved_at: null,
            }),
          ),
        );
      } else if (fault === "no-changes") putCard(h, { ...getCard(h), linked_changes: [] });
      else if (fault === "missing-patch" || fault === "changed-patch") {
        const path = join(h.cwd, change.patch_path);
        if (fault === "missing-patch") fs.unlinkSync(path);
        else fs.writeFileSync(path, "abd");
        blamed = change.change_id;
      } else if (fault === "wrong-change") {
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
        putCard(h, { ...getCard(h), linked_changes: [change.change_id, proposed.change_id] });
        fs.writeFileSync(
          vcPath,
          JSON.stringify(
            VerificationCaseSchema.parse({ ...verification, change_id: proposed.change_id }),
          ),
        );
        blamed = verification.vc_id;
      } else if (fault === "no-verifications")
        putCard(h, { ...getCard(h), linked_verifications: [] });
      else if (["not_run", "running", "inconclusive", "waived_by_pi"].includes(fault)) {
        fs.writeFileSync(
          vcPath,
          JSON.stringify(VerificationCaseSchema.parse({ ...verification, status: fault })),
        );
        blamed = verification.vc_id;
      } else if (fault === "reviewer_notes" || fault === "reviewed_by") {
        fs.writeFileSync(
          vcPath,
          JSON.stringify({ ...verification, [fault]: fault === "reviewer_notes" ? [] : "" }),
        );
        blamed = verification.vc_id;
      } else if (fault === "corrupt-change") {
        fs.writeFileSync(changePath, "PRIVATE_UNREADABLE_CHANGE");
        blamed = change.change_id;
      } else if (fault === "bad-change-sibling") {
        const sibling = createChangeRequest(h.cwd, change);
        fs.writeFileSync(
          join(h.cwd, "changes", `${sibling.change_id}.json`),
          "PRIVATE_BAD_SIBLING",
        );
        putCard(h, { ...getCard(h), linked_changes: [change.change_id, sibling.change_id] });
        blamed = sibling.change_id;
      } else if (fault === "bad-verification-sibling") {
        const sibling = createVerificationCase(h.cwd, verification);
        fs.writeFileSync(
          join(h.cwd, "verifications", `${sibling.vc_id}.json`),
          "PRIVATE_BAD_SIBLING",
        );
        putCard(h, { ...getCard(h), linked_verifications: [verification.vc_id, sibling.vc_id] });
        blamed = sibling.vc_id;
      }
      const before = await treeOrAbsent(h.cwd);
      const message = expectReportError(
        await h.invoke("report_generate", args),
        new RegExp(reason, "u"),
      );
      if (blamed !== undefined) expect(message).toContain(blamed);
      if (fault === "base-outside" || fault === "candidate-outside")
        expect(message).toContain(verification.vc_id);
      expect(message).not.toContain("PRIVATE_");
      expect(await treeOrAbsent(h.cwd)).toEqual(before);
    } finally {
      await h.dispose();
    }
  },
);

test.each([
  "running",
  "failed",
  "cancelled",
  "record-failed",
  "exhausted",
  "ledger-corrupt",
  "null-stack",
  "null-data",
] as const)("code_change retains shared run and collection rules for %s", async (fault) => {
  const h = await reportHarness();
  try {
    const { runs } = await seedCodeChangeEvidence(h);
    const { job, run } = runs[1];
    if (fault === "running" || fault === "failed" || fault === "cancelled") {
      const stamp = observedStart(process.pid);
      const updated = RunJobSchema.parse({
        ...job,
        status: fault,
        ...(fault === "running"
          ? {
              pid: process.pid,
              pid_started_at: stamp,
              submitted_at: stamp,
              started_at: stamp,
              finished_at: null,
              exit_code: null,
            }
          : {}),
      });
      fs.writeFileSync(join(job.run_dir, "run-job.json"), JSON.stringify(updated));
    } else if (fault === "record-failed")
      fs.writeFileSync(
        join(job.run_dir, "run-record.json"),
        JSON.stringify({ ...run, status: "failed", exit_class: "cvode", exit_code: 19 }),
      );
    else if (fault === "null-stack" || fault === "null-data")
      fs.writeFileSync(
        join(job.run_dir, "run-record.json"),
        JSON.stringify({ ...run, [fault === "null-stack" ? "stack_id" : "data_id"]: null }),
      );
    else
      fs.writeFileSync(
        join(job.run_dir, "collect-error.json"),
        fault === "ledger-corrupt"
          ? "PRIVATE_LEDGER"
          : JSON.stringify({
              attempts: 3,
              last_error: "PRIVATE_LEDGER",
              at: "2026-10-22T03:16:00Z",
            }),
      );
    const before = await treeOrAbsent(h.cwd);
    const message = expectReportError(await h.invoke("report_generate", DRAFT), /closure|collect/u);
    expect(message).toContain(job.job_id);
    expect(message).not.toContain("PRIVATE_");
    expect(await treeOrAbsent(h.cwd)).toEqual(before);
  } finally {
    await h.dispose();
  }
});

test.each(["change", "patch", "verification"] as const)(
  "linked %s symlink cannot bypass readonly closure",
  async (kind) => {
    const h = await reportHarness();
    try {
      const { change, verification } = await seedCodeChangeEvidence(h);
      const path =
        kind === "change"
          ? join(h.cwd, "changes", `${change.change_id}.json`)
          : kind === "patch"
            ? join(h.cwd, change.patch_path)
            : join(h.cwd, "verifications", `${verification.vc_id}.json`);
      const outside = join(h.root, "outside-evidence");
      fs.renameSync(path, outside);
      installUnsafe(path, "symlink", outside);
      const before = await treeOrAbsent(h.root);
      expectReportError(await h.invoke("report_generate", DRAFT), /read_error/u);
      expect(await treeOrAbsent(h.root)).toEqual(before);
    } finally {
      await h.dispose();
    }
  },
);

test("unlinked malformed change and verification files are neither discovered nor read", async () => {
  const h = await reportHarness();
  try {
    await seedCodeChangeEvidence(h);
    fs.writeFileSync(join(h.cwd, "changes", "CHG-20261102T090000-ffff.json"), "PRIVATE_ORPHAN");
    fs.writeFileSync(
      join(h.cwd, "verifications", "VC-20261102T090000-ffff.json"),
      "PRIVATE_ORPHAN",
    );
    const physical = fs.realpathSync.native(h.cwd);
    vi.mocked(fs.readdirSync).mockClear();
    generated(h, await h.invoke("report_generate", DRAFT));
    expect(
      vi
        .mocked(fs.readdirSync)
        .mock.calls.some(([path]) =>
          [join(physical, "changes"), join(physical, "verifications")].includes(String(path)),
        ),
    ).toBe(false);
  } finally {
    await h.dispose();
  }
});

test("report generation does not add verification_run build, source-pin or thread constraints", async () => {
  const h = await reportHarness();
  try {
    const { runs } = await seedCodeChangeEvidence(h);
    putCard(h, { ...getCard(h), source_base_commit: "2222222222222222222222222222222222222222" });
    for (const { job, run } of runs) {
      const lineage = {
        threads: 4,
        binary_sha256: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      };
      fs.writeFileSync(
        join(job.run_dir, "run-job.json"),
        JSON.stringify(RunJobSchema.parse({ ...job, ...lineage })),
      );
      fs.writeFileSync(
        join(job.run_dir, "run-record.json"),
        JSON.stringify({ ...run, ...lineage }),
      );
    }
    const before = await treeOrAbsent(join(h.cwd, "runs"));
    expect(generated(h, await h.invoke("report_generate", DRAFT)).linked_runs).toEqual(
      runs.map(({ run }) => run.run_id),
    );
    expect(await treeOrAbsent(join(h.cwd, "runs"))).toEqual(before);
  } finally {
    await h.dispose();
  }
});

test.each(["change", "verification"] as const)(
  "embedded %s identity mismatch blocks generation",
  async (kind) => {
    const h = await reportHarness();
    try {
      const { change, verification } = await seedCodeChangeEvidence(h);
      const id = kind === "change" ? change.change_id : verification.vc_id;
      const path = join(h.cwd, kind === "change" ? "changes" : "verifications", `${id}.json`);
      const value =
        kind === "change"
          ? ChangeRequestSchema.parse({
              ...change,
              change_id: "CHG-20261102T090000-ffff",
              patch_path: "patches/CHG-20261102T090000-ffff.patch",
            })
          : VerificationCaseSchema.parse({ ...verification, vc_id: "VC-20261102T090000-ffff" });
      fs.writeFileSync(path, JSON.stringify(value));
      const before = await treeOrAbsent(h.cwd);
      expect(expectReportError(await h.invoke("report_generate", DRAFT), /read_error/u)).toContain(
        id,
      );
      expect(await treeOrAbsent(h.cwd)).toEqual(before);
    } finally {
      await h.dispose();
    }
  },
);

test("science_assist reports keep empty change references and do not read code-only card links", async () => {
  const h = await reportHarness();
  try {
    const { change, verification } = await seedCodeChangeEvidence(h);
    putCard(h, { ...getCard(h), type: "science_assist", source_base_commit: null });
    fs.writeFileSync(join(h.cwd, "changes", `${change.change_id}.json`), "PRIVATE_UNUSED_CHANGE");
    fs.writeFileSync(
      join(h.cwd, "verifications", `${verification.vc_id}.json`),
      "PRIVATE_UNUSED_VERIFICATION",
    );
    const report = generated(h, await h.invoke("report_generate", DRAFT));
    expect(report.change_ids).toEqual([]);
    expect(report.verification_ids).toEqual([]);
  } finally {
    await h.dispose();
  }
});

test.each(["change_ids", "verification_ids"] as const)(
  "model-supplied %s cannot replace fresh card evidence",
  async (field) => {
    const h = await reportHarness();
    try {
      await seedCodeChangeEvidence(h);
      const before = await treeOrAbsent(h.cwd);
      expectReportError(
        await h.invoke("report_generate", { ...DRAFT, [field]: [] }),
        new RegExp(field, "u"),
      );
      expect(await treeOrAbsent(h.cwd)).toEqual(before);
    } finally {
      await h.dispose();
    }
  },
);
