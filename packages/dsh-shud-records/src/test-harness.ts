import { execFileSync } from "node:child_process";
import * as fs from "node:fs";

export const taskCase = {
  kind: "task",
  id: "TASK-20261027T080005-3f9c",
  directory: "tasks",
  relative: "tasks/TASK-20261027T080005-3f9c/task.json",
  value: {
    task_id: "TASK-20261027T080005-3f9c",
    type: "science_assist",
    status: "planned",
    runtime_phase: null,
    title: "ccw evidence",
    question_or_goal: "Collect ccw run evidence",
    created_by: "coordinator",
    current_owner: "coordinator",
    reviewer: "PI",
    stack_id: null,
    data_id: null,
    inference_budget: { mode: "normal" },
    linked_jobs: [],
    linked_reports: [],
    created_at: "2026-10-27T08:00:05Z",
    updated_at: "2026-10-27T08:00:05Z",
  },
} as const;

export const stackCase = {
  kind: "stack",
  id: "STACK-20261027T080005-3f9c",
  directory: "stacks",
  relative: "stacks/STACK-20261027T080005-3f9c.json",
  value: {
    stack_id: "STACK-20261027T080005-3f9c",
    repos: {
      SHUD: {
        commit: "1111111111111111111111111111111111111111",
        branch: "main",
        dirty: false,
        dirty_paths: [],
        dirty_paths_truncated: false,
      },
      rSHUD: {
        commit: "2222222222222222222222222222222222222222",
        branch: "main",
        dirty: false,
        dirty_paths: [],
        dirty_paths_truncated: false,
      },
      AutoSHUD: {
        commit: "3333333333333333333333333333333333333333",
        branch: "main",
        dirty: false,
        dirty_paths: [],
        dirty_paths_truncated: false,
      },
    },
    runtime: { os: "Darwin 25.6.0", sundials_version: null, host_version: "0.2.1-rc.2" },
    harness: { version: "0.9.0" },
    llm: {
      base_url: "https://example.invalid",
      request_alias: "configured-model",
      response_model: "configured-model",
    },
    fingerprint: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    created_at: "2026-10-27T08:00:05Z",
  },
} as const;

const dataCase = {
  kind: "data",
  id: "DATA-20261027T080005-3f9c",
  directory: "provenance",
  relative: "provenance/DATA-20261027T080005-3f9c.json",
  value: {
    data_id: "DATA-20261027T080005-3f9c",
    basin: "ccw",
    event_window: { start: null, end: null },
    sources: {
      input_root: "/workspace/input/ccw",
      files: [{ path: "ccw.sp.mesh", sha256: "fixture-digest", size_bytes: 1024 }],
    },
    preprocess: null,
    uncertainty_notes: null,
  },
} as const;

export const reportCase = {
  kind: "report",
  id: "REPORT-20261027T080005-3f9c",
  directory: "reports",
  relative: "reports/REPORT-20261027T080005-3f9c.json",
  value: {
    report_id: "REPORT-20261027T080005-3f9c",
    task_id: "TASK-20261027T080005-1234",
    status: "draft",
    summary: "One ccw run produced artifacts.",
    observations: ["Output files exist."],
    limitations: ["Scientific metrics have not been collected."],
    pi_questions: ["Review these artifacts?"],
    linked_runs: ["RUN-20261027T080005-a1b2"],
    stack_ids: ["STACK-20261027T080005-b2c3"],
    data_ids: ["DATA-20261027T080005-c3d4"],
    llm_response_models: ["configured-model"],
    decision_history: [],
    created_at: "2026-10-27T08:00:05Z",
    updated_at: "2026-10-27T08:00:05Z",
  },
} as const;

export const mutableCases = [taskCase, dataCase, reportCase];
export const recordCases = [taskCase, stackCase, dataCase, reportCase];
export const unsafeKinds = ["symlink", "dangling-link", "file", "fifo"] as const;
export type UnsafeKind = (typeof unsafeKinds)[number] | "directory";

export function installUnsafe(path: string, kind: UnsafeKind, outside: string): void {
  if (kind === "symlink") fs.symlinkSync(outside, path);
  else if (kind === "dangling-link") fs.symlinkSync(`${outside}-missing`, path);
  else if (kind === "file") fs.writeFileSync(path, "original path bytes\n");
  else if (kind === "directory") fs.mkdirSync(path);
  else execFileSync("mkfifo", [path]);
}
