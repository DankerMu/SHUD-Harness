import { inspect } from "node:util";
import { expect, test, vi } from "vitest";
import {
  AnalysisPlanIdSchema,
  JobRecordIdSchema,
  MAX_COLLECT_ATTEMPTS,
  RunIdSchema,
  TaskIdSchema,
  type TaskCard,
} from "@shud-harness/dsh-shud-core";
import {
  deriveSensitivityClosure,
  evaluateClosure,
  type ClosureResult,
  type CodeChangeObjectLoaders,
  type SensitivityObjectLoaders,
} from "./index.ts";
import {
  evaluateSensitivity,
  sensitivityEvidence,
  sensitivityLoaders,
  type SensitivityEvidence,
} from "./sensitivity-closure-test-harness.ts";

const foreignPlan = AnalysisPlanIdSchema.parse("PLAN-20261108T093000-ffff");
const foreignTask = TaskIdSchema.parse("TASK-20261108T093000-ffff");

test("missing and mismatched reader capabilities fail closed without changing legacy results", () => {
  const input = sensitivityEvidence();
  const { loaders } = sensitivityLoaders(input);
  const oldLoaders = {
    readChange: () => undefined,
    readPatch: () => new Uint8Array(),
    readVerification: () => undefined,
  };
  for (const readers of [undefined, oldLoaders]) {
    const result = evaluateClosure(input.card, input.runJobs, input.records, input.draft, readers);
    expect(result).toMatchObject({
      ok: false,
      failures: [{ clause: 0, reason: "missing_sensitivity_loaders" }],
    });
  }
  expect(deriveSensitivityClosure(input.card, input.runJobs, input.records, input.draft)).toEqual({
    ok: false,
    failures: [{ clause: 0, reason: "missing_sensitivity_loaders" }],
  });
  const science = { ...input.card, type: "science_assist" as const, linked_analyses: [] };
  expect(evaluateClosure(science, input.runJobs, input.records, input.draft, loaders)).toEqual(
    evaluateClosure(science, input.runJobs, input.records, input.draft),
  );
  expect(
    evaluateClosure(
      { ...science, type: "code_change" },
      input.runJobs,
      input.records,
      input.draft,
      loaders,
    ),
  ).toMatchObject({ ok: false, failures: [{ reason: "missing_code_change_loaders" }] });
  expect(
    deriveSensitivityClosure(science, input.runJobs, input.records, input.draft, loaders),
  ).toMatchObject({ ok: false, failures: [{ clause: 0, reason: "invalid_sensitivity_card" }] });
});

test.each(["narrowed", "generic"] as const)(
  "dual-capability loaders erased to legacy reject a %s sensitivity card",
  (kind) => {
    const input = sensitivityEvidence();
    const { loaders, reads } = sensitivityLoaders(input);
    const legacy = {
      readChange: vi.fn(() => undefined),
      readPatch: vi.fn(() => new Uint8Array()),
      readVerification: vi.fn(() => undefined),
    };
    const dual = { ...legacy, ...loaders };
    // Deliberate untyped-boundary simulation; registered type tests reject safe erasure.
    const erased = dual as unknown as CodeChangeObjectLoaders;
    const genericCard: TaskCard = input.card;
    const result: ClosureResult =
      kind === "narrowed"
        ? evaluateClosure(input.card, input.runJobs, input.records, input.draft, erased)
        : evaluateClosure(genericCard, input.runJobs, input.records, input.draft, erased);
    expect(result).toMatchObject({ ok: false, failures: [{ clause: 0 }] });
    expect(result).not.toHaveProperty("selected");
    expect(reads).toEqual({ plans: [], metrics: [] });
    expect(legacy.readChange).not.toHaveBeenCalled();
    expect(legacy.readPatch).not.toHaveBeenCalled();
    expect(legacy.readVerification).not.toHaveBeenCalled();
  },
);

