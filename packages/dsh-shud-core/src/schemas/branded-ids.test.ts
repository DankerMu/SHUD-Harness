import { afterEach, describe, expect, test, vi } from "vitest";
import {
  BuildIdSchema,
  ChangeIdSchema,
  createBrandedId,
  DataIdSchema,
  DecisionIdSchema,
  JobRecordIdSchema,
  ReportIdSchema,
  RunIdSchema,
  StackIdSchema,
  TaskIdSchema,
  VerificationIdSchema,
} from "../index.ts";

const newIdentifiers = [
  ["TASK", TaskIdSchema, "TASK-20261027T080005-3f9c", "TASK-0001"],
  ["STACK", StackIdSchema, "STACK-20261027T080005-a1b2", "STACK-0001"],
  ["DATA", DataIdSchema, "DATA-20261027T081000-7d2e", "DATA-0001"],
  ["REPORT", ReportIdSchema, "REPORT-20261027T090000-5b10", "REPORT-0001"],
  ["DEC", DecisionIdSchema, "DEC-20261027T093012-c4e7", "DECISION-001"],
  ["CHG", ChangeIdSchema, "CHG-20261102T093000-4a1f", "CHG-0001"],
  ["VC", VerificationIdSchema, "VC-20261102T101500-0c3e", "VC-001"],
  ["BUILD", BuildIdSchema, "BUILD-20261102T100000-7b2d", "BUILD-1"],
] as const;

afterEach(() => vi.useRealTimers());

describe.each(newIdentifiers)("%s identifier", (prefix, schema, valid, legacy) => {
  test("accepts its branded lowercase identifier", () => {
    expect(schema.parse(valid)).toBe(valid);
  });

  test.each(["legacy", "uppercase hex", "wrong prefix"])("rejects %s", (kind) => {
    const invalid =
      kind === "legacy"
        ? legacy
        : kind === "uppercase hex"
          ? valid.toUpperCase()
          : valid.replace(prefix, "RUN");
    expect(schema.safeParse(invalid).success).toBe(false);
  });

  test.each(["../tasks/x", "nested/../id", "/absolute/id", "\0"])(
    "rejects path traversal and unsafe identifier %j",
    (value) => {
      expect(schema.safeParse(value).success).toBe(false);
      expect(schema.safeParse(`${valid}/${value}`).success).toBe(false);
    },
  );
});

test("data identifiers reject UUID-era values", () => {
  expect(DataIdSchema.safeParse("DATA-0f8fad5b-d9cb-469f-a165-70867728950e").success).toBe(false);
});

test.each([
  ...newIdentifiers.map(([prefix, schema]) => [prefix, schema] as const),
  ["JOB", JobRecordIdSchema],
  ["RUN", RunIdSchema],
] as const)("generates %s with UTC seconds and four lowercase hex digits", (prefix, schema) => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-27T10:00:05.987+02:00"));
  const id = createBrandedId(prefix);
  expect(id.startsWith(`${prefix}-20261027T080005-`)).toBe(true);
  expect(id.slice(prefix.length + 17)).toMatch(/^[0-9a-f]{4}$/u);
  expect(schema.parse(id)).toBe(id);
});
