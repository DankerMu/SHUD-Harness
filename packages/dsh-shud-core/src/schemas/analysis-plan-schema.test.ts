import { expect, test } from "vitest";
import { AnalysisPlanSchema, ParameterSetIdSchema } from "../index.ts";

function parameterSet(
  parameter_set_id: string,
  baseline: boolean,
  changes: Record<string, number>,
  label: string | null = null,
) {
  return { parameter_set_id, label, baseline, changes };
}

// Literal acceptance example from issue #642; expectations do not use the whitelist implementation.
function acceptancePlan() {
  return {
    analysis_plan_id: "PLAN-20261108T093000-5c1e",
    task_id: "TASK-20261108T090000-3f9c",
    mode: "sensitivity",
    strategy: "one_at_a_time",
    input_dir: "/workspace/input/ccw",
    project: "ccw",
    end_days: 90,
    threads: 1,
    parameter_sets: [
      parameterSet("PSET-1", true, {}),
      parameterSet("PSET-2", false, { GEOL_KSATH: 0.5 }),
      parameterSet("PSET-3", false, { GEOL_KSATH: 2 }),
      parameterSet("PSET-4", false, { LC_ROUGH: 2 }),
    ],
    parameter_space_rationale: {
      proposed_by: "agent",
      basis: "单键 OAT",
      confirmed_by: null,
    },
    input_digests: {
      "ccw.cfg.calib": "a".repeat(64),
      "ccw.para.geol": "b".repeat(64),
      "ccw.para.lc": "c".repeat(64),
    },
    created_by: "coordinator",
    created_at: "2026-11-08T09:30:00Z",
  };
}

function geolPlan() {
  return {
    ...acceptancePlan(),
    parameter_sets: acceptancePlan().parameter_sets.slice(0, 3),
    input_digests: { "ccw.cfg.calib": "a".repeat(64), "ccw.para.geol": "b".repeat(64) },
  };
}

function rejectsPlan(input: unknown, field: string) {
  const result = AnalysisPlanSchema.safeParse(input);
  expect(result.success).toBe(false);
  expect(result.error?.issues.map((issue) => issue.path[0])).toContain(field);
}

test("AnalysisPlan preserves the thirteen-field ccw acceptance plan", () => {
  const input = acceptancePlan();
  expect(AnalysisPlanSchema.parse(input)).toEqual(input);
});

test("AnalysisPlan accepts three parameter sets and the inclusive multiplier bounds", () => {
  const input = geolPlan();
  expect(AnalysisPlanSchema.parse(input)).toEqual(input);
});

test("AnalysisPlan accepts five sets with all four whitelist keys and one digest per table", () => {
  const input = {
    ...acceptancePlan(),
    parameter_sets: [
      parameterSet("PSET-1", true, {}),
      parameterSet("PSET-2", false, { GEOL_KSATH: 0.5 }),
      parameterSet("PSET-3", false, { GEOL_KSATV: 0.5 }),
      parameterSet("PSET-4", false, { LC_ROUGH: 2 }),
      parameterSet("PSET-5", false, { RIV_ROUGH: 2 }),
    ],
    input_digests: { ...acceptancePlan().input_digests, "ccw.sp.riv": "d".repeat(64) },
  };
  expect(AnalysisPlanSchema.parse(input)).toEqual(input);
});

test.each([
  ["GEOL_KSATH", "ccw.para.geol"],
  ["GEOL_KSATV", "ccw.para.geol"],
  ["LC_ROUGH", "ccw.para.lc"],
  ["RIV_ROUGH", "ccw.sp.riv"],
])("AnalysisPlan requires only cfg.calib and the %s table %s", (key, filename) => {
  const input = {
    ...geolPlan(),
    parameter_sets: [
      parameterSet("PSET-1", true, {}),
      parameterSet("PSET-2", false, { [key]: 0.5 }),
      parameterSet("PSET-3", false, { [key]: 2 }),
    ],
    input_digests: { "ccw.cfg.calib": "a".repeat(64), [filename]: "b".repeat(64) },
  };
  expect(AnalysisPlanSchema.parse(input)).toEqual(input);
  rejectsPlan({ ...input, input_digests: { "ccw.cfg.calib": "a".repeat(64) } }, "input_digests");
});