test("dual-capability loaders cannot enter the direct sensitivity predicate", () => {
  const input = sensitivityEvidence();
  const { loaders, reads } = sensitivityLoaders(input);
  const dual = {
    ...loaders,
    readChange: vi.fn(() => undefined),
    readPatch: vi.fn(() => new Uint8Array()),
    readVerification: vi.fn(() => undefined),
  };
  // JavaScript callers can bypass mutually exclusive types; the guard must still reject.
  const unsafe = dual as unknown as SensitivityObjectLoaders;
  const result = deriveSensitivityClosure(
    input.card,
    input.runJobs,
    input.records,
    input.draft,
    unsafe,
  );
  expect(result).toMatchObject({ ok: false, failures: [{ clause: 0 }] });
  expect(result).not.toHaveProperty("selected");
  expect(reads).toEqual({ plans: [], metrics: [] });
  expect(dual.readChange).not.toHaveBeenCalled();
  expect(dual.readPatch).not.toHaveBeenCalled();
  expect(dual.readVerification).not.toHaveBeenCalled();
});

test("dual-capability loaders are rejected before code-change readers run", () => {
  const input = sensitivityEvidence();
  const { loaders, reads } = sensitivityLoaders(input);
  const dual = {
    ...loaders,
    readChange: vi.fn(() => undefined),
    readPatch: vi.fn(() => new Uint8Array()),
    readVerification: vi.fn(() => undefined),
  };
  const unsafe = dual as unknown as CodeChangeObjectLoaders;
  const result = evaluateClosure(
    { ...input.card, type: "code_change" },
    input.runJobs,
    input.records,
    input.draft,
    unsafe,
  );
  expect(result).toMatchObject({
    ok: false,
    failures: [{ reason: "missing_code_change_loaders" }],
  });
  expect(reads).toEqual({ plans: [], metrics: [] });
  expect(dual.readChange).not.toHaveBeenCalled();
  expect(dual.readPatch).not.toHaveBeenCalled();
  expect(dual.readVerification).not.toHaveBeenCalled();
});

test.each([
  [
    "no link",
    (input: SensitivityEvidence) => {
      input.card.linked_analyses = [];
    },
  ],
  [
    "two links",
    (input: SensitivityEvidence) => {
      input.card.linked_analyses.push(foreignPlan);
    },
  ],
  [
    "invalid link",
    (input: SensitivityEvidence) => {
      Object.assign(input.card, { linked_analyses: ["private-sensitivity-id"] });
    },
  ],
  [
    "invalid task",
    (input: SensitivityEvidence) => {
      Object.assign(input.card, { task_id: "private-sensitivity-task" });
    },
  ],
] as const)("clause zero rejects %s before reading a plan", (_name, change) => {
  const input = sensitivityEvidence();
  change(input);
  const { loaders, reads } = sensitivityLoaders(input);
  const result = evaluateSensitivity(input, loaders);
  expect(result).toMatchObject({ ok: false, failures: [{ clause: 0 }] });
  expect(reads).toEqual({ plans: [], metrics: [] });
  expect(inspect(result)).not.toContain("private-sensitivity");
});

test.each([
  [
    "schema",
    (input: SensitivityEvidence) => ({ ...input.plan, mode: "private-sensitivity-schema" }),
  ],
  ["identity", (input: SensitivityEvidence) => ({ ...input.plan, analysis_plan_id: foreignPlan })],
  ["task", (input: SensitivityEvidence) => ({ ...input.plan, task_id: foreignTask })],
  [
    "exception",
    () => {
      throw new Error("private-sensitivity-native-error");
    },
  ],
] as const)("clause zero rejects plan %s with only linked validated identity", (_name, read) => {
  const input = sensitivityEvidence();
  const { loaders, reads } = sensitivityLoaders(input);
  loaders.readAnalysisPlan = () => read(input);
  const result = evaluateSensitivity(input, loaders);
  expect(result).toMatchObject({
    ok: false,
    failures: [{ clause: 0, analysis_plan_id: input.plan.analysis_plan_id }],
  });
  expect(reads.metrics).toEqual([]);
  expect(inspect(result)).not.toContain("private-sensitivity");
  expect(inspect(result)).not.toContain(foreignPlan);
  expect(inspect(result)).not.toContain(foreignTask);
});

test.each(["observations", "limitations", "pi_questions"] as const)(
  "clause zero counts only supplied %s entries",
  (field) => {
    const input = sensitivityEvidence();
    input.draft[field] = [];
    expect(evaluateSensitivity(input)).toMatchObject({
      ok: false,
      failures: [{ clause: 0, reason: `missing_${field}` }],
    });
  },
);

