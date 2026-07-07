import {
  assertTrustedRawDataToolFailedEventInput,
  ErrorRemediationSchema,
  ErrorRecordSchema,
  isReservedAuthorityPolicyErrorId,
  isReservedAuthorityPolicyRuleId,
  isReservedAuthorityPolicyRuleIdPrefixImpersonation,
  isReservedRawDataDenialErrorId,
  PolicyGuardClassSchema,
  rawDataDeniedToolResultToToolFailedEventInput,
  RAW_DATA_WRITE_RULE_ID,
  type ErrorRecord,
  type PolicyGuardClass,
  type RawDataToolFailedEventInput
} from "@shud-harness/core";
import { types as nodeUtilTypes } from "node:util";

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

type ToolFailedWsEventIdentity = {
  errorId: string;
  rule?: string;
  decision?: string;
  guardClass?: PolicyGuardClass;
};

type ToolFailedWsSnapshotState = {
  stringChars: number;
};

type ToolFailedWsDataDescriptor = PropertyDescriptor & {
  value: unknown;
};

const TOOL_FAILED_WS_MAX_ARRAY_LENGTH = 1_024;
const TOOL_FAILED_WS_MAX_STRING_CHARS = 131_072;

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
  const snapshot = snapshotToolFailedWsEventInput(input);
  return buildToolFailedWsEventUnchecked(snapshot);
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

function snapshotToolFailedWsEventInput(input: ToolFailedWsEventInput): ToolFailedWsEventInput {
  const state: ToolFailedWsSnapshotState = { stringChars: 0 };
  const inputRecord = readToolFailedWsRecord(input, "tool.failed input");
  const errorInput = readRequiredToolFailedWsRecordField(
    inputRecord,
    "error",
    "tool.failed error"
  );
  const errorRecord = readToolFailedWsRecord(errorInput, "tool.failed error");
  const identity = snapshotToolFailedWsEventIdentity(inputRecord, errorRecord, state);
  assertPublicToolFailedWsEventIdentity(identity);

  const seq = readRequiredToolFailedWsNumberField(inputRecord, "seq", "tool.failed seq");
  const toolId = readRequiredToolFailedWsStringField(
    inputRecord,
    "toolId",
    "tool.failed toolId",
    state
  );
  const error = cloneErrorRecord(errorRecord, state);
  const profileId = readOptionalToolFailedWsStringField(
    inputRecord,
    "profileId",
    "tool.failed profileId",
    state
  );
  const invocationId = readOptionalToolFailedWsStringField(
    inputRecord,
    "invocationId",
    "tool.failed invocationId",
    state
  );
  const eventId = readOptionalToolFailedWsStringField(
    inputRecord,
    "eventId",
    "tool.failed eventId",
    state
  );
  const timestamp = readOptionalToolFailedWsStringField(
    inputRecord,
    "timestamp",
    "tool.failed timestamp",
    state
  );

  const snapshot = {
    seq,
    toolId,
    error,
    ...(identity.rule !== undefined ? { rule: identity.rule } : {}),
    ...(identity.decision !== undefined ? { decision: identity.decision } : {}),
    ...(identity.guardClass !== undefined ? { guardClass: identity.guardClass } : {}),
    ...(profileId !== undefined ? { profileId } : {}),
    ...(invocationId !== undefined ? { invocationId } : {}),
    ...(eventId !== undefined ? { eventId } : {}),
    ...(timestamp !== undefined ? { timestamp } : {})
  };

  assertPublicToolFailedWsEventInput(snapshot);
  return snapshot;
}

function snapshotToolFailedWsEventIdentity(
  input: object,
  error: object,
  state: ToolFailedWsSnapshotState
): ToolFailedWsEventIdentity {
  const errorId = readRequiredToolFailedWsStringField(
    error,
    "error_id",
    "tool.failed error.error_id",
    state
  );
  const rule = readOptionalToolFailedWsStringField(input, "rule", "tool.failed rule", state);
  const decision = readOptionalToolFailedWsStringField(
    input,
    "decision",
    "tool.failed decision",
    state
  );
  const guardClass = readToolFailedGuardClass(
    readOptionalToolFailedWsDataField(input, "guardClass", "tool.failed guardClass")
  );

  return {
    errorId,
    ...(rule !== undefined ? { rule } : {}),
    ...(decision !== undefined ? { decision } : {}),
    ...(guardClass !== undefined ? { guardClass } : {})
  };
}

function assertPublicToolFailedWsEventInput(input: ToolFailedWsEventInput): void {
  assertPublicToolFailedWsEventIdentity({
    errorId: input.error.error_id,
    ...(input.rule !== undefined ? { rule: input.rule } : {}),
    ...(input.decision !== undefined ? { decision: input.decision } : {}),
    ...(input.guardClass !== undefined ? { guardClass: input.guardClass } : {})
  });
}

