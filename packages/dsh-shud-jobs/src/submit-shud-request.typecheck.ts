// Checked by the normal jobs typecheck; excluded from emitting builds.
import type { AnalysisPlanId, RunJob } from "@shud-harness/dsh-shud-core";
import type { SubmitShudRequest } from "./index.ts";

declare const base: Pick<
  SubmitShudRequest,
  "cwd" | "input_dir" | "project" | "owner_session" | "llm"
>;
declare const planId: AnalysisPlanId;

const unbound: SubmitShudRequest = base;
const bound: SubmitShudRequest = {
  ...base,
  analysis_plan_id: planId,
  parameter_set_id: "PSET-2",
  calib_overrides: [{ key: "GEOL_KSATH", multiplier: 2 }],
  input_digests: { "ccw.cfg.calib": "0".repeat(64) },
  threads: 1,
};
const explicitNull: SubmitShudRequest = {
  ...base,
  analysis_plan_id: null,
  parameter_set_id: null,
  calib_overrides: [],
  input_digests: null,
};
const persistedSet: RunJob["parameter_set_id"] = bound.parameter_set_id ?? null;
// @ts-expect-error Plain strings are not analysis plan ids.
const plainPlan: SubmitShudRequest = { ...base, analysis_plan_id: "PLAN-20261108T093000-5c1e" };
const soilBeta: SubmitShudRequest = {
  ...base,
  // @ts-expect-error Only core calib whitelist keys can be overridden.
  calib_overrides: [{ key: "SOIL_BETA", multiplier: 2 }],
};
const textMultiplier: SubmitShudRequest = {
  ...base,
  // @ts-expect-error Multipliers are numbers.
  calib_overrides: [{ key: "LC_ROUGH", multiplier: "2" }],
};
// @ts-expect-error Digests map relative paths to hexadecimal strings.
const numericDigest: SubmitShudRequest = { ...base, input_digests: { "ccw.cfg.calib": 1 } };

export const checked = [
  unbound,
  bound,
  explicitNull,
  persistedSet,
  plainPlan,
  soilBeta,
  textMultiplier,
  numericDigest,
];
