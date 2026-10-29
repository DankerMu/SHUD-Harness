import { inspect } from "node:util";
import { expect, vi } from "vitest";
import type { EvidenceReport, PiGateDecision } from "@shud-harness/dsh-shud-core";
import { ReportStateError } from "./index.ts";

// Literal expectations from the independently reviewed seven-state oracle.
// Terminal source fixtures carry matching evidence; archived inherits acceptance.
export const REPORT_SOURCES = [
  { status: "draft", historyOutcome: null, validation: "reviewed" },
  { status: "reviewed", historyOutcome: null, validation: null },
  { status: "awaiting_pi", historyOutcome: null, validation: null },
  { status: "accepted", historyOutcome: "accepted", validation: null },
  { status: "revision_requested", historyOutcome: "revision_requested", validation: null },
  { status: "rejected", historyOutcome: "rejected", validation: null },
  { status: "archived", historyOutcome: "accepted", validation: null },
] as const satisfies readonly {
  status: EvidenceReport["status"];
  historyOutcome: PiGateDecision["outcome"] | null;
  validation: "reviewed" | null;
}[];

export const DECISION_OUTCOMES = [
  "accepted",
  "rejected",
  "revision_requested",
] as const satisfies readonly PiGateDecision["outcome"][];

export const OBSERVED_AT = "2026-10-29T09:10:11.123Z";
export const PRIVATE_PAYLOAD = "private-decision-payload-442";

export function expectReportStateFailure(
  call: () => unknown,
  reason:
    | "invalid_decision"
    | "invalid_transition"
    | "report_id_mismatch"
    | "inconsistent_decision_history"
    | "unsupported_report_status"
    | "task_id_mismatch",
): void {
  let caught: unknown;
  try {
    call();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ReportStateError);
  expect(caught).toMatchObject({ reason });
  expect(caught).not.toHaveProperty("cause");
  expect(caught).not.toHaveProperty("issues");
  expect(caught).not.toHaveProperty("errors");
  for (const diagnostic of [inspect(caught, { depth: null }), JSON.stringify(caught)]) {
    for (const sentinel of [
      PRIVATE_PAYLOAD,
      "private-report-summary-440",
      "private-report-observation-440",
      "private-report-limitation-440",
      "private-report-question-440",
      "private-approval-reference-440",
      "private-decision-comment-440",
      "private-task-text-439",
    ]) {
      expect(diagnostic).not.toContain(sentinel);
    }
  }
}

export function expectRejectedWithoutClock(
  call: (now?: Date) => unknown,
  reason: Parameters<typeof expectReportStateFailure>[1],
): void {
  const now = new Date(OBSERVED_AT);
  const explicitClock = vi.spyOn(now, "toISOString");
  const wallNow = vi.spyOn(Date, "now");
  const wallClock = vi.spyOn(globalThis, "Date");
  try {
    expectReportStateFailure(() => call(now), reason);
    expectReportStateFailure(() => call(), reason);
    expect(explicitClock).not.toHaveBeenCalled();
    expect(wallNow).not.toHaveBeenCalled();
    expect(wallClock).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
  expect(now.toISOString()).toBe(OBSERVED_AT);
}

export function expectNoReportClock(call: () => void): void {
  const wallNow = vi.spyOn(Date, "now");
  const wallClock = vi.spyOn(globalThis, "Date");
  try {
    call();
    expect(wallNow).not.toHaveBeenCalled();
    expect(wallClock).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
}
