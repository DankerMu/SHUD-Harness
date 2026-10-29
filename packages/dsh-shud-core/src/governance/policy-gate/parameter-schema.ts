import { z } from "zod";
import { RemediationNextActionSchema } from "../../schemas/index.ts";
import type { PolicyGateRemediation } from "./types.ts";

// Policy-gate denials require a navigable ref, even though generic ErrorRecord.ref is optional.
export const PolicyGateRemediationSchema = z.object({
  next_action: RemediationNextActionSchema,
  hint: z.string().min(1),
  ref: z.string().min(1),
});

export const PolicyGuardClassSchema = z.enum(["authority", "capability"]);
export const TOOL_PARAMETER_SCHEMA_RULE_ID = "tool-parameter-schema-validation";
export class PolicyGateDecisionValidationError extends Error {
  constructor(error: unknown) {
    super(formatPolicyGateDecisionValidationErrorMessage(error));
    this.name = "PolicyGateDecisionValidationError";
  }
}

export function isPolicyGateDecisionValidationError(
  error: unknown,
): error is PolicyGateDecisionValidationError {
  return error instanceof PolicyGateDecisionValidationError;
}

export function policyGateDecisionValidationError(
  message: string,
): PolicyGateDecisionValidationError {
  return new PolicyGateDecisionValidationError(message);
}

function formatPolicyGateDecisionValidationErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return String(error);
}

export function validatePolicyGateRemediation(
  ruleId: string,
  remediation: unknown,
): PolicyGateRemediation {
  const parsed = PolicyGateRemediationSchema.safeParse(remediation);
  if (parsed.success) {
    return parsed.data;
  }

  const fieldPaths = parsed.error.issues
    .map((issue) => issue.path.join("."))
    .filter((path) => path.length > 0)
    .join(", ");

  throw policyGateDecisionValidationError(
    `Invalid policy gate remediation for ${ruleId}: ${fieldPaths || "remediation"}`,
  );
}
