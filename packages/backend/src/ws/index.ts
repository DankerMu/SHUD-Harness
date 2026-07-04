import type { ErrorRecord } from "@shud-harness/core";

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
  ts?: string;
}

export interface ToolFailedWsEvent {
  seq: number;
  event_id: string;
  type: "tool.failed";
  ts: string;
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
  const ts = input.ts ?? new Date().toISOString();
  return {
    seq: input.seq,
    event_id: input.eventId ?? `tool.failed:${input.seq}`,
    type: "tool.failed",
    ts,
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
