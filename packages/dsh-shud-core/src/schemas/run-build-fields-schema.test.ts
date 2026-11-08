import { describe, expect, test } from "vitest";
import { RunJobSchema, RunRecordSchema } from "../index.ts";

const BUILD_ID = "BUILD-20261102T080000-3f9c";
const BINARY_SHA256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const ANALYSIS_PLAN_ID = "PLAN-20261108T093000-5c1e";
const METRICS_SHA256 = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

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
    expect(withoutPlanDefaults(parsed)).toEqual({
      ...original,
      build_id: null,
      threads: null,
      binary_sha256: null,
    });
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
    expect(withoutPlanDefaults(schema.parse(input))).toEqual(input);
  });

  test.each([
    { build_id: null },
    { binary_sha256: null },
    { threads: 1 },
    { build_id: BUILD_ID, binary_sha256: BINARY_SHA256 },
  ])("defaults individually omitted fields in %j", (fields) => {
    const input = { ...legacy(), ...fields };
    expect(withoutPlanDefaults(schema.parse(input))).toEqual({
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
      expect(withoutPlanDefaults(schema.parse(input))).toEqual(input);
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
    expect(withoutPlanDefaults(schema.parse(input))).toEqual(input);
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

describe.each(runSchemas)("$name plan fields", ({ name, schema, legacy, statuses }) => {
  const planStatuses =
    name === "RunJob"
      ? statuses.filter(({ status }) => status === "collected" || status === "running")
      : statuses;
  describe.each(planStatuses)("status $status", (statusFields) => {
    test.each([
      {},
      { analysis_plan_id: null },
      { parameter_set_id: null },
      { analysis_plan_id: null, parameter_set_id: null },
      { analysis_plan_id: ANALYSIS_PLAN_ID, parameter_set_id: "PSET-2" },
    ])("accepts paired identifiers after defaults: %j", (fields) => {
      const input = { ...legacy(), ...statusFields, ...fields };
      const original = structuredClone(input);
      const parsed = schema.parse(input);
      expect(parsed.analysis_plan_id).toBe(fields.analysis_plan_id ?? null);
      expect(parsed.parameter_set_id).toBe(fields.parameter_set_id ?? null);
      expect(parsed.status).toBe(statusFields.status);
      expect(input).toEqual(original);
    });

    test.each([
      { analysis_plan_id: ANALYSIS_PLAN_ID },
      { analysis_plan_id: ANALYSIS_PLAN_ID, parameter_set_id: null },
      { parameter_set_id: "PSET-1" },
      { analysis_plan_id: null, parameter_set_id: "PSET-1" },
    ])("rejects an unpaired identifier at parameter_set_id: %j", (fields) => {
      const result = schema.safeParse({ ...legacy(), ...statusFields, ...fields });
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.path.join("."))).toEqual([
        "parameter_set_id",
      ]);
    });
  });

  test.each(["PSET-1", "PSET-2", "PSET-3", "PSET-4", "PSET-5"])(
    "accepts the shared parameter set identifier %s",
    (parameter_set_id) => {
      const parsed = schema.parse({
        ...legacy(),
        analysis_plan_id: ANALYSIS_PLAN_ID,
        parameter_set_id,
      });
      expect(parsed.analysis_plan_id).toBe(ANALYSIS_PLAN_ID);
      expect(parsed.parameter_set_id).toBe(parameter_set_id);
    },
  );

  test.each([
    ["analysis_plan_id", "PLAN-0001"],
    ["analysis_plan_id", "PLAN-20261108T093000-5C1E"],
    ["analysis_plan_id", "RUN-20261108T093000-5c1e"],
    ["parameter_set_id", "PSET-6"],
    ["parameter_set_id", "pset-1"],
  ])("rejects malformed %s=%s at its own field", (field, value) => {
    const result = schema.safeParse({
      ...legacy(),
      analysis_plan_id: ANALYSIS_PLAN_ID,
      parameter_set_id: "PSET-1",
      [field]: value,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toEqual([field]);
  });

  test.each([
    { milestone: "M2", fields: {} },
    {
      milestone: "M3",
      fields: { task_id: "TASK-0001", stack_id: "STACK-0001", data_id: "DATA-0001" },
    },
    {
      milestone: "M4",
      fields: {
        task_id: "TASK-0001",
        stack_id: "STACK-0001",
        data_id: "DATA-0001",
        build_id: BUILD_ID,
        threads: 1,
        binary_sha256: BINARY_SHA256,
      },
    },
  ])("preserves every $milestone raw field without adding M5 keys", ({ fields }) => {
    const input = {
      ...legacy(),
      ...fields,
      ...("backend" in legacy() ? { status: "collected" } : {}),
    };
    const original = structuredClone(input);
    const originalJson = JSON.stringify(input);
    expect(Object.hasOwn(input, "analysis_plan_id")).toBe(false);
    expect(Object.hasOwn(input, "parameter_set_id")).toBe(false);
    if ("artifacts" in input) {
      expect(Object.hasOwn(input.artifacts, "metrics_summary")).toBe(false);
      expect(input.numerical_health).toEqual({
        water_balance_residual: null,
        cvode_failures: null,
        negative_state_count: null,
        max_solver_dt: null,
      });
    }
    expect(withoutPlanDefaults(schema.parse(input))).toEqual({
      build_id: null,
      threads: null,
      binary_sha256: null,
      ...original,
    });
    expect(input).toEqual(original);
    expect(JSON.stringify(input)).toBe(originalJson);
  });
});

describe("RunRecord metrics summary", () => {
  test("accepts a run-relative summary and the specified numerical health", () => {
    const input = {
      ...validRunRecord(),
      analysis_plan_id: ANALYSIS_PLAN_ID,
      parameter_set_id: "PSET-3",
      artifacts: {
        ...validRunRecord().artifacts,
        metrics_summary: { path: "metrics.json", sha256: METRICS_SHA256 },
      },
      numerical_health: {
        water_balance_residual: 0.003,
        cvode_failures: 0,
        negative_state_count: 0,
        max_solver_dt: null,
      },
    };
    expect(RunRecordSchema.parse(input)).toEqual({
      ...input,
      build_id: null,
      threads: null,
      binary_sha256: null,
    });
  });

  test.each([
    { status: "succeeded", exit_code: 0, exit_class: "ok" },
    { status: "failed", exit_code: 19, exit_class: "cvode" },
  ])("accepts explicit null and defaults an omitted summary for $status", (state) => {
    const omitted = { ...validRunRecord(), ...state };
    const explicitNull = {
      ...omitted,
      artifacts: { ...omitted.artifacts, metrics_summary: null },
    };
    const parsedOmitted = RunRecordSchema.parse(omitted);
    const parsedNull = RunRecordSchema.parse(explicitNull);
    expect(parsedOmitted.artifacts.metrics_summary).toBeNull();
    expect(parsedNull.artifacts.metrics_summary).toBeNull();
    expect(parsedNull).toEqual(parsedOmitted);
    expect(Object.hasOwn(omitted.artifacts, "metrics_summary")).toBe(false);
    expect(Object.hasOwn(explicitNull.artifacts, "metrics_summary")).toBe(true);
    expect(explicitNull.artifacts.metrics_summary).toBeNull();
  });

  test("allows a well-shaped summary on a failed record without collect policy", () => {
    const input = {
      ...validRunRecord(),
      status: "failed",
      exit_code: 19,
      exit_class: "cvode",
      artifacts: {
        ...validRunRecord().artifacts,
        metrics_summary: { path: "metrics.json", sha256: METRICS_SHA256 },
      },
    };
    const parsed = RunRecordSchema.parse(input);
    expect(parsed.status).toBe("failed");
    expect(parsed.artifacts.metrics_summary).toEqual({
      path: "metrics.json",
      sha256: METRICS_SHA256,
    });
    expect(parsed.numerical_health).toEqual(input.numerical_health);
  });

  test.each([
    "output/ccw.out/metrics.json",
    "../metrics.json",
    "/metrics.json",
    "./metrics.json",
    "metrics.JSON",
    "metrics.json\n",
  ])("rejects a nonliteral metrics path %j at the nested path", (path) => {
    const record = validRunRecord();
    const result = RunRecordSchema.safeParse({
      ...record,
      artifacts: {
        ...record.artifacts,
        metrics_summary: { path, sha256: METRICS_SHA256 },
      },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toEqual([
      "artifacts.metrics_summary.path",
    ]);
  });

  test.each([
    { name: "uppercase", fields: { sha256: METRICS_SHA256.toUpperCase() } },
    { name: "missing", fields: {} },
    { name: "63 characters", fields: { sha256: METRICS_SHA256.slice(1) } },
    { name: "65 characters", fields: { sha256: `${METRICS_SHA256}0` } },
    { name: "trailing newline", fields: { sha256: `${METRICS_SHA256}\n` } },
    { name: "nonhex", fields: { sha256: `g${METRICS_SHA256.slice(1)}` } },
  ])("rejects $name digest at the nested sha256 field", ({ fields }) => {
    const record = validRunRecord();
    const result = RunRecordSchema.safeParse({
      ...record,
      artifacts: {
        ...record.artifacts,
        metrics_summary: { path: "metrics.json", ...fields },
      },
    });
    expect(result.success).toBe(false);
    expect([...new Set(result.error?.issues.map((issue) => issue.path.join(".")))]).toEqual([
      "artifacts.metrics_summary.sha256",
    ]);
  });

  test.each([
    { summary: [], field: "artifacts.metrics_summary" },
    { summary: "metrics.json", field: "artifacts.metrics_summary" },
    { summary: 42, field: "artifacts.metrics_summary" },
    { summary: { sha256: METRICS_SHA256 }, field: "artifacts.metrics_summary.path" },
    {
      summary: { path: "metrics.json", sha256: null },
      field: "artifacts.metrics_summary.sha256",
    },
  ])("rejects a malformed summary $summary at $field", ({ summary, field }) => {
    const record = validRunRecord();
    const result = RunRecordSchema.safeParse({
      ...record,
      artifacts: { ...record.artifacts, metrics_summary: summary },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toEqual([field]);
  });

  test.each([
    { path: ["artifacts", "metrics_summary"], key: "extra" },
    { path: ["artifacts", "metrics_summary"], key: "plots" },
    { path: ["artifacts"], key: "plots" },
    { path: ["artifacts"], key: "extra" },
  ])("rejects unknown $key at $path", ({ path, key }) => {
    const summary = { path: "metrics.json", sha256: METRICS_SHA256 };
    const record = validRunRecord();
    const artifacts =
      path.length === 2
        ? { ...record.artifacts, metrics_summary: { ...summary, [key]: [] } }
        : { ...record.artifacts, [key]: [] };
    const result = RunRecordSchema.safeParse({ ...record, artifacts });
    expect(result.success).toBe(false);
    const issue = result.error?.issues.find(
      (issue) => issue.code === "unrecognized_keys" && issue.keys.includes(key),
    );
    expect(issue).toBeDefined();
    expect(issue?.path).toEqual(path);
  });
});

function withoutPlanDefaults(parsed: Record<string, unknown>) {
  const { analysis_plan_id, parameter_set_id, ...legacy } = parsed;
  expect(analysis_plan_id).toBeNull();
  expect(parameter_set_id).toBeNull();
  if ("artifacts" in legacy) {
    const { metrics_summary, ...artifacts } = legacy.artifacts as Record<string, unknown>;
    expect(metrics_summary).toBeNull();
    legacy.artifacts = artifacts;
  }
  return legacy;
}

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
