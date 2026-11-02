import { describe, expect, test } from "vitest";
import { RunJobSchema, RunRecordSchema } from "../index.ts";

const BUILD_ID = "BUILD-20261102T080000-3f9c";
const BINARY_SHA256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const runSchemas = [
  {
    name: "RunJob",
    schema: RunJobSchema,
    legacy: validRunJob,
    statuses: [
      { status: "created" },
      { status: "submitted" },
      { status: "running", pid: 42, pid_started_at: "2026-10-22T03:15:00Z" },
      { status: "succeeded" },
      { status: "failed" },
      { status: "cancelled" },
      { status: "collected" },
    ],
  },
  {
    name: "RunRecord",
    schema: RunRecordSchema,
    legacy: validRunRecord,
    statuses: [
      { status: "succeeded", exit_code: 0, exit_class: "ok" },
      { status: "failed", exit_code: 10, exit_class: "nan" },
    ],
  },
] as const;

describe.each(runSchemas)("$name build fields", ({ schema, legacy, statuses }) => {
  test("defaults missing build fields to null without changing legacy input or fields", () => {
    const input = legacy();
    const original = structuredClone(input);
    const parsed = schema.parse(input);
    expect(parsed).toEqual({ ...original, build_id: null, threads: null, binary_sha256: null });
    expect(input).toEqual(original);
    for (const field of ["build_id", "threads", "binary_sha256"]) {
      expect(Object.hasOwn(input, field)).toBe(false);
    }
  });

  test.each([
    { build_id: null, threads: null, binary_sha256: null },
    { build_id: BUILD_ID, threads: 1, binary_sha256: BINARY_SHA256 },
    { build_id: BUILD_ID, threads: null, binary_sha256: BINARY_SHA256 },
    { build_id: null, threads: 1, binary_sha256: null },
  ])("accepts independent thread annotation %j", (fields) => {
    const input = { ...legacy(), ...fields };
    expect(schema.parse(input)).toEqual(input);
  });

  test.each([
    { build_id: null },
    { binary_sha256: null },
    { threads: 1 },
    { build_id: BUILD_ID, binary_sha256: BINARY_SHA256 },
  ])("defaults individually omitted fields in %j", (fields) => {
    const input = { ...legacy(), ...fields };
    expect(schema.parse(input)).toEqual({
      ...input,
      build_id: null,
      threads: null,
      binary_sha256: null,
      ...fields,
    });
  });

  describe.each(statuses)("status $status", (statusFields) => {
    test.each([
      { build_id: null, binary_sha256: null },
      { build_id: BUILD_ID, binary_sha256: BINARY_SHA256 },
    ])("accepts matched build identity and digest %j", (fields) => {
      const input = { ...legacy(), ...statusFields, ...fields, threads: null };
      expect(schema.parse(input)).toEqual(input);
    });

    test.each([
      { build_id: BUILD_ID, binary_sha256: null },
      { build_id: null, binary_sha256: BINARY_SHA256 },
      { build_id: BUILD_ID },
      { binary_sha256: BINARY_SHA256 },
    ])("rejects unmatched build identity and digest at binary_sha256: %j", (fields) => {
      const result = schema.safeParse({ ...legacy(), ...statusFields, ...fields });
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.path.join("."))).toEqual(["binary_sha256"]);
    });
  });

  test.each([0, -1, 1.5, "1"])("rejects invalid threads %j at threads", (threads) => {
    const result = schema.safeParse({ ...legacy(), threads });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toContain("threads");
  });

  test.each(["BUILD-0001", "BUILD-20261102T080000-3F9C", "RUN-20261102T080000-3f9c"])(
    "rejects invalid build id %s at build_id",
    (build_id) => {
      const result = schema.safeParse({ ...legacy(), build_id, binary_sha256: BINARY_SHA256 });
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.path.join("."))).toContain("build_id");
    },
  );

  test.each([
    "0123456789abcdef",
    "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF",
    "g123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  ])("rejects invalid digest %s at binary_sha256", (binary_sha256) => {
    const result = schema.safeParse({ ...legacy(), build_id: BUILD_ID, binary_sha256 });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toContain("binary_sha256");
  });

  test("preserves existing unbranded nullable reference acceptance", () => {
    const input = {
      ...legacy(),
      task_id: "TASK-0001",
      stack_id: "STACK-0001",
      data_id: "DATA-0001",
      build_id: BUILD_ID,
      threads: null,
      binary_sha256: BINARY_SHA256,
    };
    expect(schema.parse(input)).toEqual(input);
  });
});

describe("build fields preserve existing state guards", () => {
  test.each(["pid", "pid_started_at"] as const)("running still requires %s", (field) => {
    const result = RunJobSchema.safeParse({
      ...validRunJob(),
      status: "running",
      pid: 42,
      pid_started_at: "2026-10-22T03:15:00Z",
      build_id: BUILD_ID,
      binary_sha256: BINARY_SHA256,
      [field]: null,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toEqual([field]);
  });

  test.each([
    { status: "succeeded", exit_code: 10, exit_class: "ok", field: "exit_class" },
    { status: "failed", exit_code: 0, exit_class: "ok", field: "status" },
    { status: "succeeded", exit_code: null, exit_class: "ok", field: "exit_class" },
  ])("retains exit consistency for $status/$exit_code/$exit_class", ({ field, ...exitFields }) => {
    const result = RunRecordSchema.safeParse({
      ...validRunRecord(),
      ...exitFields,
      build_id: BUILD_ID,
      binary_sha256: BINARY_SHA256,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toEqual([field]);
  });
});

function validRunJob() {
  return {
    job_id: "JOB-20261022T031500-a1b2",
    run_id: "RUN-20261022T031500-a1b2",
    task_id: null,
    stack_id: null,
    data_id: null,
    backend: "local_job",
    status: "submitted",
    project: "ccw",
    label: null,
    input_dir: "/models/input/ccw",
    run_dir: "/workspace/runs/RUN-20261022T031500-a1b2",
    command: ["/usr/local/bin/shud", "ccw"],
    end_days: null,
    owner_session: null,
    dsh_job_id: null,
    dsh_job_ids: [],
    pid: null,
    pid_started_at: null,
    input_bytes: 1024,
    submitted_at: "2026-10-22T03:15:00Z",
    started_at: null,
    finished_at: null,
    cancel_requested_at: null,
    exit_code: null,
    llm: { response_model: "deepseek-chat", response_model_source: "response" },
    notify: { status: "pending", attempts: 0, at: null, detail: null },
  };
}

function validRunRecord() {
  return {
    run_id: "RUN-20261022T031500-a1b2",
    job_id: "JOB-20261022T031500-a1b2",
    task_id: null,
    stack_id: null,
    data_id: null,
    status: "succeeded",
    command: ["/usr/local/bin/shud", "ccw"],
    exit_code: 0,
    exit_class: "ok",
    artifacts: {
      stdout: "/runs/example/stdout.log",
      stderr: "/runs/example/stderr.log",
      shud_output: "/runs/example/output/ccw.out",
      files: [{ path: "flow.dat", size_bytes: 0 }],
    },
    numerical_health: {
      water_balance_residual: null,
      cvode_failures: null,
      negative_state_count: null,
      max_solver_dt: null,
    },
    resources: { wall_seconds: null, peak_memory_mb: null },
    llm: { response_model: "deepseek-chat", response_model_source: "response" },
    collected_at: "2026-10-22T03:16:00Z",
  };
}