test("clause zero requires a nonempty linked job set", () => {
  const input = sensitivityEvidence();
  input.card.linked_jobs = [];
  expect(evaluateSensitivity(input)).toMatchObject({
    ok: false,
    failures: [{ clause: 0, reason: "no_linked_jobs" }],
  });
});

test.each([
  [
    "missing job",
    (input: SensitivityEvidence) => {
      input.runJobs.shift();
    },
  ],
  [
    "duplicate job",
    (input: SensitivityEvidence) => {
      input.runJobs.push(input.runJobs[0]);
    },
  ],
  [
    "duplicate link",
    (input: SensitivityEvidence) => {
      input.card.linked_jobs.push(input.card.linked_jobs[0]);
    },
  ],
  [
    "foreign task",
    (input: SensitivityEvidence) => {
      input.runJobs[0].job.task_id = foreignTask;
    },
  ],
  [
    "foreign plan",
    (input: SensitivityEvidence) => {
      input.runJobs[0].job.analysis_plan_id = foreignPlan;
    },
  ],
  [
    "unknown pset",
    (input: SensitivityEvidence) => {
      input.runJobs[0].job.parameter_set_id = "PSET-5";
    },
  ],
  [
    "unbound job",
    (input: SensitivityEvidence) => {
      Object.assign(input.runJobs[0].job, { analysis_plan_id: null, parameter_set_id: null });
    },
  ],
  [
    "malformed run id",
    (input: SensitivityEvidence) => {
      Object.assign(input.runJobs[0].job, { run_id: "private-sensitivity-run" });
    },
  ],
  [
    "missing record",
    (input: SensitivityEvidence) => {
      input.records.shift();
    },
  ],
  [
    "ambiguous record",
    (input: SensitivityEvidence) => {
      input.records.push(input.records[0]);
    },
  ],
  [
    "record foreign task",
    (input: SensitivityEvidence) => {
      input.records[0].task_id = foreignTask;
    },
  ],
  [
    "record foreign plan",
    (input: SensitivityEvidence) => {
      input.records[0].analysis_plan_id = foreignPlan;
    },
  ],
  [
    "record wrong pset",
    (input: SensitivityEvidence) => {
      input.records[0].parameter_set_id = "PSET-2";
    },
  ],
  [
    "record wrong job",
    (input: SensitivityEvidence) => {
      input.records[0].job_id = JobRecordIdSchema.parse("JOB-20261108T093000-ffff");
    },
  ],
  [
    "record wrong run",
    (input: SensitivityEvidence) => {
      input.records[0].run_id = RunIdSchema.parse("RUN-20261108T093000-ffff");
    },
  ],
  [
    "record malformed identity",
    (input: SensitivityEvidence) => {
      Object.assign(input.records[0], { run_id: "private-sensitivity-record" });
    },
  ],
] as const)("clause one rejects %s without borrowing other cell evidence", (_name, change) => {
  const input = sensitivityEvidence();
  change(input);
  const result = evaluateSensitivity(input);
  expect(result).toMatchObject({
    ok: false,
    failures: [{ clause: 1, job_id: "JOB-20261108T093000-0001" }],
  });
  expect(inspect(result, { depth: null })).not.toContain("private-sensitivity");
});

test("invalid linked job ids are not echoed or used for reads", () => {
  const input = sensitivityEvidence();
  Object.assign(input.card, { linked_jobs: ["private-sensitivity-job"] });
  const result = evaluateSensitivity(input);
  expect(result).toMatchObject({
    ok: false,
    failures: [{ clause: 1, reason: "invalid_job_link" }],
  });
  expect(inspect(result)).not.toContain("private-sensitivity");
});

test.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
  "invalid collection attempts %s fail clause one",
  (attempts) => {
    const input = sensitivityEvidence();
    input.runJobs[0].collect_error_attempts = attempts;
    expect(evaluateSensitivity(input)).toMatchObject({
      ok: false,
      failures: [{ clause: 1, reason: "invalid_collect_attempts" }],
    });
  },
);

