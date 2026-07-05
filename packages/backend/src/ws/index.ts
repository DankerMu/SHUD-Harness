import {
  assertTrustedRawDataToolFailedEventInput,
  isReservedRawDataDenialErrorId,
  RAW_DATA_WRITE_RULE_ID,
  type ErrorRecord,
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
  guardClass?: string;
  profileId?: string;
  invocationId?: string;
  eventId?: string;
  timestamp?: string;
}

export type RawDataAdvisoryToolFailedWsEventInput = RawDataToolFailedEventInput &
  Pick<ToolFailedWsEventInput, "seq" | "eventId" | "timestamp">;

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
    guard_class?: string;
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
  assertRawDataAdvisoryToolFailedWsEventInput(input);
  return buildToolFailedWsEventUnchecked(input);
}

function buildToolFailedWsEventUnchecked(input: ToolFailedWsEventInput): ToolFailedWsEvent {
  const timestamp = input.timestamp ?? new Date().toISOString();
  return {
    seq: input.seq,
    event_id: input.eventId ?? `tool.failed:${input.seq}`,
    type: "tool.failed",
    timestamp,
    payload: {
      tool_id: input.toolId,
      error: input.error,
      ...(input.rule ? { rule: input.rule } : {}),
      ...(input.decision ? { decision: input.decision } : {}),
      ...(input.guardClass ? { guard_class: input.guardClass } : {}),
      ...(input.profileId ? { profile_id: input.profileId } : {}),
      ...(input.invocationId ? { invocation_id: input.invocationId } : {})
    }
  };
}

function assertPublicToolFailedWsEventInput(input: ToolFailedWsEventInput): void {
  if (input.rule === RAW_DATA_WRITE_RULE_ID && isRawDataDenialDecision(input.decision)) {
    throw new Error(
      "Raw-data denial tool.failed events require the trusted raw-data advisory event builder."
    );
  }
  if (isReservedRawDataDenialErrorId(input.error.error_id)) {
    throw new Error(
      "Reserved raw-data denial error_id values require the trusted raw-data advisory event builder."
    );
  }
}

function assertRawDataAdvisoryToolFailedWsEventInput(
  input: RawDataAdvisoryToolFailedWsEventInput
): void {
  if (input.rule !== RAW_DATA_WRITE_RULE_ID || input.decision !== "denied_by_advisory") {
    throw new Error("Only trusted raw-data advisory denial events are supported.");
  }
  assertTrustedRawDataToolFailedEventInput(input);
}

function isRawDataDenialDecision(decision: string | undefined): boolean {
  return decision === "denied_by_advisory" || decision === "denied_by_sandbox";
}