test("AnalysisPlan deduplicates the table shared by horizontal and vertical geologic changes", () => {
  const input = {
    ...geolPlan(),
    parameter_sets: [
      parameterSet("PSET-1", false, { GEOL_KSATH: 0.75 }, "horizontal"),
      parameterSet("PSET-2", true, {}, "baseline"),
      parameterSet("PSET-3", false, { GEOL_KSATV: 0.75 }, "vertical"),
    ],
    threads: 2,
    created_at: "2026-11-08T09:30:00.123Z",
  };
  expect(AnalysisPlanSchema.parse(input)).toEqual(input);
});

test.each([
  "$&",
  "<project>",
  "<end_days>",
  "a..b",
  "...",
  " ",
  "a b",
  "\n",
  "雨",
  "a:b",
  ".hidden",
  "a.",
])("AnalysisPlan preserves literal project component %j in all required filenames", (project) => {
  const input = {
    ...acceptancePlan(),
    project,
    input_digests: {
      [`${project}.cfg.calib`]: "a".repeat(64),
      [`${project}.para.geol`]: "b".repeat(64),
      [`${project}.para.lc`]: "c".repeat(64),
    },
  };
  expect(AnalysisPlanSchema.parse(input)).toEqual(input);
});

test.each([
  {
    name: "no baseline",
    sets: [
      parameterSet("PSET-1", false, { GEOL_KSATH: 0.75 }),
      parameterSet("PSET-2", false, { GEOL_KSATH: 0.5 }),
      parameterSet("PSET-3", false, { GEOL_KSATH: 2 }),
    ],
  },
  {
    name: "two baselines",
    sets: [
      parameterSet("PSET-1", true, {}),
      parameterSet("PSET-2", true, {}),
      parameterSet("PSET-3", false, { GEOL_KSATH: 2 }),
    ],
  },
  {
    name: "nonempty baseline",
    sets: [
      parameterSet("PSET-1", true, { GEOL_KSATH: 0.5 }),
      parameterSet("PSET-2", false, { GEOL_KSATH: 0.75 }),
      parameterSet("PSET-3", false, { GEOL_KSATH: 2 }),
    ],
  },
  {
    name: "empty perturbation",
    sets: [
      parameterSet("PSET-1", true, {}),
      parameterSet("PSET-2", false, {}),
      parameterSet("PSET-3", false, { GEOL_KSATH: 2 }),
    ],
  },
  {
    name: "duplicate perturbations",
    sets: [
      parameterSet("PSET-1", true, {}),
      parameterSet("PSET-2", false, { GEOL_KSATH: 2 }),
      parameterSet("PSET-3", false, { GEOL_KSATH: 2 }),
    ],
  },
])("AnalysisPlan rejects $name at parameter_sets", ({ sets }) => {
  rejectsPlan({ ...geolPlan(), parameter_sets: sets }, "parameter_sets");
});

test("AnalysisPlan rejects a perturbation with two whitelist keys", () => {
  const input = acceptancePlan();
  input.parameter_sets[1] = parameterSet("PSET-2", false, { GEOL_KSATH: 0.5, LC_ROUGH: 2 });
  rejectsPlan(input, "parameter_sets");
});

test.each([2, 6])("AnalysisPlan rejects %s parameter sets", (count) => {
  const sets = [
    parameterSet("PSET-1", true, {}),
    parameterSet("PSET-2", false, { GEOL_KSATH: 0.5 }),
    parameterSet("PSET-3", false, { GEOL_KSATH: 0.75 }),
    parameterSet("PSET-4", false, { GEOL_KSATH: 1.25 }),
    parameterSet("PSET-5", false, { GEOL_KSATH: 1.5 }),
    parameterSet("PSET-6", false, { GEOL_KSATH: 2 }),
  ];
  rejectsPlan({ ...geolPlan(), parameter_sets: sets.slice(0, count) }, "parameter_sets");
});

test.each([
  ["PSET-1", "PSET-3", "PSET-2"],
  ["PSET-1", "PSET-2", "PSET-6"],
  ["PSET-1", "PSET-2", "PSET-2"],
  ["PSET-2", "PSET-3", "PSET-4"],
])("AnalysisPlan rejects parameter set order %s, %s, %s", (...ids) => {
  const input = geolPlan();
  input.parameter_sets = input.parameter_sets.map((set, index) => ({
    ...set,
    parameter_set_id: ids[index],
  }));
  rejectsPlan(input, "parameter_sets");
});

