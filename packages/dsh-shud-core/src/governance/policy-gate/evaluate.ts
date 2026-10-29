import { types as nodeUtilTypes } from "node:util";
import {
  type PolicyGateDecisionValidationError,
  PolicyGuardClassSchema,
  TOOL_PARAMETER_SCHEMA_RULE_ID,
  policyGateDecisionValidationError,
  validatePolicyGateRemediation,
} from "./parameter-schema.ts";
import {
  SPAWN_PROFILE_SUBSET_RULE_ID,
  SPAWN_DEPTH_LIMIT_RULE_ID,
  SPAWN_CONCURRENCY_LIMIT_RULE_ID,
} from "./spawn-rules.ts";
import type {
  PolicyGateContext,
  PolicyGateDecision,
  PolicyGateToolCall,
  PolicyGuardClass,
  PolicyRule,
  PolicyRuleDecision,
} from "./types.ts";

export const RESERVED_AUTHORITY_POLICY_RULE_IDS = Object.freeze([
  "raw-data-write",
  SPAWN_PROFILE_SUBSET_RULE_ID,
  SPAWN_DEPTH_LIMIT_RULE_ID,
  SPAWN_CONCURRENCY_LIMIT_RULE_ID,
  TOOL_PARAMETER_SCHEMA_RULE_ID,
] as const);

type PolicyGuardClassAliasRead =
  | { state: "missing" }
  | { state: "invalid"; fields: readonly string[] }
  | { state: "conflicting"; fields: readonly string[] }
  | { state: "valid"; guardClass: PolicyGuardClass; field: string };

type PolicyGuardClassAliasValueRead =
  { state: "missing" } | { state: "invalid" } | { state: "valid"; guardClass: PolicyGuardClass };

type ValidatedPolicyRuleMetadata = {
  rule: PolicyRule;
  ruleId: string;
  guardClass: PolicyGuardClass;
};

type PolicyRuleDecisionDataDescriptor = PropertyDescriptor & {
  value: unknown;
};

type PolicyRuleDecisionSnapshot = Record<string, unknown> & {
  decision?: unknown;
  reason?: unknown;
  remediation?: unknown;
  guardClass?: unknown;
  guard_class?: unknown;
};

export const EMPTY_POLICY_GATE_CONTEXT: PolicyGateContext = {
  rules: [],
};

const KNOWN_AUTHORITY_POLICY_RULE_IDS = new Set<string>(RESERVED_AUTHORITY_POLICY_RULE_IDS);

export function isReservedAuthorityPolicyRuleId(ruleId: string): boolean {
  return KNOWN_AUTHORITY_POLICY_RULE_IDS.has(ruleId);
}

export function isReservedAuthorityPolicyErrorId(errorId: string | undefined): boolean {
  return (
    errorId !== undefined &&
    RESERVED_AUTHORITY_POLICY_RULE_IDS.some(
      (ruleId) => errorId === ruleId || errorId.startsWith(`${ruleId}:`),
    )
  );
}

export function isReservedAuthorityPolicyRuleIdPrefixImpersonation(
  ruleId: string | undefined,
): boolean {
  return (
    ruleId !== undefined &&
    RESERVED_AUTHORITY_POLICY_RULE_IDS.some((reservedRuleId) =>
      ruleId.startsWith(`${reservedRuleId}:`),
    )
  );
}

export const isReservedAuthorityPolicyEvidenceId = isReservedAuthorityPolicyErrorId;

