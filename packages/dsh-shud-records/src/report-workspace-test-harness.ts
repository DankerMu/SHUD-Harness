import {
  DataProvenanceSchema,
  StackLockSchema,
  type RunRecord,
  type EvidenceReport,
  type StackLock,
  type DataProvenance,
} from "@shud-harness/dsh-shud-core";
import { makeEvidenceReport } from "./report-render-test-harness.ts";
import { makeRunJob, makeRunRecord } from "./task-lifecycle-test-harness.ts";
import { stackCase } from "./test-harness.ts";

export interface RenderingFixture {
  report: EvidenceReport;
  stacks: readonly [StackLock, StackLock];
  data: readonly [DataProvenance, DataProvenance];
  runs: readonly [RunRecord, RunRecord];
}

/** Fixed inputs for the independently authored report-render.golden.md; no expected renderer logic. */
export function makeRenderingFixture(): RenderingFixture {
  const firstStack = StackLockSchema.parse({
    ...stackCase.value,
    stack_id: "STACK-20261029T080000-b002",
    repos: {
      ...stackCase.value.repos,
      SHUD: {
        commit: "1111111111111111111111111111111111111111",
        branch: "topic|`edge`\n## injected",
        dirty: true,
        dirty_paths: ["src/a.cpp", "src/z.cpp"],
        dirty_paths_truncated: true,
      },
    },
    llm: {
      base_url: "https://first.invalid/?a=1&b=2",
      request_alias: "first-alias",
      response_model: "first-stack-model",
    },
  });
  const secondStack = StackLockSchema.parse({
    ...stackCase.value,
    stack_id: "STACK-20261029T080000-a001",
    llm: {
      base_url: "https://second.invalid",
      request_alias: "second-alias",
      response_model: "second-stack-model",
    },
  });
  const firstData = DataProvenanceSchema.parse({
    data_id: "DATA-20261029T080000-b002",
    basin: "ccw",
    event_window: { start: null, end: null },
    sources: {
      input_root: "/not-opened/input&<ccw>",
      files: [{ path: "ccw.mesh", sha256: "first-digest", size_bytes: 17 }],
    },
    preprocess: null,
    uncertainty_notes: null,
  });
  const secondData = DataProvenanceSchema.parse({
    data_id: "DATA-20261029T080000-a001",
    basin: "ccw-failed",
    event_window: { start: "2026-01-01", end: "2026-01-02" },
    sources: {
      input_root: "/not-opened/failed-input",
      files: [{ path: "failed.mesh", sha256: "second-digest", size_bytes: 9 }],
    },
    preprocess: null,
    uncertainty_notes: null,
  });
  const report = makeEvidenceReport({
    summary: "  Authored summary\n{{facts}} stays authored.  ",
    observations: ["First observation\n{{summary}} stays authored.", "Second observation."],
    limitations: ["No scientific metrics measured.\nDo not infer model improvement."],
    pi_questions: ["Review this evidence?\n{{header}} stays authored."],
    stack_ids: [firstStack.stack_id, secondStack.stack_id],
    data_ids: [firstData.data_id, secondData.data_id],
    llm_response_models: ["run-model-b", "run-model-a"],
  });
  const firstRun = makeRunRecord(makeRunJob("JOB-20261029T080000-b002"), {
    task_id: report.task_id,
    stack_id: firstStack.stack_id,
    data_id: firstData.data_id,
    command: ["shud", "ccw", "--label", "{{summary}}|`x`\r\nnext\\end"],
    artifacts: {
      stdout: "stdout.log",
      stderr: "stderr.log",
      shud_output: "output",
      files: [
        { path: "output/z.dat", size_bytes: 9007199254740991 },
        { path: "output/a.dat", size_bytes: 2 },
      ],
    },
    resources: { wall_seconds: 12.5, peak_memory_mb: null },
    llm: { response_model: "run-model-b", response_model_source: "response" },
  });
  const secondRun = makeRunRecord(makeRunJob("JOB-20261029T080000-a001"), {
    task_id: report.task_id,
    stack_id: secondStack.stack_id,
    data_id: secondData.data_id,
    status: "failed",
    exit_code: 19,
    exit_class: "cvode",
    command: ["shud", "ccw-failed"],
    artifacts: {
      stdout: "stdout.log",
      stderr: "stderr.log",
      shud_output: "output",
      files: [{ path: "output/failure.dat", size_bytes: 7 }],
    },
    llm: { response_model: "run-model-a", response_model_source: "configured" },
  });
  return {
    report: makeEvidenceReport({ ...report, linked_runs: [firstRun.run_id, secondRun.run_id] }),
    stacks: [firstStack, secondStack] as const,
    data: [firstData, secondData] as const,
    runs: [firstRun, secondRun] as const,
  };
}

export function runRelativePath(run: RunRecord): string {
  return `runs/${run.run_id}/run-record.json`;
}

export function renderingInputs(fixture: RenderingFixture) {
  return [
    { kind: "report", path: `reports/${fixture.report.report_id}.json`, value: fixture.report },
    ...fixture.stacks.map((value) => ({
      kind: "stack",
      path: `stacks/${value.stack_id}.json`,
      value,
    })),
    ...fixture.data.map((value) => ({
      kind: "data",
      path: `provenance/${value.data_id}.json`,
      value,
    })),
    ...fixture.runs.map((value) => ({ kind: "run", path: runRelativePath(value), value })),
  ];
}
