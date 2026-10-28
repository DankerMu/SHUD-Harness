import { expect, test } from "vitest";
import { EvidenceReportSchema, PiGateDecisionSchema } from "../index.ts";

function validEvidenceReport() {
  return {
    report_id: "REPORT-20261027T090000-5b10",
    task_id: "TASK-20261027T080005-3f9c",
    status: "draft",
    summary: "Two ccw runs provide evidence from distinct stacks and inputs.",
    observations: ["Both runs produced output artifacts."],
    limitations: ["No scientific metrics were collected."],
    pi_questions: ["Should these runs proceed to scientific review?"],
    linked_runs: ["RUN-20261027T083000-b2c3", "RUN-20261027T082000-a1b2"],
    stack_ids: ["STACK-20261027T081500-b2c3", "STACK-20261027T080000-a1b2"],
    data_ids: ["DATA-20261027T081500-8e3f", "DATA-20261027T081000-7d2e"],
    llm_response_models: ["deepseek-flash-guan"],
    decision_history: [],
    created_at: "2026-10-27T09:00:00Z",
    updated_at: "2026-10-27T09:00:00Z",
  };
}

function validPiGateDecision() {
  return {
    decision_id: "DEC-20261027T093012-c4e7",
    report_id: "REPORT-20261027T090000-5b10",
    approval_ref: "call-report-submit-1",
    outcome: "accepted",
    comment: null,
    decided_at: "2026-10-27T09:30:12Z",
  };
}

test("EvidenceReport preserves multiple runs and every stack and data reference", () => {
  const report = validEvidenceReport();
  expect(EvidenceReportSchema.parse(report)).toEqual(report);
});

test("PiGateDecision accepts an accepted outcome with an explicit null comment", () => {
  const decision = validPiGateDecision();
  expect(PiGateDecisionSchema.parse(decision)).toEqual(decision);
});

test.each([
  ["stack_ids", "STACK-20261027T080000-a1b2"],
  ["data_ids", "DATA-20261027T081000-7d2e"],
  ["llm_response_models", "deepseek-flash-guan"],
])("EvidenceReport rejects duplicate %s entries", (field, value) => {
  const result = EvidenceReportSchema.safeParse({
    ...validEvidenceReport(),
    [field]: [value, value],
  });
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues.map((issue) => issue.path.join("."))).toContain(field);
  }
});

test.each([
  ["accepted", "Approved"],
  ["rejected", null],
  ["revision_requested", null],
])("PiGateDecision rejects outcome %s with comment %j", (outcome, comment) => {
  const result = PiGateDecisionSchema.safeParse({
    ...validPiGateDecision(),
    outcome,
    comment,
  });
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues.map((issue) => issue.path.join("."))).toContain("comment");
  }
});

test.each([
  "draft",
  "reviewed",
  "awaiting_pi",
  "accepted",
  "revision_requested",
  "rejected",
  "archived",
])("EvidenceReport accepts status %s without imposing a history state machine", (status) => {
  const report = { ...validEvidenceReport(), status };
  expect(EvidenceReportSchema.parse(report)).toEqual(report);
});

test("EvidenceReport accepts empty narrative arrays and decision history", () => {
  const report = {
    ...validEvidenceReport(),
    observations: [],
    limitations: [],
    pi_questions: [],
    decision_history: [],
  };
  expect(EvidenceReportSchema.parse(report)).toEqual(report);
});

test("EvidenceReport preserves repeated run references and caller model order", () => {
  const report = {
    ...validEvidenceReport(),
    linked_runs: ["RUN-20261027T083000-b2c3", "RUN-20261027T083000-b2c3"],
    llm_response_models: ["model-z", "model-a"],
  };
  expect(EvidenceReportSchema.parse(report)).toEqual(report);
});

test.each(["linked_runs", "stack_ids", "data_ids", "llm_response_models"])(
  "EvidenceReport rejects empty, null, and malformed %s arrays",
  (field) => {
    for (const value of [[], null, "not-an-array", [null], [42], [""]]) {
      expect(
        EvidenceReportSchema.safeParse({ ...validEvidenceReport(), [field]: value }).success,
      ).toBe(false);
    }
  },
);