export function evaluatePolicyGate(
  call: PolicyGateToolCall,
  context: PolicyGateContext = EMPTY_POLICY_GATE_CONTEXT,
): PolicyGateDecision {
  const metadata = validatePolicyGateContextMetadata(context);

  for (const { rule, ruleId, guardClass } of metadata) {
    const result = snapshotPolicyRuleDecisionResult(ruleId, rule.evaluate(call, context));
    if (result.decision === "allow") {
      continue;
    }
    if (result.decision !== "deny") {
      throw invalidPolicyRuleDecisionSnapshot(ruleId, "decision");
    }

    const reason = validatePolicyRuleDenyReason(ruleId, result.reason);
    const remediation = validatePolicyGateRemediation(ruleId, result.remediation);
    const normalizedGuardClass = normalizePolicyRuleDenyGuardClass(ruleId, guardClass, result);
    return {
      decision: "deny",
      ruleId,
      reason,
      remediation,
      guardClass: normalizedGuardClass,
    };
  }

  return { decision: "allow" };
}

const POLICY_RULE_DENY_DECISION_SNAPSHOT_KEYS = Object.freeze([
  "reason",
  "remediation",
  "guardClass",
  "guard_class",
] as const);
const POLICY_RULE_REMEDIATION_SNAPSHOT_KEYS = Object.freeze([
  "next_action",
  "hint",
  "ref",
] as const);

function snapshotPolicyRuleDecisionResult(
  ruleId: string,
  result: unknown,
): PolicyRuleDecisionSnapshot {
  if (result === null || typeof result !== "object") {
    throw invalidPolicyRuleDecisionSnapshot(ruleId, "decision");
  }

  const objectResult = result;
  if (nodeUtilTypes.isProxy(objectResult)) {
    throw invalidPolicyRuleDecisionSnapshot(ruleId, "decision");
  }

  assertNoEnumerablePolicyRuleDecisionToJson(ruleId, objectResult);

  const snapshot = Object.create(null) as PolicyRuleDecisionSnapshot;
  snapshotPolicyRuleDecisionField(ruleId, objectResult, snapshot, "decision", "decision");
  if (snapshot.decision !== "deny") {
    return snapshot;
  }

  for (const key of POLICY_RULE_DENY_DECISION_SNAPSHOT_KEYS) {
    snapshotPolicyRuleDecisionField(ruleId, objectResult, snapshot, key, key);
  }

  if (Object.prototype.hasOwnProperty.call(snapshot, "remediation")) {
    snapshot.remediation = snapshotPolicyRuleRemediationCandidate(ruleId, snapshot.remediation);
  }

  return snapshot;
}

function assertNoEnumerablePolicyRuleDecisionToJson(ruleId: string, result: object): void {
  const descriptor = readPolicyRuleDecisionOwnDescriptor(ruleId, result, "toJSON", "toJSON");
  if (descriptor?.enumerable) {
    throw invalidPolicyRuleDecisionSnapshot(ruleId, "toJSON");
  }
}

function snapshotPolicyRuleDecisionField(
  ruleId: string,
  source: object,
  snapshot: PolicyRuleDecisionSnapshot | Record<string, unknown>,
  key: string,
  fieldPath: string,
): void {
  const descriptor = readPolicyRuleDecisionOwnDescriptor(ruleId, source, key, fieldPath);
  if (!descriptor) {
    return;
  }
  assertPolicyRuleDecisionDataDescriptor(ruleId, descriptor, fieldPath);
  snapshot[key] = descriptor.value;
}

function snapshotPolicyRuleRemediationCandidate(ruleId: string, remediation: unknown): unknown {
  if (remediation === null || typeof remediation !== "object") {
    return remediation;
  }

  const objectRemediation = remediation;
  if (nodeUtilTypes.isProxy(objectRemediation)) {
    throw invalidPolicyRuleDecisionSnapshot(ruleId, "remediation");
  }

  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of POLICY_RULE_REMEDIATION_SNAPSHOT_KEYS) {
    snapshotPolicyRuleDecisionField(ruleId, objectRemediation, snapshot, key, `remediation.${key}`);
  }
  return snapshot;
}

function readPolicyRuleDecisionOwnDescriptor(
  ruleId: string,
  source: object,
  key: string,
  fieldPath: string,
): PropertyDescriptor | undefined {
  try {
    return Object.getOwnPropertyDescriptor(source, key);
  } catch {
    throw invalidPolicyRuleDecisionSnapshot(ruleId, fieldPath);
  }
}

