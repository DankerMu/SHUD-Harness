import * as io from "node:fs/promises";
import { join } from "node:path";
import { JobRecordIdSchema, VerificationIdSchema } from "@shud-harness/dsh-shud-core";
import { readWorkspaceRecord, writeWorkspaceRecord } from "@shud-harness/dsh-shud-records";
import { expect, test, vi } from "vitest";
import { barrier } from "../../dsh-shud-jobs/src/state-indexes/test-harness.ts";
import {
  enteredBeforeCompletion,
  snapshotQueryTree,
} from "../../dsh-shud-jobs/src/list-run-jobs/test-harness.ts";
import { resultValue } from "./report-workflow/test-harness.ts";
import { expectToolError } from "./task-linked/test-harness.ts";
import { OTHER_COMMIT, SIDES } from "./verification-run/matrix/test-harness.ts";
import { PRIOR_VERIFICATION, verificationHarness } from "./verification-run/test-harness.ts";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof io>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
const native = await vi.importActual<typeof io>("node:fs/promises");

for (const side of SIDES) {
  test.each(["status", "type", "pin", "links", "unrelated"] as const)(
    `current card ${side} readonly await preserves or rejects changed %s`,
    async (change) => {
      const h = await verificationHarness();
      const entered = barrier();
      const release = barrier();
      const pending: Promise<unknown>[] = [];
      try {
        const target = join(h[side].job.run_dir, "run-record.json");
        let held = false;
        vi.mocked(io.readFile).mockImplementation(async (...args) => {
          const bytes = await native.readFile(...args);
          if (args[0] === target && !held) {
            held = true;
            entered.release();
            await release.waiting;
          }
          return bytes;
        });
        const call = h.invoke();
        pending.push(call);
        await enteredBeforeCompletion(entered.waiting, call);
        const current = {
          ...h.card,
          ...(change === "status" ? { status: "parked" as const } : {}),
          ...(change === "type" ? { type: "engineering" as const, source_base_commit: null } : {}),
          ...(change === "pin" ? { source_base_commit: OTHER_COMMIT } : {}),
          ...(change === "links"
            ? { linked_jobs: h.card.linked_jobs.filter((id) => id !== h[side].job.job_id) }
            : {}),
          ...(change === "unrelated"
            ? {
                title: "Concurrent authored title must survive",
                current_owner: "concurrent-owner",
                runtime_phase: "waiting_for_job" as const,
                linked_jobs: [
                  ...h.card.linked_jobs,
                  JobRecordIdSchema.parse("JOB-20261102T090000-eeee"),
                ],
                theory_bundle_ids: ["concurrent-theory"],
              }
            : {}),
        };
        writeWorkspaceRecord(h.cwd, "task", current);
        h.current.preset = "concurrent-reviewer";
        const before = await snapshotQueryTree(h.root);
        const evidence = await h.evidenceSnapshot();
        release.release();
        if (change === "unrelated") {
          const id = VerificationIdSchema.parse(resultValue(await call).vc_id);
          const card = readWorkspaceRecord(h.cwd, "task", h.card.task_id, { readonly: true });
          expect(card).toEqual({
            ...current,
            linked_verifications: [PRIOR_VERIFICATION, id].sort(),
            updated_at: card.updated_at,
          });
          expect(
            readWorkspaceRecord(h.cwd, "verification", id, { readonly: true }).reviewed_by,
          ).toBe("concurrent-reviewer");
          expect(await h.evidenceSnapshot()).toEqual(evidence);
        } else {
          expectToolError(await call, /running|code_change|pin|commit|linked_jobs/iu);
          expect(await snapshotQueryTree(h.root)).toEqual(before);
        }
      } finally {
        release.release();
        await Promise.allSettled(pending);
        vi.mocked(io.readFile).mockImplementation(native.readFile);
        await h.dispose();
      }
    },
  );
}