test.each(["observations", "limitations", "pi_questions"])(
  "EvidenceReport rejects invalid %s narratives",
  (field) => {
    for (const value of [null, "not-an-array", [null], [42], [""]]) {
      expect(
        EvidenceReportSchema.safeParse({ ...validEvidenceReport(), [field]: value }).success,
      ).toBe(false);
    }
  },
);

test.each([
  ["report_id", "REPORT-0001"],
  ["report_id", "DEC-20261027T093012-c4e7"],
  ["task_id", "TASK-0001"],
  ["task_id", "REPORT-20261027T090000-5b10"],
  ["linked_runs", ["RUN-0001"]],
  ["linked_runs", ["JOB-20261027T083000-b2c3"]],
  ["stack_ids", ["STACK-0001"]],
  ["stack_ids", ["DATA-20261027T081000-7d2e"]],
  ["data_ids", ["DATA-0001"]],
  ["data_ids", ["STACK-20261027T080000-a1b2"]],
  ["status", "pi_reviewed"],
  ["status", "unknown"],
  ["decision_history", null],
  ["decision_history", [null]],
  ["decision_history", [{}]],
] as const)("EvidenceReport rejects invalid %s value %j", (field, value) => {
  expect(EvidenceReportSchema.safeParse({ ...validEvidenceReport(), [field]: value }).success).toBe(
    false,
  );
});

test.each(["report_id", "task_id", "status", "summary", "created_at", "updated_at"])(
  "EvidenceReport rejects empty or non-string %s",
  (field) => {
    for (const value of ["", null, 42]) {
      expect(
        EvidenceReportSchema.safeParse({ ...validEvidenceReport(), [field]: value }).success,
      ).toBe(false);
    }
  },
);

test.each(Object.keys(validEvidenceReport()))(
  "EvidenceReport requires an explicit defined %s",
  (field) => {
    const missing: Record<string, unknown> = { ...validEvidenceReport() };
    delete missing[field];
    expect(EvidenceReportSchema.safeParse(missing).success).toBe(false);
    expect(
      EvidenceReportSchema.safeParse({ ...validEvidenceReport(), [field]: undefined }).success,
    ).toBe(false);
  },
);

test("EvidenceReport rejects unknown root fields", () => {
  expect(EvidenceReportSchema.safeParse({ ...validEvidenceReport(), extra: true }).success).toBe(
    false,
  );
});

test("EvidenceReport preserves nonempty text without trimming or timestamp chronology", () => {
  const report = {
    ...validEvidenceReport(),
    summary: " ",
    observations: [" "],
    limitations: [" "],
    pi_questions: [" "],
    llm_response_models: [" "],
    created_at: "later",
    updated_at: "earlier",
  };
  expect(EvidenceReportSchema.parse(report)).toEqual(report);
});

test.each(["rejected", "revision_requested"])(
  "PiGateDecision accepts %s with a nonempty comment",
  (outcome) => {
    const decision = { ...validPiGateDecision(), outcome, comment: "Repeat the holdout run." };
    expect(PiGateDecisionSchema.parse(decision)).toEqual(decision);
  },
);

test.each(["accepted", "rejected", "revision_requested"])(
  "PiGateDecision rejects empty, missing, or undefined comments for %s",
  (outcome) => {
    for (const comment of ["", undefined, 42]) {
      const result = PiGateDecisionSchema.safeParse({
        ...validPiGateDecision(),
        outcome,
        comment,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.path.join("."))).toContain("comment");
      }
    }
    const missing: Record<string, unknown> = { ...validPiGateDecision(), outcome };
    delete missing.comment;
    const result = PiGateDecisionSchema.safeParse(missing);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toContain("comment");
    }
  },
);

test.each(Object.keys(validPiGateDecision()))(
  "PiGateDecision requires an explicit defined %s",
  (field) => {
    const missing: Record<string, unknown> = { ...validPiGateDecision() };
    delete missing[field];
    expect(PiGateDecisionSchema.safeParse(missing).success).toBe(false);
    expect(
      PiGateDecisionSchema.safeParse({ ...validPiGateDecision(), [field]: undefined }).success,
    ).toBe(false);
    for (const decision of [missing, { ...validPiGateDecision(), [field]: undefined }]) {
      const result = EvidenceReportSchema.safeParse({
        ...validEvidenceReport(),
        decision_history: [decision],
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.path)).toContainEqual([
          "decision_history",
          0,
          field,
        ]);
      }
    }
  },
);

