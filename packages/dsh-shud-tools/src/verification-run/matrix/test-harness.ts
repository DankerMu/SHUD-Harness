import * as fs from "node:fs";
import { join } from "node:path";
import type { ToolExecutionResult } from "@deepseek-ai/dsh-tools";
import type {
  BuildRecord,
  ChangeRequest,
  DataProvenance,
  RunJob,
  RunRecord,
  TaskCard,
} from "@shud-harness/dsh-shud-core";
import { expect } from "vitest";
import { snapshotQueryTree } from "../../../../dsh-shud-jobs/src/list-run-jobs/test-harness.ts";
import { expectToolError } from "../../task-linked/test-harness.ts";
import { REVIEWER_NOTES } from "../test-harness.ts";

export const PRIVATE = "PRIVATE_VERIFICATION_IO_540";
export const OTHER_TASK = "TASK-20261102T090000-ffff";
export const OTHER_COMMIT = "2222222222222222222222222222222222222222";
export const THIRD_COMMIT = "3333333333333333333333333333333333333333";
export const OTHER_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
export const SIDES = ["base", "candidate"] as const;
interface VerificationRunFixture {
  job: RunJob;
  run: RunRecord;
  build: BuildRecord;
  data: DataProvenance;
}
export interface VerificationFixture {
  cwd: string;
  root: string;
  card: TaskCard;
  change: ChangeRequest;
  base: VerificationRunFixture;
  candidate: VerificationRunFixture;
  invoke(args?: unknown): Promise<ToolExecutionResult>;
}
export function verificationArgs(h: VerificationFixture) {
  return {
    task_id: h.card.task_id,
    base_run_id: h.base.job.run_id,
    candidate_run_id: h.candidate.job.run_id,
    reviewer_notes: [...REVIEWER_NOTES],
    compatibility_verdict: "compatible",
  };
}
export function fixturePaths(h: VerificationFixture, side: "base" | "candidate") {
  const run = h[side];
  return {
    job: join(run.job.run_dir, "run-job.json"),
    run: join(run.job.run_dir, "run-record.json"),
    build: join(h.cwd, "builds", run.build.build_id, "build-record.json"),
    data: join(h.cwd, "provenance", `${run.data.data_id}.json`),
    task: join(h.cwd, "tasks", h.card.task_id, "task.json"),
    change: join(h.cwd, "changes", `${h.change.change_id}.json`),
  };
}
// Test fixture mutation only: immutable records are never passed to the mutable production writer.
export function putFixture(path: string, value: unknown) {
  fs.writeFileSync(path, `${JSON.stringify(value)}\n`);
}
export async function rejectedUnchanged(
  h: VerificationFixture,
  args: unknown = verificationArgs(h),
  message: RegExp = /./su,
) {
  const before = await snapshotQueryTree(h.root);
  const error = expectToolError(await h.invoke(args), message);
  expect(error).not.toContain(PRIVATE);
  expect(await snapshotQueryTree(h.root)).toEqual(before);
  return error;
}