test.each([0.49, 2.01, 1, NaN, Infinity, -Infinity])(
  "AnalysisPlan rejects non-OAT multiplier %s",
  (multiplier) => {
    const input = geolPlan();
    input.parameter_sets[1] = parameterSet("PSET-2", false, { GEOL_KSATH: multiplier });
    rejectsPlan(input, "parameter_sets");
  },
);

test.each([
  "GEOL_THETAS",
  "GEOL_THETAR",
  "SOIL_BETA",
  "TS_SFCTMP+",
  "GEOL_KSATH+",
  "geol_ksath",
  "Geol_Ksath",
  "GEOL_ksath",
  "UNKNOWN",
])("AnalysisPlan rejects non-whitelisted key %s", (key) => {
  const input = geolPlan();
  input.parameter_sets[1] = parameterSet("PSET-2", false, { [key]: 0.5 });
  rejectsPlan(input, "parameter_sets");
});

test.each([
  ["proposed_by", "pi"],
  ["confirmed_by", "pi"],
  ["confirmed_by", false],
  ["basis", ""],
  ["basis", null],
])("AnalysisPlan rejects rationale %s value %j", (field, value) => {
  const input = acceptancePlan();
  rejectsPlan(
    { ...input, parameter_space_rationale: { ...input.parameter_space_rationale, [field]: value } },
    "parameter_space_rationale",
  );
});

test.each(["proposed_by", "basis", "confirmed_by"])(
  "AnalysisPlan requires explicit rationale %s",
  (field) => {
    const input = acceptancePlan();
    const rationale: Record<string, unknown> = input.parameter_space_rationale;
    delete rationale[field];
    rejectsPlan(input, "parameter_space_rationale");
  },
);

test.each([
  {},
  { "ccw.para.geol": "b".repeat(64) },
  { "ccw.cfg.calib": "a".repeat(64) },
  {
    "ccw.cfg.calib": "a".repeat(64),
    "ccw.para.geol": "b".repeat(64),
    "ccw.para.lc": "c".repeat(64),
  },
  { "other.cfg.calib": "a".repeat(64), "other.para.geol": "b".repeat(64) },
])("AnalysisPlan rejects an inexact input digest set %j", (input_digests) => {
  rejectsPlan({ ...geolPlan(), input_digests }, "input_digests");
});

test.each([
  "../ccw.para.geol",
  "/abs/ccw.para.geol",
  "./ccw.para.geol",
  "nested/../ccw.para.geol",
  "nested/./ccw.para.geol",
  "nested//ccw.para.geol",
  "ccw.para.geol/",
  "ccw\0.para.geol",
  "",
])("AnalysisPlan rejects unsafe digest path %j", (path) => {
  rejectsPlan(
    {
      ...geolPlan(),
      input_digests: { "ccw.cfg.calib": "a".repeat(64), [path]: "b".repeat(64) },
    },
    "input_digests",
  );
});

test.each([
  "B".repeat(64),
  "b".repeat(63),
  "b".repeat(65),
  "g".repeat(64),
  `${"b".repeat(64)}\n`,
  "",
  null,
  123,
])("AnalysisPlan rejects invalid SHA-256 value %j", (digest) => {
  rejectsPlan(
    {
      ...geolPlan(),
      input_digests: { "ccw.cfg.calib": "a".repeat(64), "ccw.para.geol": digest },
    },
    "input_digests",
  );
});

