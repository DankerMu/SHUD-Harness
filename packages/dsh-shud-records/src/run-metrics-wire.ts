import {
  classifyNumericalHealth,
  METRICS_METHOD_VERSION,
  type NumericalHealthVerdict,
  type RunRecord,
} from "@shud-harness/dsh-shud-core";
import { readShudInputFile, ShudInputError } from "./shud-input-file.ts";

export const FLOW_FIELDS = ["peak_flow_m3d", "peak_day", "total_runoff_m3"] as const;
export const WATER_FIELDS = [
  "P",
  "Qd",
  "AET",
  "delta_s_surf",
  "delta_s_us",
  "delta_s_gw",
  "delta_s_riv",
  "delta_s_snow",
  "delta_s_ic",
  "delta_s",
  "residual",
] as const;
export const HEALTH_FIELDS = [
  "water_balance_residual",
  "cvode_failures",
  "negative_state_count",
  "max_solver_dt",
] as const;
const VERDICT_FIELDS = [
  "water_balance_residual",
  "cvode_failures",
  "negative_state_count",
] as const;
export const NEGATIVE_STATE_NOTE = "SHUD 静默钳零，该值为下界";

type MetricBlock<K extends string> = Record<K, number | null> & {
  reasons: Record<K, string | null>;
};
export type RunMetricsHealth = RunRecord["numerical_health"];
export interface MetricsInput {
  path: string;
  sha256: string;
  size_bytes: number;
}
export interface RunMetrics {
  method_version: typeof METRICS_METHOD_VERSION;
  status: "ok" | "unavailable";
  reason: string | null;
  inputs: MetricsInput[];
  nonfinite_count: number;
  outlets: number[];
  flow: MetricBlock<(typeof FLOW_FIELDS)[number]>;
  water_balance: MetricBlock<(typeof WATER_FIELDS)[number]> & {
    formula_source: string;
    approximation: string;
  };
  numerical_health: MetricBlock<(typeof HEALTH_FIELDS)[number]> & {
    negative_state_count_note: string;
  };
  verdicts: Record<(typeof VERDICT_FIELDS)[number], NumericalHealthVerdict>;
}

/** Compare Unicode scalar values, not UTF-16 units or locale-dependent collation. */
export function compareMetricPaths(left: string, right: string): number {
  let a = 0;
  let b = 0;
  while (a < left.length && b < right.length) {
    const x = left.codePointAt(a)!;
    const y = right.codePointAt(b)!;
    if (x !== y) return x - y;
    a += x > 0xffff ? 2 : 1;
    b += y > 0xffff ? 2 : 1;
  }
  return (a < left.length ? 1 : 0) - (b < right.length ? 1 : 0);
}

/** Shared ordered field inventory also constructs honest pending/unavailable blocks. */
export function nullMetricBlock<K extends string>(
  fields: readonly K[],
  reason: string,
): MetricBlock<K> {
  const values = {} as Record<K, number | null>;
  const reasons = {} as Record<K, string | null>;
  for (const field of fields) {
    values[field] = null;
    reasons[field] = reason;
  }
  return { ...values, reasons };
}

function invalidShape(): never {
  throw new ShudInputError("parse", "metrics.json", "invalid metrics shape");
}

function strictObject(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalidShape();
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) invalidShape();
  return value as Record<string, unknown>;
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validateBlock(
  block: Record<string, unknown>,
  fields: readonly string[],
  unavailable: boolean,
): void {
  const reasons = strictObject(block.reasons, fields);
  for (const field of fields) {
    const value = block[field];
    if (value === null) {
      if (!nonempty(reasons[field])) invalidShape();
    } else if (
      unavailable ||
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      reasons[field] !== null
    )
      invalidShape();
  }
}