function assertPublicToolFailedWsEventIdentity(identity: ToolFailedWsEventIdentity): void {
  if (isRawDataDenialDecision(identity.decision)) {
    throw new Error(
      "Raw-data denial tool.failed events require the trusted raw-data advisory event builder."
    );
  }
  if (isReservedRawDataDenialErrorId(identity.errorId)) {
    throw new Error(
      "Reserved raw-data denial error_id values require the trusted raw-data advisory event builder."
    );
  }
  if (isReservedAuthorityPolicyRuleIdPrefixImpersonation(identity.rule)) {
    throw new Error("Reserved authority policy rule prefixes are reserved for error_id.");
  }
  if (isReservedAuthorityPolicyToolFailedEvent(identity)) {
    if (identity.guardClass !== "authority") {
      if (isRawDataAuthorityToolFailedEvent(identity)) {
        throw new Error("Raw-data authority tool.failed events require guardClass authority.");
      }
      throw new Error(
        "Reserved authority policy rule tool.failed events require guardClass authority."
      );
    }
    if (isRawDataAuthorityToolFailedEvent(identity)) {
      throw new Error("Raw-data authority tool.failed events require trusted producer evidence.");
    }
    throw new Error(
      "Reserved authority policy tool.failed events require trusted producer evidence."
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

function isRawDataAuthorityToolFailedEvent(input: ToolFailedWsEventIdentity): boolean {
  return (
    input.rule === RAW_DATA_WRITE_RULE_ID || isRawDataAuthorityErrorId(input.errorId)
  );
}

function isReservedAuthorityPolicyToolFailedEvent(input: ToolFailedWsEventIdentity): boolean {
  return (
    isReservedAuthorityPolicyRuleId(input.rule ?? "") ||
    isReservedAuthorityPolicyErrorId(input.errorId)
  );
}

function isRawDataAuthorityErrorId(errorId: string | undefined): boolean {
  return (
    errorId === RAW_DATA_WRITE_RULE_ID ||
    errorId?.startsWith(`${RAW_DATA_WRITE_RULE_ID}:`) === true
  );
}

function cloneErrorRecord(
  error: ErrorRecord | object,
  state: ToolFailedWsSnapshotState = { stringChars: 0 }
): ErrorRecord {
  const errorRecord = readToolFailedWsRecord(error, "tool.failed error");
  const snapshot = {
    error_id: readRequiredToolFailedWsStringField(
      errorRecord,
      "error_id",
      "tool.failed error.error_id",
      state
    ),
    category: readRequiredToolFailedWsStringField(
      errorRecord,
      "category",
      "tool.failed error.category",
      state
    ),
    severity: readRequiredToolFailedWsStringField(
      errorRecord,
      "severity",
      "tool.failed error.severity",
      state
    ),
    ...readOptionalErrorRecordStringField(
      errorRecord,
      "task_id",
      "tool.failed error.task_id",
      state
    ),
    ...readOptionalErrorRecordStringField(
      errorRecord,
      "job_id",
      "tool.failed error.job_id",
      state
    ),
    ...readOptionalErrorRecordStringField(
      errorRecord,
      "run_id",
      "tool.failed error.run_id",
      state
    ),
    ...readOptionalErrorRecordStringField(
      errorRecord,
      "report_id",
      "tool.failed error.report_id",
      state
    ),
    message: readRequiredToolFailedWsStringField(
      errorRecord,
      "message",
      "tool.failed error.message",
      state
    ),
    user_message: readRequiredToolFailedWsStringField(
      errorRecord,
      "user_message",
      "tool.failed error.user_message",
      state
    ),
    evidence_refs: readToolFailedWsStringArrayField(
      errorRecord,
      "evidence_refs",
      "tool.failed error.evidence_refs",
      state
    ),
    retryable: readRequiredToolFailedWsBooleanField(
      errorRecord,
      "retryable",
      "tool.failed error.retryable"
    ),
    recommended_next_actions: readToolFailedWsStringArrayField(
      errorRecord,
      "recommended_next_actions",
      "tool.failed error.recommended_next_actions",
      state
    ),
    ...readOptionalErrorRecordRemediation(errorRecord, state),
    created_at: readRequiredToolFailedWsStringField(
      errorRecord,
      "created_at",
      "tool.failed error.created_at",
      state
    )
  };
  const parsed = ErrorRecordSchema.safeParse(snapshot);
  if (!parsed.success) {
    throw new Error("tool.failed error must match ErrorRecord schema.");
  }
  return parsed.data;
}

function readOptionalErrorRecordStringField(
  carrier: object,
  key: "task_id" | "job_id" | "run_id" | "report_id",
  label: string,
  state: ToolFailedWsSnapshotState
): Partial<Pick<ErrorRecord, "task_id" | "job_id" | "run_id" | "report_id">> {
  const value = readOptionalToolFailedWsStringField(carrier, key, label, state);
  return value !== undefined ? { [key]: value } : {};
}

function readOptionalErrorRecordRemediation(
  carrier: object,
  state: ToolFailedWsSnapshotState
): Pick<ErrorRecord, "remediation"> | Record<string, never> {
  const value = readOptionalToolFailedWsDataField(
    carrier,
    "remediation",
    "tool.failed error.remediation"
  );
  if (value === undefined) {
    return {};
  }
  const remediation = readToolFailedWsRecord(value, "tool.failed error.remediation");
  const snapshot = {
    next_action: readRequiredToolFailedWsStringField(
      remediation,
      "next_action",
      "tool.failed error.remediation.next_action",
      state
    ),
    hint: readRequiredToolFailedWsStringField(
      remediation,
      "hint",
      "tool.failed error.remediation.hint",
      state
    ),
    ...readOptionalRemediationRef(remediation, state)
  };
  const parsed = ErrorRemediationSchema.safeParse(snapshot);
  if (!parsed.success) {
    throw new Error("tool.failed error.remediation must match ErrorRecord remediation schema.");
  }
  return {
    remediation: parsed.data
  };
}

function readOptionalRemediationRef(
  remediation: object,
  state: ToolFailedWsSnapshotState
): { ref: string } | Record<string, never> {
  const ref = readOptionalToolFailedWsStringField(
    remediation,
    "ref",
    "tool.failed error.remediation.ref",
    state
  );
  return ref !== undefined ? { ref } : {};
}

function readToolFailedWsRecord(value: unknown, label: string): object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object.`);
  }
  if (nodeUtilTypes.isProxy(value)) {
    throw new Error(`${label} must be stable structured data.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object.`);
  }
  return value;
}

function readRequiredToolFailedWsRecordField(
  carrier: object,
  key: string,
  label: string
): object {
  return readToolFailedWsRecord(readRequiredToolFailedWsDataField(carrier, key, label), label);
}

function readRequiredToolFailedWsStringField(
  carrier: object,
  key: string,
  label: string,
  state: ToolFailedWsSnapshotState
): string {
  const value = readRequiredToolFailedWsDataField(carrier, key, label);
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  addToolFailedWsStringBudget(value.length, state);
  return value;
}

function readOptionalToolFailedWsStringField(
  carrier: object,
  key: string,
  label: string,
  state: ToolFailedWsSnapshotState
): string | undefined {
  const value = readOptionalToolFailedWsDataField(carrier, key, label);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  addToolFailedWsStringBudget(value.length, state);
  return value;
}

function readRequiredToolFailedWsNumberField(
  carrier: object,
  key: string,
  label: string
): number {
  const value = readRequiredToolFailedWsDataField(carrier, key, label);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
  return value;
}

function readRequiredToolFailedWsBooleanField(
  carrier: object,
  key: string,
  label: string
): boolean {
  const value = readRequiredToolFailedWsDataField(carrier, key, label);
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean.`);
  }
  return value;
}

