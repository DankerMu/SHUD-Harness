import type {
  ErrorRecord,
  GuardClass,
  PolicyGateDecision,
  PolicyGateRemediation
} from "@shud-harness/core";

export const TOOL_FAILED_EVENT_TYPE = "tool.failed" as const;

export type WsEventSource =
  | "server"
  | "coordinator"
  | "repo_explorer"
  | "worker"
  | "coder"
  | "reviewer"
  | "job"
  | "tool"
  | "client";

export type WsEventVisibility = "user_visible" | "internal";

export interface WsEvent<TPayload> {
  seq: number;
  event_id: string;
  type: string;
  session_id: string;
  task_id?: string;
  workspace_id?: string;
  run_id?: string;
  job_id?: string;
  timestamp: string;
  source: WsEventSource;
  visibility: WsEventVisibility;
  payload: TPayload;
}

export type PolicyGateDeniedErrorRecord = ErrorRecord & {
  tool_id: string;
  rule_id: string;
  guard_class?: GuardClass;
};

export interface ToolFailedPolicyGatePayload {
  tool_id: string;
  rule_id: string;
  guard_class?: GuardClass;
  error: PolicyGateDeniedErrorRecord;
}

export type ToolFailedPolicyGateEvent = WsEvent<ToolFailedPolicyGatePayload> & {
  type: typeof TOOL_FAILED_EVENT_TYPE;
  source: "tool";
};

export interface BuildPolicyGateToolFailedEventInput {
  seq: number;
  event_id?: string;
  session_id: string;
  task_id?: string;
  workspace_id?: string;
  timestamp?: string;
  tool_id: string;
  decision: Extract<PolicyGateDecision, { decision: "deny" }>;
  error_id?: string;
}

export function buildPolicyGateToolFailedEvent(
  input: BuildPolicyGateToolFailedEventInput
): ToolFailedPolicyGateEvent {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const eventId = input.event_id ?? `EVT-${crypto.randomUUID()}`;
  const error = buildPolicyGateDeniedErrorRecord({
    error_id: input.error_id ?? `ERR-${eventId}`,
    tool_id: input.tool_id,
    rule_id: input.decision.ruleId,
    guard_class: input.decision.guard_class,
    reason: input.decision.reason,
    remediation: input.decision.remediation,
    timestamp
  });

  return {
    seq: input.seq,
    event_id: eventId,
    type: TOOL_FAILED_EVENT_TYPE,
    session_id: input.session_id,
    ...(input.task_id ? { task_id: input.task_id } : {}),
    ...(input.workspace_id ? { workspace_id: input.workspace_id } : {}),
    timestamp,
    source: "tool",
    visibility: "user_visible",
    payload: {
      tool_id: input.tool_id,
      rule_id: input.decision.ruleId,
      ...(input.decision.guard_class ? { guard_class: input.decision.guard_class } : {}),
      error
    }
  };
}

interface BuildPolicyGateDeniedErrorRecordInput {
  error_id: string;
  tool_id: string;
  rule_id: string;
  guard_class?: GuardClass;
  reason: string;
  remediation: PolicyGateRemediation;
  timestamp: string;
}

function buildPolicyGateDeniedErrorRecord(
  input: BuildPolicyGateDeniedErrorRecordInput
): PolicyGateDeniedErrorRecord {
  return {
    error_id: input.error_id,
    category: "permission_error",
    severity: "error",
    message: input.reason,
    user_message: "A policy gate denied this tool call before execution.",
    evidence_refs: [],
    retryable: false,
    recommended_next_actions: [input.remediation.hint],
    remediation: input.remediation,
    created_at: input.timestamp,
    tool_id: input.tool_id,
    rule_id: input.rule_id,
    ...(input.guard_class ? { guard_class: input.guard_class } : {})
  };
}