function validateRunMetrics(value: unknown): asserts value is RunMetrics {
  const document = strictObject(value, [
    "method_version",
    "status",
    "reason",
    "inputs",
    "nonfinite_count",
    "outlets",
    "flow",
    "water_balance",
    "numerical_health",
    "verdicts",
  ]);
  if (document.method_version !== METRICS_METHOD_VERSION) invalidShape();
  if (document.status !== "ok" && document.status !== "unavailable") invalidShape();
  const unavailable = document.status === "unavailable";
  if (unavailable ? !nonempty(document.reason) : document.reason !== null) invalidShape();
  if (!count(document.nonfinite_count)) invalidShape();
  if (!Array.isArray(document.inputs) || !Array.isArray(document.outlets)) invalidShape();
  const paths = new Set<string>();
  for (const input of document.inputs) {
    const entry = strictObject(input, ["path", "sha256", "size_bytes"]);
    if (
      typeof entry.path !== "string" ||
      entry.path.includes("\\") ||
      entry.path.includes("\0") ||
      entry.path.split("/").some((part) => part === "" || part === "." || part === "..") ||
      typeof entry.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(entry.sha256) ||
      !count(entry.size_bytes) ||
      paths.has(entry.path)
    )
      invalidShape();
    paths.add(entry.path);
  }
  const outlets = new Set<number>();
  for (const outlet of document.outlets) {
    if (typeof outlet !== "number" || !Number.isInteger(outlet) || outlets.has(outlet))
      invalidShape();
    outlets.add(outlet);
  }
  const flow = strictObject(document.flow, [...FLOW_FIELDS, "reasons"]);
  const water = strictObject(document.water_balance, [
    "formula_source",
    ...WATER_FIELDS,
    "reasons",
    "approximation",
  ]);
  const health = strictObject(document.numerical_health, [
    ...HEALTH_FIELDS,
    "reasons",
    "negative_state_count_note",
  ]);
  validateBlock(flow, FLOW_FIELDS, unavailable);
  validateBlock(water, WATER_FIELDS, unavailable);
  validateBlock(health, HEALTH_FIELDS, unavailable);
  if (!nonempty(water.formula_source) || !nonempty(water.approximation)) invalidShape();
  if (health.negative_state_count_note !== NEGATIVE_STATE_NOTE) invalidShape();
  for (const field of ["cvode_failures", "negative_state_count"] as const) {
    if (health[field] !== null && !count(health[field])) invalidShape();
  }
  if (health.max_solver_dt !== null) invalidShape();
  const verdicts = strictObject(document.verdicts, VERDICT_FIELDS);
  for (const field of VERDICT_FIELDS) {
    if (verdicts[field] !== classifyNumericalHealth(field, health[field] as number | null))
      invalidShape();
  }
}

function orderedBlock<K extends string>(
  block: MetricBlock<K>,
  fields: readonly K[],
): MetricBlock<K> {
  const values = {} as Record<K, number | null>;
  const reasons = {} as Record<K, string | null>;
  for (const field of fields) {
    values[field] = block[field];
    reasons[field] = block.reasons[field];
  }
  return { ...values, reasons };
}

/** Pure canonical JSON plus one LF; no host identity and no mutation of caller objects. */
export function serializeRunMetrics(value: RunMetrics): string {
  try {
    validateRunMetrics(value);
    const inputs = value.inputs.map(({ path, sha256, size_bytes }) => ({
      path,
      sha256,
      size_bytes,
    }));
    inputs.sort((left, right) => compareMetricPaths(left.path, right.path));
    return (
      JSON.stringify({
        method_version: value.method_version,
        status: value.status,
        reason: value.reason,
        inputs,
        nonfinite_count: value.nonfinite_count,
        outlets: [...value.outlets].sort((left, right) => left - right),
        flow: orderedBlock<(typeof FLOW_FIELDS)[number]>(value.flow, FLOW_FIELDS),
        water_balance: {
          formula_source: value.water_balance.formula_source,
          ...orderedBlock<(typeof WATER_FIELDS)[number]>(value.water_balance, WATER_FIELDS),
          approximation: value.water_balance.approximation,
        },
        numerical_health: {
          ...orderedBlock<(typeof HEALTH_FIELDS)[number]>(value.numerical_health, HEALTH_FIELDS),
          negative_state_count_note: value.numerical_health.negative_state_count_note,
        },
        verdicts: {
          water_balance_residual: value.verdicts.water_balance_residual,
          cvode_failures: value.verdicts.cvode_failures,
          negative_state_count: value.verdicts.negative_state_count,
        },
      }) + "\n"
    );
  } catch {
    // Also sanitize failures from malformed caller objects, never retain native causes.
    return invalidShape();
  }
}

/** The digest binds the same safe byte observation that is subsequently decoded. */
export function readRunMetrics(runDir: string, expectedSha256: string): RunMetrics {
  if (typeof expectedSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(expectedSha256)) {
    throw new ShudInputError("parse", "metrics.json", "invalid expected sha256 digest");
  }
  const observed = readShudInputFile(runDir, "metrics.json");
  if (observed.sha256 !== expectedSha256) {
    throw new ShudInputError("parse", "metrics.json", "sha256 digest mismatch");
  }
  try {
    const document: unknown = JSON.parse(observed.bytes.toString("utf8"));
    validateRunMetrics(document);
    return document;
  } catch {
    return invalidShape();
  }
}
