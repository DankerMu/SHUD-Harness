import {
  TaskCardSchema,
  RunJobSchema,
  RunRecordSchema,
  type TaskCard,
  type RunJob,
  type RunRecord,
} from "@shud-harness/dsh-shud-core";
import { taskCase } from "./test-harness.ts";

export function makeTaskCard(overrides: Partial<TaskCard> = {}): TaskCard {
  return TaskCardSchema.parse({
    ...taskCase.value,
    runtime_phase: "waiting_for_job",
    title: "private-task-text-439",
    question_or_goal: "Keep authored goals unchanged",
    current_owner: "worker",
    reviewer: "pi",
    stack_id: "STACK-20261027T080005-a001",
    data_id: "DATA-20261027T080005-b002",
    inference_budget: {
      mode: "deep",
      advisory_usd: 4.5,
      advisory_model_calls: 7,
      reviewer_enabled: true,
    },
    linked_jobs: ["JOB-20261027T080005-c003", "JOB-20261027T080006-c004"],
    linked_reports: ["REPORT-20261027T080005-d005"],
    theory_bundle_ids: ["theory-water-balance", "theory-routing"],
    ...overrides,
  });
}

export function freezeTaskCard(card: TaskCard): TaskCard {
  Object.freeze(card.inference_budget);
  Object.freeze(card.linked_jobs);
  Object.freeze(card.linked_reports);
  if (card.theory_bundle_ids !== undefined) Object.freeze(card.theory_bundle_ids);
  return Object.freeze(card);
}

export function makeRunJob(
  jobId = "JOB-20261027T080005-0001",
  overrides: Partial<RunJob> = {},
): RunJob {
  return RunJobSchema.parse({
    job_id: jobId,
    run_id: `RUN-${jobId.slice(4)}`,
    task_id: taskCase.id,
    stack_id: "STACK-20261027T080005-0001",
    data_id: "DATA-20261027T080005-0001",
    backend: "local_job",
    status: "collected",
    project: "ccw",
    label: null,
    input_dir: "/workspace/input/ccw",
    run_dir: `/workspace/runs/RUN-${jobId.slice(4)}`,
    command: ["shud", "ccw"],
    end_days: 30,
    owner_session: "session-439",
    dsh_job_id: null,
    dsh_job_ids: [],
    pid: 439,
    pid_started_at: "2026-10-27T08:00:05Z",
    input_bytes: 1024,
    submitted_at: "2026-10-27T08:00:05Z",
    started_at: "2026-10-27T08:00:05Z",
    finished_at: "2026-10-27T08:01:05Z",
    cancel_requested_at: null,
    exit_code: 0,
    llm: { response_model: "fixture-model", response_model_source: "configured" },
    notify: { status: "delivered", attempts: 1, at: "2026-10-27T08:01:06Z", detail: null },
    ...overrides,
  });
}

export function freezeRunJob(job: RunJob): RunJob {
  Object.freeze(job.command);
  Object.freeze(job.dsh_job_ids);
  Object.freeze(job.llm);
  Object.freeze(job.notify);
  return Object.freeze(job);
}

export function makeRunRecord(job: RunJob, overrides: Partial<RunRecord> = {}): RunRecord {
  return RunRecordSchema.parse({
    run_id: job.run_id,
    job_id: job.job_id,
    task_id: job.task_id,
    stack_id: job.stack_id,
    data_id: job.data_id,
    status: "succeeded",
    command: ["shud", "ccw"],
    exit_code: 0,
    exit_class: "ok",
    artifacts: {
      stdout: "stdout.log",
      stderr: "stderr.log",
      shud_output: "output",
      files: [{ path: "output/flow.dat", size_bytes: 128 }],
    },
    numerical_health: {
      water_balance_residual: null,
      cvode_failures: null,
      negative_state_count: null,
      max_solver_dt: null,
    },
    resources: { wall_seconds: null, peak_memory_mb: null },
    llm: { response_model: "fixture-model", response_model_source: "configured" },
    collected_at: "2026-10-27T08:01:05Z",
    ...overrides,
  });
}

export function freezeRunRecord(record: RunRecord): RunRecord {
  Object.freeze(record.command);
  record.artifacts.files.forEach(Object.freeze);
  Object.freeze(record.artifacts.files);
  Object.freeze(record.artifacts);
  Object.freeze(record.numerical_health);
  Object.freeze(record.resources);
  Object.freeze(record.llm);
  return Object.freeze(record);
}