test.each([
  ["decision_id", "DECISION-001"],
  ["decision_id", "REPORT-20261027T090000-5b10"],
  ["report_id", "REPORT-0001"],
  ["report_id", "DEC-20261027T093012-c4e7"],
  ["outcome", "approved"],
  ["outcome", "request_revision"],
])("PiGateDecision rejects invalid %s value %j", (field, value) => {
  expect(PiGateDecisionSchema.safeParse({ ...validPiGateDecision(), [field]: value }).success).toBe(
    false,
  );
});

test.each(["decision_id", "report_id", "approval_ref", "outcome", "decided_at"])(
  "PiGateDecision rejects empty or non-string %s",
  (field) => {
    for (const value of ["", null, 42]) {
      expect(
        PiGateDecisionSchema.safeParse({ ...validPiGateDecision(), [field]: value }).success,
      ).toBe(false);
    }
  },
);

test.each([
  "extra",
  "rejected_approval_ref",
  "gate_id",
  "task_id",
  "actor_user_id",
  "actor_role",
  "decision",
  "comment_required",
  "next_action",
  "evidence_refs",
  "idempotency_key",
  "created_at",
])("PiGateDecision rejects unknown or removed %s at both public boundaries", (field) => {
  const decision = { ...validPiGateDecision(), [field]: "legacy" };
  expect(PiGateDecisionSchema.safeParse(decision).success).toBe(false);
  expect(
    EvidenceReportSchema.safeParse({
      ...validEvidenceReport(),
      decision_history: [decision],
    }).success,
  ).toBe(false);
});

test.each([
  "2026-10-27",
  "2026-10-27T09:30:12",
  "2026-10-27T09:30:12+00:00",
  "2026-10-27T09:30:12+08:00",
  "2026-02-30T09:30:12Z",
  "2026-10-27T25:30:12Z",
  "not-a-timestamp",
])("PiGateDecision rejects non-UTC or invalid decided_at %j", (decided_at) => {
  expect(PiGateDecisionSchema.safeParse({ ...validPiGateDecision(), decided_at }).success).toBe(
    false,
  );
});

test("PiGateDecision preserves fractional UTC time and nonempty untrimmed text", () => {
  const decision = {
    ...validPiGateDecision(),
    outcome: "revision_requested",
    comment: " ",
    approval_ref: " ",
    decided_at: "2026-10-27T09:30:12.123Z",
  };
  expect(PiGateDecisionSchema.parse(decision)).toEqual(decision);
});

test("EvidenceReport validates nested comments at their decision history path", () => {
  const result = EvidenceReportSchema.safeParse({
    ...validEvidenceReport(),
    decision_history: [{ ...validPiGateDecision(), outcome: "rejected" }],
  });
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues.map((issue) => issue.path)).toContainEqual([
      "decision_history",
      0,
      "comment",
    ]);
  }
});

test("EvidenceReport preserves decision history without cross-record or chronology checks", () => {
  const report = {
    ...validEvidenceReport(),
    decision_history: [
      {
        ...validPiGateDecision(),
        report_id: "REPORT-20261027T090000-ffff",
        decided_at: "2026-10-28T09:30:12Z",
      },
      {
        ...validPiGateDecision(),
        outcome: "rejected",
        comment: "Earlier review.",
        decided_at: "2026-10-26T09:30:12Z",
      },
    ],
  };
  expect(EvidenceReportSchema.parse(report)).toEqual(report);
});

test("EvidenceReport rejects duplicate references without normalizing input", () => {
  const report = {
    ...validEvidenceReport(),
    stack_ids: ["STACK-20261027T080000-a1b2", "STACK-20261027T080000-a1b2"],
  };
  expect(EvidenceReportSchema.safeParse(report).success).toBe(false);
  expect(report.stack_ids).toEqual(["STACK-20261027T080000-a1b2", "STACK-20261027T080000-a1b2"]);
});

test.each([null, undefined, [], 42, "report"])(
  "Report and decision public schemas reject non-object input %j",
  (value) => {
    expect(EvidenceReportSchema.safeParse(value).success).toBe(false);
    expect(PiGateDecisionSchema.safeParse(value).success).toBe(false);
  },
);
