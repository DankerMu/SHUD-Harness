import { expect, test } from "vitest";
import { VerificationCaseSchema } from "../index.ts";

function passedVerification() {
  return {
    vc_id: "VC-20261102T101500-0c3e",
    task_id: "TASK-20261102T090000-3f9c",
    change_id: "CHG-20261102T093000-4a1f",
    bundle_id: null,
    case_type: "regression",
    expected_result_source: "baseline_regression",
    target_code_targets: ["Makefile", "src/Model/MD_rhs_core.cpp"],
    description: "Compare the pinned base and candidate rivqdown outputs.",
    expected_result: "Identical rivqdown bytes at one thread.",
    pass_criteria: "sha256(candidate rivqdown.dat) == sha256(base rivqdown.dat)",
    base_run_id: "RUN-20261102T100100-a1b2",
    candidate_run_id: "RUN-20261102T101000-b2c3",
    base_build_id: "BUILD-20261102T100000-7b2d",
    candidate_build_id: "BUILD-20261102T100500-8c3e",
    artifact_refs: [
      "runs/RUN-20261102T100100-a1b2/output/keliya.out/keliya.rivqdown.dat",
      "runs/RUN-20261102T101000-b2c3/output/keliya.out/keliya.rivqdown.dat",
    ],
    observed: {
      compared_path: "output/keliya.out/keliya.rivqdown.dat",
      base_sha256: "a".repeat(64),
      candidate_sha256: "a".repeat(64),
    },
    status: "passed",
    failure_reason: null,
    reviewed_by: "reviewer",
    reviewer_notes: ["The compared output bytes match for this replay."],
    compatibility_verdict: "compatible",
    created_at: "2026-11-02T10:15:00Z",
  };
}

test("VerificationCase preserves a passed replay and all evidence references", () => {
  const input = passedVerification();
  expect(VerificationCaseSchema.parse(input)).toEqual(input);
});

test("VerificationCase records a failed replay with differing hashes and a reason", () => {
  const input = {
    ...passedVerification(),
    observed: { ...passedVerification().observed, candidate_sha256: "b".repeat(64) },
    status: "failed",
    failure_reason: "Candidate output differs from the pinned base.",
    compatibility_verdict: "incompatible",
  };
  expect(VerificationCaseSchema.parse(input)).toEqual(input);
});

test.each([
  { status: "passed", different: true, reason: null, path: "status" },
  { status: "passed", different: false, reason: "Mismatch", path: "failure_reason" },
  { status: "failed", different: false, reason: "Mismatch", path: "status" },
  { status: "failed", different: true, reason: null, path: "failure_reason" },
  { status: "failed", different: true, reason: "", path: "failure_reason" },
])("VerificationCase rejects conflicting $status evidence at $path", (vector) => {
  const input = passedVerification();
  const result = VerificationCaseSchema.safeParse({
    ...input,
    status: vector.status,
    failure_reason: vector.reason,
    observed: {
      ...input.observed,
      candidate_sha256: vector.different ? "b".repeat(64) : "a".repeat(64),
    },
  });
  expect(result.success).toBe(false);
  expect(result.error?.issues.map((issue) => issue.path)).toContainEqual([vector.path]);
});

test.each([
  "dimension_check",
  "mass_balance",
  "limiting_case",
  "manufactured_solution",
  "regression",
  "unit_test",
  "tiny_basin",
  "output_semantics",
])("VerificationCase accepts declared case type %s", (case_type) => {
  const input = { ...passedVerification(), case_type };
  expect(VerificationCaseSchema.parse(input)).toEqual(input);
});

test.each(["analytic", "published", "pi_provided", "baseline_regression", "agent_proposed"])(
  "VerificationCase preserves expected-result source %s without producer restrictions",
  (expected_result_source) => {
    const input = { ...passedVerification(), expected_result_source };
    expect(VerificationCaseSchema.parse(input)).toEqual(input);
  },
);

test.each(["not_run", "running", "inconclusive", "waived_by_pi"])(
  "VerificationCase does not impose passed/failed predicates on %s",
  (status) => {
    for (const candidate_sha256 of ["a".repeat(64), "b".repeat(64)]) {
      for (const failure_reason of [null, "Awaiting a reviewer decision"]) {
        const input = {
          ...passedVerification(),
          status,
          failure_reason,
          observed: { ...passedVerification().observed, candidate_sha256 },
        };
        expect(VerificationCaseSchema.parse(input)).toEqual(input);
      }
    }
  },
);

test.each(["compatible", "incompatible", "unknown"])(
  "VerificationCase preserves independent compatibility verdict %s",
  (compatibility_verdict) => {
    const input = { ...passedVerification(), compatibility_verdict };
    expect(VerificationCaseSchema.parse(input)).toEqual(input);
  },
);

