import {
  assertTrustedRawDataToolFailedEventInput,
  isReservedAuthorityPolicyRuleId,
  isReservedRawDataDenialErrorId,
  PolicyGuardClassSchema,
  rawDataDeniedToolResultToToolFailedEventInput,
  RAW_DATA_WRITE_RULE_ID,
  type ErrorRecord,
  type PolicyGuardClass,
  type RawDataToolFailedEventInput
} from "@shud-harness/core";

export const BACKEND_WS_NAMESPACE = "backend/ws" as const;

export type BackendWsNamespace = typeof BACKEND_WS_NAMESPACE;

export interface ToolFailedWsEventInput {
  seq: number;
  toolId: string;
  error: ErrorRecord;
  rule?: string;
  decision?: string;
  guardClass?: PolicyGuardClass;
  profileId?: string;
  invocationId?: string;
  eventId?: string;
  timestamp?: string;
}

export type RawDataAdvisoryToolFailedWsEventInput = Pick<
  ToolFailedWsEventInput,
  "seq" | "eventId" | "timestamp"
> & {
  toolResult: Parameters<typeof rawDataDeniedToolResultToToolFailedEventInput>[0];
};

export interface ToolFailedWsEvent {
  seq: number;
  event_id: string;
  type: "tool.failed";
  timestamp: string;
  payload: {
    tool_id: string;
    error: ErrorRecord;
    rule?: string;
    decision?: string;
    guard_class?: PolicyGuardClass;
    profile_id?: string;
    invocation_id?: string;
  };
}

export function buildToolFailedWsEvent(input: ToolFailedWsEventInput): ToolFailedWsEvent {
  assertPublicToolFailedWsEventInput(input);
  return buildToolFailedWsEventUnchecked(input);
}

export function buildRawDataAdvisoryToolFailedWsEvent(
  input: RawDataAdvisoryToolFailedWsEventInput
): ToolFailedWsEvent {
  const trustedInput = readRawDataAdvisoryToolFailedWsEventInput(input);
  return buildToolFailedWsEventUnchecked({
    seq: input.seq,
    eventId: input.eventId,
    timestamp: input.timestamp,
    ...trustedInput
  });
}

function buildToolFailedWsEventUnchecked(input: ToolFailedWsEventInput): ToolFailedWsEvent {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const error = cloneErrorRecord(input.error);
  return {
    seq: input.seq,
    event_id: input.eventId ?? `tool.failed:${input.seq}`,
    type: "tool.failed",
    timestamp,
    payload: {
      tool_id: input.toolId,
      error,
      ...(input.rule ? { rule: input.rule } : {}),
      ...(input.decision ? { decision: input.decision } : {}),
      ...(input.guardClass ? { guard_class: input.guardClass } : {}),
      ...(input.profileId ? { profile_id: input.profileId } : {}),
      ...(input.invocationId ? { invocation_id: input.invocationId } : {})
    }
  };
}

function assertPublicToolFailedWsEventInput(input: ToolFailedWsEventInput): void {
  if (isRawDataDenialDecision(input.decision)) {
    throw new Error(
      "Raw-data denial tool.failed events require the trusted raw-data advisory event builder."
    );
  }
  if (isReservedRawDataDenialErrorId(input.error.error_id)) {
    throw new Error(
      "Reserved raw-data denial error_id values require the trusted raw-data advisory event builder."
    );
  }
  const guardClass = readToolFailedGuardClass(input.guardClass);
  if (isRawDataAuthorityToolFailedEvent(input) && guardClass !== "authority") {
    throw new Error("Raw-data authority tool.failed events require guardClass authority.");
  }
  if (
    input.rule &&
    isReservedAuthorityPolicyRuleId(input.rule) &&
    guardClass !== "authority"
  ) {
    throw new Error(
      "Reserved authority policy rule tool.failed events require guardClass authority."
    );
  }
}

function readRawDataAdvisoryToolFailedWsEventInput(
  input: RawDataAdvisoryToolFailedWsEventInput
): RawDataToolFailedEventInput {
  const trustedInput = rawDataDeniedToolResultToToolFailedEventInput(input.toolResult);
  if (!trustedInput) {
    throw new Error(
      "Raw-data advisory tool.failed events require RawDataSandboxedBashTool trusted evidence."
    );
  }
  if (
    trustedInput.rule !== RAW_DATA_WRITE_RULE_ID ||
    trustedInput.decision !== "denied_by_advisory"
  ) {
    throw new Error("Only trusted raw-data advisory denial events are supported.");
  }
  assertTrustedRawDataToolFailedEventInput(trustedInput);
  return trustedInput;
}

function isRawDataDenialDecision(decision: string | undefined): boolean {
  return decision === "denied_by_advisory" || decision === "denied_by_sandbox";
}

function readToolFailedGuardClass(guardClass: unknown): PolicyGuardClass | undefined {
  if (guardClass === undefined) {
    return undefined;
  }
  const parsed = PolicyGuardClassSchema.safeParse(guardClass);
  if (!parsed.success) {
    throw new Error("tool.failed guardClass must be authority or capability.");
  }
  return parsed.data;
}

function isRawDataAuthorityToolFailedEvent(input: ToolFailedWsEventInput): boolean {
  return (
    input.rule === RAW_DATA_WRITE_RULE_ID || isRawDataAuthorityErrorId(input.error.error_id)
  );
}

function isRawDataAuthorityErrorId(errorId: string | undefined): boolean {
  return (
    errorId === RAW_DATA_WRITE_RULE_ID ||
    errorId?.startsWith(`${RAW_DATA_WRITE_RULE_ID}:`) === true
  );
}

function cloneErrorRecord(error: ErrorRecord): ErrorRecord {
  return {
    error_id: error.error_id,
    category: error.category,
    severity: error.severity,
    ...(error.task_id !== undefined ? { task_id: error.task_id } : {}),
    ...(error.job_id !== undefined ? { job_id: error.job_id } : {}),
    ...(error.run_id !== undefined ? { run_id: error.run_id } : {}),
    ...(error.report_id !== undefined ? { report_id: error.report_id } : {}),
    message: error.message,
    user_message: error.user_message,
    evidence_refs: [...error.evidence_refs],
    retryable: error.retryable,
    recommended_next_actions: [...error.recommended_next_actions],
    ...(error.remediation !== undefined ? { remediation: { ...error.remediation } } : {}),
    created_at: error.created_at
  };
}
