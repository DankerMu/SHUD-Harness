import { CONTROL_ASSERTION_IDS, DECISION_LIMIT_TOKENS } from "./frozen";
import { encodeFailureCauseTokenForRow, projectedFailureCauseTagForRow } from "./causal-proof";

type JsonRecord = Record<string, any>;

const KIND_TO_TOKEN = Object.freeze({ clean: "c", dirty: "d", rejected: "r" });
const BOUNDARY_TO_TOKEN = Object.freeze({ below: "b", exact: "e", exceeded: "x" });
const PRODUCER_TO_TOKEN = Object.freeze({ observer: "o", launcher: "l", tripwire: "t" });
const ALL_CONTROL_TOKEN = ((1 << CONTROL_ASSERTION_IDS.length) - 1).toString(16).padStart(2, "0");

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function encodeProjection(row: JsonRecord, determinismToken: string, requireRawCause: boolean): string {
  const expectedKind = KIND_TO_TOKEN[row.expected_outcome.kind as keyof typeof KIND_TO_TOKEN];
  const observedKind = KIND_TO_TOKEN[row.observer_outcome.kind as keyof typeof KIND_TO_TOKEN];
  const limitOrdinal = DECISION_LIMIT_TOKENS.indexOf(row.actual_resource_record.declared_limit);
  const boundary = BOUNDARY_TO_TOKEN[row.actual_resource_record.boundary_class as keyof typeof BOUNDARY_TO_TOKEN];
  const producer = PRODUCER_TO_TOKEN[row.actual_producing_boundary as keyof typeof PRODUCER_TO_TOKEN];
  if (!/^[0-4]$/.test(determinismToken) || !record(row.control_assertions) ||
    !exactKeys(row.control_assertions, CONTROL_ASSERTION_IDS)) throw new Error("invalid D8 projection source");
  let passedControlBits = 0;
  for (let index = 0; index < CONTROL_ASSERTION_IDS.length; index += 1) {
    const assertion = row.control_assertions[CONTROL_ASSERTION_IDS[index]!];
    if (!record(assertion) || !exactKeys(assertion, ["active", "verdict"]) || assertion.active !== true ||
      !["pass", "fail"].includes(assertion.verdict as string)) throw new Error("invalid D8 projection source");
    if (assertion.verdict === "pass") passedControlBits |= 1 << index;
  }
  const protectionPassed = row.control_assertions.protection.verdict === "pass";
  if (!expectedKind || !observedKind || limitOrdinal < 0 || !boundary || !producer ||
    typeof row.protection_set_equal !== "boolean" || row.protection_set_equal !== protectionPassed ||
    !record(row.cleanup) || !["pass", "fail"].includes(row.cleanup.verdict)) throw new Error("invalid D8 projection source");
  const projectedCause = projectedFailureCauseTagForRow(row);
  const failureCause = requireRawCause ? encodeFailureCauseTokenForRow(row) : projectedCause;
  if (failureCause === null || failureCause !== projectedCause) throw new Error("invalid D8 projection source");
  return [
    row.platform === "macos" ? "m" : row.platform === "linux" ? "l" : "",
    row.row_id, expectedKind, row.expected_outcome.code ?? "", observedKind, row.observer_outcome.code ?? "",
    row.row_verdict === "pass" ? "p" : row.row_verdict === "fail" ? "f" : "",
    row.observation_id, row.git_state_generation_digest, row.frame_digest, producer, ALL_CONTROL_TOKEN,
    passedControlBits.toString(16).padStart(2, "0"), row.protection_set_equal ? "1" : "0",
    row.cleanup.verdict === "pass" ? "p" : "f", String(limitOrdinal), boundary, determinismToken, failureCause
  ].join("\0");
}

export function encodeDecisionRowProjectionCore(row: JsonRecord, determinismToken: string): string {
  return encodeProjection(row, determinismToken, true);
}

export function encodeFormalDecisionRowProjectionCore(row: JsonRecord, determinismToken: string): string {
  return encodeProjection(row, determinismToken, false);
}
