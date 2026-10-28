import { describe, expect, expectTypeOf, test } from "vitest";
import {
  TaskCardSchema,
  type DataId,
  type JobRecordId,
  type ReportId,
  type StackId,
  type TaskId,
} from "../index.ts";

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

describe("TaskCard branded references", () => {
  test("accepts a new card with explicit null references and empty links", () => {
    const input = { ...card, stack_id: null, data_id: null, linked_jobs: [], linked_reports: [] };
    const parsed = TaskCardSchema.parse(input);
    expect(parsed).toEqual(input);
    expectTypeOf(parsed.task_id).toEqualTypeOf<TaskId>();
    expectTypeOf(parsed.stack_id).toEqualTypeOf<StackId | null>();
    expectTypeOf(parsed.data_id).toEqualTypeOf<DataId | null>();
    expectTypeOf(parsed.linked_jobs).toEqualTypeOf<JobRecordId[]>();
    expectTypeOf(parsed.linked_reports).toEqualTypeOf<ReportId[]>();
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
      expect(TaskCardSchema.parse(input)).toEqual(input);
    },
  );

  test("keeps reviewer, optional theory bundles and root/nested unknown-key stripping", () => {
    const input = { ...card, stack_id: null, data_id: null };
    expect(
      TaskCardSchema.parse({
        ...input,
        client_trace_id: "not stored",
        inference_budget: { ...input.inference_budget, extra: true },
      }),
    ).toEqual(input);
  });
});
