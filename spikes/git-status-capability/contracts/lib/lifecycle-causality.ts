type JsonRecord = Record<string, any>;

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonEmptyString);
}

export function validateLifecycleCausality(row: JsonRecord, cleanupAssertion: JsonRecord): boolean {
  if (!record(row.cleanup) || !exactKeys(row.cleanup, ["verdict", "descriptors_restored", "processes_reaped"]) ||
    !["pass", "fail"].includes(row.cleanup.verdict) || typeof row.cleanup.descriptors_restored !== "boolean" ||
    typeof row.cleanup.processes_reaped !== "boolean" ||
    (row.cleanup.verdict === "pass" && (!row.cleanup.descriptors_restored || !row.cleanup.processes_reaped))) return false;
  const causal = (firstCause: string, secondary: string[], cleanupVerdict: "pass" | "fail") =>
    row.first_cause === firstCause && Array.isArray(row.secondary_errors) &&
    JSON.stringify(row.secondary_errors) === JSON.stringify(secondary) && row.cleanup.verdict === cleanupVerdict &&
    cleanupAssertion.verdict === "pass" && (cleanupVerdict === "pass" || !row.cleanup.descriptors_restored || !row.cleanup.processes_reaped);
  if (row.row_verdict === "fail" && row.actual_producing_boundary === "launcher" &&
    record(row.failure_cause) && row.failure_cause.kind === "launcher-fault-v1" &&
    record(row.observer_outcome) && row.observer_outcome.kind === "rejected" && cleanupAssertion.verdict === "pass") {
    const code = row.observer_outcome.code;
    if (["SIGNALLED_TERM", "SIGNALLED_KILL", "TIMEOUT", "CLEANUP_FAILED"].includes(code)) {
      if (code === "CLEANUP_FAILED") return causal(code, [], "fail");
      return causal(code, row.cleanup.verdict === "fail" ? ["CLEANUP_FAILED"] : [], row.cleanup.verdict);
    }
  }
  if (row.row_id === "LIF-002") return causal("FRAME_VERSION_UNSUPPORTED", [], "pass");
  if (row.row_id === "LIF-006") return causal("FRAME_VERSION_UNSUPPORTED", ["CLEANUP_FAILED"], "fail");
  if (row.row_id === "LIF-007") return causal("CLEANUP_FAILED", [], "fail");
  if (row.first_cause !== undefined || row.secondary_errors !== undefined) {
    return false;
  }
  if (row.cleanup.verdict !== cleanupAssertion.verdict) return false;
  return row.first_cause === undefined && row.secondary_errors === undefined;
}