function readToolFailedWsStringArrayField(
  carrier: object,
  key: string,
  label: string,
  state: ToolFailedWsSnapshotState
): string[] {
  const value = readRequiredToolFailedWsDataField(carrier, key, label);
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be a string array.`);
  }
  if (nodeUtilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be an ordinary string array.`);
  }
  if (value.length > TOOL_FAILED_WS_MAX_ARRAY_LENGTH) {
    throw new Error(`${label} exceeds array length budget.`);
  }
  const copy: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = readToolFailedWsDataDescriptor(value, String(index), label);
    if (!descriptor || typeof descriptor.value !== "string") {
      throw new Error(`${label} must contain only strings.`);
    }
    addToolFailedWsStringBudget(descriptor.value.length, state);
    copy.push(descriptor.value);
  }
  return copy;
}

function readRequiredToolFailedWsDataField(
  carrier: object,
  key: string,
  label: string
): unknown {
  const value = readOptionalToolFailedWsDataField(carrier, key, label);
  if (value === undefined) {
    throw new Error(`${label} is required.`);
  }
  return value;
}

function readOptionalToolFailedWsDataField(
  carrier: object,
  key: string,
  label: string
): unknown {
  const descriptor = readToolFailedWsDataDescriptor(carrier, key, label);
  return descriptor?.value;
}

function readToolFailedWsDataDescriptor(
  carrier: object,
  key: string,
  label: string
): ToolFailedWsDataDescriptor | undefined {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(carrier, key);
  } catch {
    throw new Error(`${label} must be stable structured data.`);
  }
  if (!descriptor) {
    return undefined;
  }
  if (!("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) {
    throw new Error(`${label} must be a data field.`);
  }
  return descriptor as ToolFailedWsDataDescriptor;
}

function addToolFailedWsStringBudget(
  length: number,
  state: ToolFailedWsSnapshotState
): void {
  state.stringChars += length;
  if (state.stringChars > TOOL_FAILED_WS_MAX_STRING_CHARS) {
    throw new Error("tool.failed input exceeds string budget.");
  }
}
