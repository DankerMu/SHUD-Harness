import { describe, expect, test } from "vitest";
import { AnalysisPlanIdSchema, TaskCardSchema } from "../index.ts";

const card = {
  task_id: "TASK-20261027T080005-3f9c",
  type: "science_assist",
  status: "planned",
  runtime_phase: null,
  title: "Run ccw",
  question_or_goal: "Record the ccw run evidence",
  created_by: "coordinator",
  current_owner: "coordinator",
  reviewer: "pi",
  stack_id: "STACK-20261027T080005-a1b2",
  data_id: "DATA-20261027T081000-7d2e",
  inference_budget: { mode: "normal" },
  linked_jobs: ["JOB-20261027T081000-0123"],
  linked_reports: ["REPORT-20261027T090000-5b10"],
  created_at: "2026-10-27T08:00:05Z",
  updated_at: "2026-10-27T09:00:00Z",
};

const sourceBaseCommit = "9a422e5eb708df7d2f8b4066a3083a031d679a82";
const analysisPlanId = "PLAN-20261107T080000-3f9c";

function expectAnalysisDefault(input: unknown) {
  const { linked_analyses, ...oldFields } = TaskCardSchema.parse(input);
  expect(linked_analyses).toEqual([]);
  return oldFields;
}

function expectLegacyDefaults(input: unknown, expectedOldFields: unknown = input) {
  const { linked_changes, linked_verifications, source_base_commit, ...oldFields } =
    expectAnalysisDefault(input);
  expect(oldFields).toEqual(expectedOldFields);
  expect(linked_changes).toEqual([]);
  expect(linked_verifications).toEqual([]);
  expect(source_base_commit).toBeNull();
}

describe("TaskCard branded references", () => {
  test("accepts a new card with explicit null references and empty links", () => {
    const input = {
      ...card,
      stack_id: null,
      data_id: null,
      linked_jobs: [],
      linked_reports: [],
      linked_changes: [],
      linked_verifications: [],
      source_base_commit: null,
    };
    expect(expectAnalysisDefault(input)).toEqual(input);
  });

  test.each(["stack_id", "data_id"] as const)("requires an explicit %s", (field) => {
    const input = { ...card };
    Reflect.deleteProperty(input, field);
    const result = TaskCardSchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toContainEqual([field]);
  });

  test.each([
    ["task_id", "TASK-0001"],
    ["task_id", "TASK-20261027T080005-3F9C"],
    ["task_id", "RUN-20261027T080005-3f9c"],
    ["stack_id", "STACK-0001"],
    ["stack_id", "DATA-20261027T081000-7d2e"],
    ["data_id", "DATA-0001"],
    ["data_id", "STACK-20261027T080005-a1b2"],
    ["linked_jobs", ["JOB-0001"]],
    ["linked_jobs", ["RUN-20261027T081000-0123"]],
    ["linked_reports", ["REPORT-0001"]],
    ["linked_reports", ["DEC-20261027T093012-c4e7"]],
  ])("rejects malformed %s value %j at the field", (field, value) => {
    const result = TaskCardSchema.safeParse({ ...card, [field]: value });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path[0])).toContain(field);
  });

  test.each(["stack_id", "data_id"] as const)(
    "accepts branded references and links while %s remains null",
    (field) => {
      const input = { ...card, [field]: null, theory_bundle_ids: ["theory-ccw"] };
      expectLegacyDefaults(input);
    },
  );

  test("keeps reviewer, optional theory bundles and root/nested unknown-key stripping", () => {
    const input = { ...card, stack_id: null, data_id: null };
    expectLegacyDefaults(
      {
        ...input,
        client_trace_id: "not stored",
        inference_budget: { ...input.inference_budget, extra: true },
      },
      input,
    );
  });
});