function assertPolicyRuleDecisionDataDescriptor(
  ruleId: string,
  descriptor: PropertyDescriptor,
  fieldPath: string,
): asserts descriptor is PolicyRuleDecisionDataDescriptor {
  if (!("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) {
    throw invalidPolicyRuleDecisionSnapshot(ruleId, fieldPath);
  }
}

function validatePolicyRuleDenyReason(ruleId: string, reason: unknown): string {
  if (typeof reason !== "string") {
    throw invalidPolicyRuleDecisionSnapshot(ruleId, "reason");
  }
  return reason;
}

function invalidPolicyRuleDecisionSnapshot(
  ruleId: string,
  fieldPath: string,
): PolicyGateDecisionValidationError {
  return policyGateDecisionValidationError(
    `Invalid policy gate decision for ${ruleId}: ${fieldPath}`,
  );
}

function normalizePolicyRuleDenyGuardClass(
  ruleId: string,
  ruleGuardClass: PolicyGuardClass,
  result: Pick<PolicyRuleDecisionSnapshot, "guardClass" | "guard_class">,
): PolicyGuardClass {
  const resultGuardClass = readPolicyGuardClassAliases(result);
  if (resultGuardClass.state === "missing") {
    return ruleGuardClass;
  }
  if (resultGuardClass.state === "invalid") {
    throw policyGateDecisionValidationError(
      `Policy gate guard_class lint failed: ${ruleId}: invalid result ${resultGuardClass.fields.join(", ")}.`,
    );
  }
  if (resultGuardClass.state === "conflicting") {
    throw policyGateDecisionValidationError(
      `Policy gate guard_class lint failed: ${ruleId}: conflicting result ${resultGuardClass.fields.join(", ")}.`,
    );
  }
  if (resultGuardClass.guardClass !== ruleGuardClass) {
    throw policyGateDecisionValidationError(
      `Policy gate guard_class lint failed: ${ruleId}: result ${resultGuardClass.field} ${resultGuardClass.guardClass} conflicts with rule guardClass ${ruleGuardClass}.`,
    );
  }

  return ruleGuardClass;
}

export function assertPolicyGateContextGuardClasses(context: PolicyGateContext): void {
  validatePolicyGateContextMetadata(context);
}

export function snapshotPolicyGateContext(context: PolicyGateContext): PolicyGateContext {
  const metadata = validatePolicyGateContextMetadata(context);
  const rules = metadata.map(({ rule, ruleId, guardClass }) => {
    const evaluate = rule.evaluate.bind(rule);
    return Object.freeze({
      ruleId,
      description: rule.description,
      guardClass,
      evaluate(call: PolicyGateToolCall, snapshotContext: PolicyGateContext): PolicyRuleDecision {
        return evaluate(call, snapshotContext);
      },
    });
  });

  return Object.freeze({
    rules: Object.freeze(rules),
  });
}

function validatePolicyGateContextMetadata(
  context: PolicyGateContext,
): ValidatedPolicyRuleMetadata[] {
  const ruleIdFailures: string[] = [];
  const guardClassFailures: string[] = [];
  const metadata: ValidatedPolicyRuleMetadata[] = [];
  const seenRuleIds = new Map<string, string>();

  context.rules.forEach((rule, index) => {
    const ruleLabel = formatPolicyRuleId(rule, index);
    const ruleId = normalizePolicyRuleId(rule.ruleId);
    if (!ruleId) {
      ruleIdFailures.push(`${ruleLabel}: ruleId must be a non-empty string`);
    } else {
      const previousRuleLabel = seenRuleIds.get(ruleId);
      if (previousRuleLabel) {
        ruleIdFailures.push(`${ruleId}: duplicate ruleId also used by ${previousRuleLabel}`);
      } else {
        seenRuleIds.set(ruleId, ruleLabel);
      }
      if (isReservedAuthorityPolicyRuleIdPrefixImpersonation(ruleId)) {
        ruleIdFailures.push(
          `${ruleId}: reserved authority policy rule prefixes are reserved for error_id`,
        );
      }
    }

    const guardClass = readPolicyGuardClassAliases(rule);
    if (guardClass.state === "missing" || guardClass.state === "invalid") {
      guardClassFailures.push(`${ruleLabel}: missing or invalid guardClass/guard_class`);
      return;
    }
    if (guardClass.state === "conflicting") {
      guardClassFailures.push(`${ruleLabel}: conflicting guardClass/guard_class`);
      return;
    }

    if (
      ruleId &&
      isReservedAuthorityPolicyRuleId(ruleId) &&
      guardClass.guardClass !== "authority"
    ) {
      guardClassFailures.push(
        `${ruleId}: known authority rule cannot be classified as ${guardClass.guardClass}`,
      );
      return;
    }

    if (ruleId) {
      metadata.push({ rule, ruleId, guardClass: guardClass.guardClass });
    }
  });

  if (ruleIdFailures.length > 0) {
    throw policyGateDecisionValidationError(
      `Policy gate ruleId lint failed: ${ruleIdFailures.join("; ")}.`,
    );
  }

  if (guardClassFailures.length > 0) {
    throw policyGateDecisionValidationError(
      `Policy gate guard_class lint failed: ${guardClassFailures.join("; ")}.`,
    );
  }

  return metadata;
}

function readPolicyGuardClassAliases(carrier: {
  guardClass?: unknown;
  guard_class?: unknown;
}): PolicyGuardClassAliasRead {
  const camelGuardClass = parsePolicyRuleGuardClassValue(carrier.guardClass);
  const snakeGuardClass = parsePolicyRuleGuardClassValue(carrier.guard_class);
  const invalidFields: string[] = [];
  if (camelGuardClass.state === "invalid") {
    invalidFields.push("guardClass");
  }
  if (snakeGuardClass.state === "invalid") {
    invalidFields.push("guard_class");
  }
  if (invalidFields.length > 0) {
    return { state: "invalid", fields: invalidFields };
  }

  if (camelGuardClass.state === "valid" && snakeGuardClass.state === "valid") {
    if (camelGuardClass.guardClass !== snakeGuardClass.guardClass) {
      return { state: "conflicting", fields: ["guardClass", "guard_class"] };
    }
    return {
      state: "valid",
      guardClass: camelGuardClass.guardClass,
      field: "guardClass/guard_class",
    };
  }
  if (camelGuardClass.state === "valid") {
    return {
      state: "valid",
      guardClass: camelGuardClass.guardClass,
      field: "guardClass",
    };
  }
  if (snakeGuardClass.state === "valid") {
    return {
      state: "valid",
      guardClass: snakeGuardClass.guardClass,
      field: "guard_class",
    };
  }

  return { state: "missing" };
}

function parsePolicyRuleGuardClassValue(value: unknown): PolicyGuardClassAliasValueRead {
  if (value === undefined) {
    return { state: "missing" };
  }
  const parsed = PolicyGuardClassSchema.safeParse(value);
  return parsed.success ? { state: "valid", guardClass: parsed.data } : { state: "invalid" };
}

function normalizePolicyRuleId(ruleId: unknown): string | undefined {
  if (typeof ruleId !== "string") {
    return undefined;
  }
  const trimmedRuleId = ruleId.trim();
  return trimmedRuleId === "" ? undefined : trimmedRuleId;
}

function formatPolicyRuleId(rule: Pick<PolicyRule, "ruleId">, index: number): string {
  return typeof rule.ruleId === "string" && rule.ruleId.trim() !== ""
    ? rule.ruleId
    : `<rule-${index}>`;
}