test.each([
  ["analysis_plan_id", "PLAN-0001"],
  ["analysis_plan_id", "PLAN-20261108T093000-5C1E"],
  ["analysis_plan_id", "TASK-20261108T093000-5c1e"],
  ["task_id", "TASK-0001"],
  ["task_id", "PLAN-20261108T093000-5c1e"],
  ["mode", "calibration"],
  ["strategy", "grid_search"],
  ["input_dir", ""],
  ["input_dir", "input/ccw"],
  ["input_dir", "~/input/ccw"],
  ["input_dir", null],
  ["project", ""],
  ["project", "."],
  ["project", ".."],
  ["project", "a/b"],
  ["project", "a\\b"],
  ["project", "a\0b"],
  ["project", 42],
  ["end_days", 0],
  ["end_days", -1],
  ["end_days", 1.5],
  ["end_days", "90"],
  ["end_days", Infinity],
  ["threads", 0],
  ["threads", -1],
  ["threads", 1.5],
  ["threads", "1"],
  ["threads", null],
  ["threads", Infinity],
  ["created_by", ""],
  ["created_by", null],
  ["created_at", "2026-11-08"],
  ["created_at", "2026-11-08T09:30:00"],
  ["created_at", "2026-11-08T10:30:00+01:00"],
  ["created_at", "2026-02-30T09:30:00Z"],
  ["created_at", "yesterday"],
  ["parameter_sets", null],
  ["parameter_sets", {}],
  ["parameter_space_rationale", null],
  ["input_digests", null],
  ["input_digests", []],
] as const)("AnalysisPlan rejects invalid %s value %j without coercion", (field, value) => {
  rejectsPlan({ ...acceptancePlan(), [field]: value }, field);
});

test.each(Object.keys(acceptancePlan()))(
  "AnalysisPlan requires explicit %s without defaults",
  (field) => {
    const input: Record<string, unknown> = acceptancePlan();
    delete input[field];
    rejectsPlan(input, field);
  },
);

test.each(["parameter_set_id", "label", "baseline", "changes"])(
  "AnalysisPlan requires explicit parameter set %s",
  (field) => {
    const input = acceptancePlan();
    const set: Record<string, unknown> = input.parameter_sets[0];
    delete set[field];
    rejectsPlan(input, "parameter_sets");
  },
);

test.each([
  ["label", ""],
  ["label", 42],
  ["baseline", "true"],
  ["baseline", 1],
  ["baseline", null],
  ["changes", null],
  ["changes", []],
  ["changes", { GEOL_KSATH: "0.5" }],
  ["changes", { GEOL_KSATH: null }],
] as const)("AnalysisPlan rejects invalid parameter set %s value %j", (field, value) => {
  const input = acceptancePlan();
  rejectsPlan(
    {
      ...input,
      parameter_sets: input.parameter_sets.map((set, index) =>
        index === 1 ? { ...set, [field]: value } : set,
      ),
    },
    "parameter_sets",
  );
});

test.each([
  { path: [], key: "status", value: "running" },
  { path: ["parameter_sets", 0], key: "run_id", value: "RUN-20261108T093000-7b2d" },
  { path: ["parameter_sets", 0], key: "status", value: "running" },
  { path: ["parameter_space_rationale"], key: "approval_ref", value: "pi-approved" },
])("AnalysisPlan identifies unknown key $key at $path", ({ path, key, value }) => {
  const input = acceptancePlan();
  const target: Record<string, unknown> =
    path.length === 0
      ? input
      : path[0] === "parameter_sets"
        ? input.parameter_sets[0]
        : input.parameter_space_rationale;
  target[key] = value;
  const result = AnalysisPlanSchema.safeParse(input);
  expect(result.success).toBe(false);
  const unknownKeyIssue = result.error?.issues.find(
    (issue) => issue.code === "unrecognized_keys" && issue.keys.includes(key),
  );
  expect(unknownKeyIssue).toBeDefined();
  expect(unknownKeyIssue?.path).toEqual(path);
});

test.each([null, [], "plan", 42])("AnalysisPlan rejects a non-object record %j", (input) => {
  expect(AnalysisPlanSchema.safeParse(input).success).toBe(false);
});

test.each(["PSET-1", "PSET-2", "PSET-3", "PSET-4", "PSET-5"])(
  "ParameterSetId accepts %s for downstream record reuse",
  (id) => {
    expect(ParameterSetIdSchema.parse(id)).toBe(id);
  },
);

test.each(["PSET-0", "PSET-6", "PSET-01", "PSET-001", "pset-1", "PSET-1\n", "RUN-1", "", 1, null])(
  "ParameterSetId rejects noncanonical id %j",
  (id) => {
    expect(ParameterSetIdSchema.safeParse(id).success).toBe(false);
  },
);