describe("TaskCard code-change references and legacy defaults", () => {
  test("accepts code_change with a pinned commit and branded change and verification links", () => {
    const input = {
      ...card,
      type: "code_change",
      linked_changes: ["CHG-20261102T080000-3f9c"],
      linked_verifications: ["VC-20261102T090000-a1b2"],
      source_base_commit: sourceBaseCommit,
    };
    const before = JSON.stringify(input);
    expect(expectAnalysisDefault(input)).toEqual(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(input).not.toHaveProperty("linked_analyses");
  });

  test("supplies four defaults without changing legacy input or its existing fields", () => {
    const before = JSON.stringify(card);
    expectLegacyDefaults(card);
    expect(JSON.stringify(card)).toBe(before);
    expect(card).not.toHaveProperty("linked_changes");
    expect(card).not.toHaveProperty("linked_verifications");
    expect(card).not.toHaveProperty("source_base_commit");
    expect(card).not.toHaveProperty("linked_analyses");
  });

  test("supplies independent empty link arrays for each legacy parse", () => {
    const first = TaskCardSchema.parse(card);
    const second = TaskCardSchema.parse(card);
    expect(first.linked_changes).toEqual([]);
    expect(first.linked_verifications).toEqual([]);
    expect(second.linked_changes).toEqual([]);
    expect(second.linked_verifications).toEqual([]);
    expect(first.linked_analyses).toEqual([]);
    expect(second.linked_analyses).toEqual([]);
    expect(first.linked_changes).not.toBe(second.linked_changes);
    expect(first.linked_verifications).not.toBe(second.linked_verifications);
    expect(first.linked_changes).not.toBe(first.linked_verifications);
    expect(first.linked_analyses).not.toBe(second.linked_analyses);
    expect(first.linked_analyses).not.toBe(first.linked_changes);
    expect(first.linked_analyses).not.toBe(first.linked_verifications);
    first.linked_analyses.push(AnalysisPlanIdSchema.parse(analysisPlanId));
    expect(first.linked_analyses).toEqual([analysisPlanId]);
    expect(second.linked_analyses).toEqual([]);
    expect(first.linked_changes).toEqual([]);
    expect(first.linked_verifications).toEqual([]);
  });

  test("keeps runtime_phase and theory_bundle_ids optional", () => {
    const input = { ...card };
    Reflect.deleteProperty(input, "runtime_phase");
    expectLegacyDefaults(input);
    const parsed = TaskCardSchema.parse(input);
    expect(parsed).not.toHaveProperty("runtime_phase");
    expect(parsed).not.toHaveProperty("theory_bundle_ids");
  });

  test.each([
    ["missing", {}],
    ["null", { source_base_commit: null }],
  ])("rejects code_change with a %s source_base_commit at the field", (_, commit) => {
    const result = TaskCardSchema.safeParse({ ...card, type: "code_change", ...commit });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toContainEqual(["source_base_commit"]);
  });

  test.each(["engineering", "science_assist", "ops"])(
    "accepts %s with missing or null source_base_commit",
    (type) => {
      const input = { ...card, type };
      expectLegacyDefaults(input);
      expectLegacyDefaults({ ...input, source_base_commit: null }, input);
    },
  );

  test.each(["engineering", "science_assist", "ops"])(
    "rejects %s with non-null source_base_commit at the field",
    (type) => {
      const result = TaskCardSchema.safeParse({
        ...card,
        type,
        source_base_commit: sourceBaseCommit,
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.path)).toContainEqual([
        "source_base_commit",
      ]);
    },
  );

  test.each([
    "9a422e5",
    "9A422E5EB708DF7D2F8B4066A3083A031D679A82",
    "9a422e5eb708df7d2f8b4066a3083a031d679a8g",
  ])("rejects malformed source_base_commit %s at the field", (source_base_commit) => {
    const result = TaskCardSchema.safeParse({
      ...card,
      type: "code_change",
      source_base_commit,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toContainEqual(["source_base_commit"]);
  });

  test.each([
    ["linked_changes", ["CHG-0001"]],
    ["linked_verifications", ["VC-20261102T090000-A1B2"]],
  ])("rejects malformed %s brands at the array item", (field, value) => {
    const result = TaskCardSchema.safeParse({ ...card, [field]: value });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toContainEqual([field, 0]);
  });

  test("rejects the unknown code_review type at the field", () => {
    const result = TaskCardSchema.safeParse({ ...card, type: "code_review" });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toContainEqual(["type"]);
  });

  test.each(["linked_changes", "linked_verifications"])(
    "rejects explicit null %s rather than defaulting it",
    (field) => {
      const result = TaskCardSchema.safeParse({ ...card, [field]: null });
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.path)).toContainEqual([field]);
    },
  );

  test("preserves the order and duplicates of valid change and verification links", () => {
    const input = {
      ...card,
      linked_changes: [
        "CHG-20261102T090000-a1b2",
        "CHG-20261102T080000-3f9c",
        "CHG-20261102T090000-a1b2",
      ],
      linked_verifications: [
        "VC-20261102T100000-3f9c",
        "VC-20261102T090000-a1b2",
        "VC-20261102T100000-3f9c",
      ],
      source_base_commit: null,
    };
    expect(expectAnalysisDefault(input)).toEqual(input);
  });
});

describe("TaskCard sensitivity analysis references", () => {
  test("accepts sensitivity with one branded plan and a null source base commit", () => {
    const input = {
      ...card,
      type: "sensitivity",
      source_base_commit: null,
      linked_analyses: [analysisPlanId],
    };
    expect(TaskCardSchema.parse(input)).toEqual({
      ...input,
      linked_changes: [],
      linked_verifications: [],
    });
  });

  test.each(["engineering", "science_assist", "ops", "code_change", "sensitivity"])(
    "accepts omitted and explicit empty analysis links for %s",
    (type) => {
      const input = {
        ...card,
        type,
        source_base_commit: type === "code_change" ? sourceBaseCommit : null,
      };
      const expected = { ...input, linked_changes: [], linked_verifications: [] };
      expect(expectAnalysisDefault(input)).toEqual(expected);
      expect(expectAnalysisDefault({ ...input, linked_analyses: [] })).toEqual(expected);
    },
  );

  test.each(["engineering", "science_assist", "ops", "code_change"])(
    "rejects nonempty analysis links on %s at linked_analyses",
    (type) => {
      const result = TaskCardSchema.safeParse({
        ...card,
        type,
        source_base_commit: type === "code_change" ? sourceBaseCommit : null,
        linked_analyses: [analysisPlanId],
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.path)).toContainEqual(["linked_analyses"]);
    },
  );

  test("rejects a sensitivity source base commit even when it is valid 40-hex", () => {
    const result = TaskCardSchema.safeParse({
      ...card,
      type: "sensitivity",
      source_base_commit: sourceBaseCommit,
      linked_analyses: [analysisPlanId],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toContainEqual(["source_base_commit"]);
  });

  test.each(["PLAN-0001", "PLAN-20261107T080000-3F9C"])(
    "rejects malformed analysis plan %s at the array item",
    (plan) => {
      const result = TaskCardSchema.safeParse({
        ...card,
        type: "sensitivity",
        source_base_commit: null,
        linked_analyses: [plan],
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.path)).toContainEqual([
        "linked_analyses",
        0,
      ]);
    },
  );

  test.each([null, analysisPlanId])(
    "rejects non-array analysis links %j rather than defaulting or coercing them",
    (linked_analyses) => {
      const result = TaskCardSchema.safeParse({ ...card, linked_analyses });
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.path)).toContainEqual(["linked_analyses"]);
    },
  );

  test("preserves unsorted duplicate analysis links without enforcing one-plan cardinality", () => {
    const input = {
      ...card,
      type: "sensitivity",
      source_base_commit: null,
      linked_analyses: ["PLAN-20261107T090000-a1b2", analysisPlanId, "PLAN-20261107T090000-a1b2"],
    };
    const before = JSON.stringify(input);
    expect(TaskCardSchema.parse(input)).toEqual({
      ...input,
      linked_changes: [],
      linked_verifications: [],
    });
    expect(JSON.stringify(input)).toBe(before);
  });
});