test("VerificationCase accepts a bundle reference and preserves caller array order and duplicates", () => {
  const input = {
    ...passedVerification(),
    bundle_id: "theory-bundle-7",
    target_code_targets: ["z.cpp", "a.cpp", "a.cpp"],
    artifact_refs: ["z/output.dat", "a/output.dat"],
    reviewer_notes: ["Second observation", "First observation", "First observation"],
  };
  expect(VerificationCaseSchema.parse(input)).toEqual(input);
  const repeatedArtifacts = { ...input, artifact_refs: ["output.dat", "output.dat"] };
  expect(VerificationCaseSchema.parse(repeatedArtifacts)).toEqual(repeatedArtifacts);
  const noTargets = { ...input, target_code_targets: [] };
  expect(VerificationCaseSchema.parse(noTargets)).toEqual(noTargets);
});

test.each([
  ["vc_id", "VC-001"],
  ["vc_id", "VC-20261102T101500-0C3E"],
  ["task_id", "TASK-0001"],
  ["change_id", "CHG-0001"],
  ["base_run_id", "JOB-20261102T100100-a1b2"],
  ["candidate_run_id", "RUN-0001"],
  ["base_build_id", "BUILD-1"],
  ["candidate_build_id", "build-20261102T100500-8c3e"],
  ["bundle_id", ""],
  ["bundle_id", 1],
  ["case_type", "benchmark"],
  ["expected_result_source", "llm"],
  ["status", "approved"],
  ["compatibility_verdict", "passed"],
  ["description", ""],
  ["expected_result", ""],
  ["pass_criteria", ""],
  ["reviewed_by", ""],
  ["failure_reason", 42],
  ["reviewer_notes", []],
  ["reviewer_notes", [""]],
  ["reviewer_notes", [null]],
  ["reviewer_notes", "Looks compatible"],
  ["artifact_refs", []],
  ["artifact_refs", ["base.dat"]],
  ["artifact_refs", ["base.dat", "candidate.dat", "extra.dat"]],
  ["target_code_targets", null],
  ["observed", null],
  ["created_at", "2026-11-02"],
  ["created_at", "not-a-time"],
] as const)("VerificationCase rejects invalid %s value %j", (field, value) => {
  const result = VerificationCaseSchema.safeParse({ ...passedVerification(), [field]: value });
  expect(result.success).toBe(false);
  expect(result.error?.issues.map((issue) => issue.path[0])).toContain(field);
});

test.each(["", "/output.dat", "../output.dat", "output/../x.dat", "output\0.dat"])(
  "VerificationCase rejects unsafe or empty evidence path %j at every path seam",
  (path) => {
    const input = passedVerification();
    const vectors = [
      { overrides: { target_code_targets: [path] }, issue: ["target_code_targets", 0] },
      { overrides: { artifact_refs: [path, "candidate.dat"] }, issue: ["artifact_refs", 0] },
      { overrides: { artifact_refs: ["base.dat", path] }, issue: ["artifact_refs", 1] },
      {
        overrides: { observed: { ...input.observed, compared_path: path } },
        issue: ["observed", "compared_path"],
      },
    ];
    for (const { overrides, issue } of vectors) {
      const result = VerificationCaseSchema.safeParse({ ...input, ...overrides });
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((entry) => entry.path)).toContainEqual(issue);
    }
  },
);

test.each(["base_sha256", "candidate_sha256"])(
  "VerificationCase requires a lowercase 64-hex observed %s",
  (field) => {
    for (const value of [
      "",
      "a".repeat(63),
      "a".repeat(65),
      "A".repeat(64),
      "g".repeat(64),
      null,
    ]) {
      const input = passedVerification();
      const result = VerificationCaseSchema.safeParse({
        ...input,
        observed: { ...input.observed, [field]: value },
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.path)).toContainEqual(["observed", field]);
    }
  },
);

test.each(Object.keys(passedVerification()))("VerificationCase requires explicit %s", (field) => {
  const input: Record<string, unknown> = passedVerification();
  delete input[field];
  const result = VerificationCaseSchema.safeParse(input);
  expect(result.success).toBe(false);
  expect(result.error?.issues.map((issue) => issue.path)).toContainEqual([field]);
});

test.each(["compared_path", "base_sha256", "candidate_sha256"])(
  "VerificationCase requires observed.%s",
  (field) => {
    const input = passedVerification();
    Reflect.deleteProperty(input.observed, field);
    const result = VerificationCaseSchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toContainEqual(["observed", field]);
  },
);

test("VerificationCase rejects unknown root and observed fields rather than stripping evidence", () => {
  const input = passedVerification();
  expect(VerificationCaseSchema.safeParse({ ...input, extra: true }).success).toBe(false);
  const result = VerificationCaseSchema.safeParse({
    ...input,
    observed: { ...input.observed, equal: true },
  });
  expect(result.success).toBe(false);
  expect(result.error?.issues.map((issue) => issue.path)).toContainEqual(["observed"]);
});