test.each(["created", "submitted", "running", "succeeded"] as const)(
  "active %s evidence is not terminal before collection exhaustion",
  (status) => {
    const input = sensitivityEvidence();
    input.runJobs[0].job.status = status;
    input.runJobs[0].collect_error_attempts = MAX_COLLECT_ATTEMPTS - 1;
    expect(evaluateSensitivity(input)).toMatchObject({
      ok: false,
      failures: [{ clause: 1, reason: "job_not_terminal" }],
    });
  },
);

test("unlinked invalid evidence neither supplies coverage nor vetoes closure", () => {
  const input = sensitivityEvidence();
  input.runJobs.push({
    job: {
      ...input.runJobs[0].job,
      job_id: JobRecordIdSchema.parse("JOB-20261108T093000-eeee"),
      run_id: RunIdSchema.parse("RUN-20261108T093000-eeee"),
      task_id: null,
      status: "running",
    },
    collect_error_attempts: NaN,
  });
  input.records.push({
    ...input.records[0],
    job_id: JobRecordIdSchema.parse("JOB-20261108T093000-dddd"),
    run_id: RunIdSchema.parse("RUN-20261108T093000-dddd"),
    task_id: null,
  });
  expect(evaluateSensitivity(input).ok).toBe(true);
});

test("an unlinked record repeating a selected run id is ignored", () => {
  const input = sensitivityEvidence();
  input.records.push({
    ...input.records[0],
    job_id: JobRecordIdSchema.parse("JOB-20261108T093000-ffff"),
    task_id: null,
  });
  expect(evaluateSensitivity(input).ok).toBe(true);
});

test("two linked jobs cannot claim the same run identity", () => {
  const input = sensitivityEvidence();
  input.runJobs[1].job.run_id = input.runJobs[0].job.run_id;
  input.records[1].run_id = input.records[0].run_id;
  expect(evaluateSensitivity(input)).toMatchObject({
    ok: false,
    failures: [{ clause: 1, reason: "ambiguous_job", job_id: "JOB-20261108T093000-0002" }],
  });
});

test("dual-capability intersection rejects a generic sensitivity card before loading evidence", () => {
  const input = sensitivityEvidence();
  const { loaders, reads } = sensitivityLoaders(input);
  const dual = {
    ...loaders,
    readChange: vi.fn(() => undefined),
    readPatch: vi.fn(() => new Uint8Array()),
    readVerification: vi.fn(() => undefined),
  };
  const genericCard: TaskCard = input.card;
  // An impossible intersection can still arrive from an untyped JavaScript boundary.
  const unsafe = dual as unknown as CodeChangeObjectLoaders & SensitivityObjectLoaders;
  const result = evaluateClosure(genericCard, input.runJobs, input.records, input.draft, unsafe);
  expect(result).toMatchObject({ ok: false, failures: [{ clause: 0 }] });
  expect(result).not.toHaveProperty("selected");
  expect(reads).toEqual({ plans: [], metrics: [] });
  expect(dual.readChange).not.toHaveBeenCalled();
  expect(dual.readPatch).not.toHaveBeenCalled();
  expect(dual.readVerification).not.toHaveBeenCalled();
});

test.each(["readChange", "readPatch", "readVerification"] as const)(
  "a sensitivity loader with opposing %s capability is not an exclusive family",
  (method) => {
    const input = sensitivityEvidence();
    const { loaders, reads } = sensitivityLoaders(input);
    const opposing = vi.fn(() => undefined);
    const unsafe = { ...loaders, [method]: opposing };
    const facade = evaluateClosure(input.card, input.runJobs, input.records, input.draft, unsafe);
    const direct = deriveSensitivityClosure(
      input.card,
      input.runJobs,
      input.records,
      input.draft,
      unsafe,
    );
    expect(facade).toMatchObject({ ok: false, failures: [{ clause: 0 }] });
    expect(direct).toMatchObject({ ok: false, failures: [{ clause: 0 }] });
    expect(reads).toEqual({ plans: [], metrics: [] });
    expect(opposing).not.toHaveBeenCalled();
  },
);

test("undefined optional exclusions do not create conflicting loader capabilities", () => {
  const input = sensitivityEvidence();
  const { loaders } = sensitivityLoaders(input);
  const exclusive: SensitivityObjectLoaders = {
    ...loaders,
    readChange: undefined,
    readPatch: undefined,
    readVerification: undefined,
  };
  expect(evaluateSensitivity(input, exclusive).ok).toBe(true);
});
