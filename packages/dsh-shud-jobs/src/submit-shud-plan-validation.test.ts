import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ShudJobRegistry, type SubmitShudRequest } from "./index.ts";
import {
  actualRegistry,
  submissionFixture,
  submissionProducer,
} from "./submit-shud/test-harness.ts";
import { PLAN_ID } from "./submit-shud-plan/test-harness.ts";

const digest = "a".repeat(64);
const bound = {
  analysis_plan_id: PLAN_ID,
  parameter_set_id: "PSET-2",
  calib_overrides: [{ key: "GEOL_KSATH", multiplier: 2 }],
  threads: 1,
  input_digests: { "tiny.cfg.calib": digest, "tiny.para.geol": digest },
};
const unbound = {
  analysis_plan_id: null,
  parameter_set_id: null,
  calib_overrides: [],
  input_digests: null,
};

/**
 * Each request points at a missing cwd and input_dir: a check that ran after the first
 * filesystem operation (realpath of cwd) would surface ENOENT instead of naming the field.
 */
async function rejectBeforeFilesystem(fields: Record<string, unknown>, reason: RegExp | null) {
  const h = await submissionFixture();
  const execution = submissionProducer();
  try {
    await h.apply(ShudJobRegistry, h.config);
    const registry = actualRegistry(h.ctx);
    const request = {
      ...h.request,
      cwd: join(h.root, "absent-workspace"),
      input_dir: join(h.root, "absent-input"),
      ...fields,
    } as unknown as SubmitShudRequest;
    const error: unknown = await registry.submitShud(request, execution.start).then(
      () => undefined,
      (rejection: unknown) => rejection,
    );
    expect(error).toBeInstanceOf(Error);
    const { message } = error as Error;
    if (reason === null) expect(message).toMatch(/ENOENT/u);
    else {
      expect(message).toMatch(reason);
      expect(message).not.toMatch(/ENOENT/u);
    }
    expect(await readdir(h.cwd)).not.toContain("runs");
    expect(registry.indexes.read()).toEqual({ active: [], completed: [] });
    expect(execution.handles).toEqual([]);
  } finally {
    await execution.finish();
    await h.dispose();
  }
}

test("a valid plan-bound request passes preflight and only then reaches the missing cwd", async () => {
  await rejectBeforeFilesystem(bound, null);
  await rejectBeforeFilesystem({ ...bound, calib_overrides: [] }, null);
  await rejectBeforeFilesystem(unbound, null);
  await rejectBeforeFilesystem({ threads: 2 }, null);
});

test.each([
  [
    "two overrides",
    { calib_overrides: [bound.calib_overrides[0], { key: "LC_ROUGH", multiplier: 0.5 }] },
    /calib_overrides/u,
  ],
  [
    "duplicate override key",
    { calib_overrides: [bound.calib_overrides[0], bound.calib_overrides[0]] },
    /calib_overrides/u,
  ],
  [
    "non-whitelisted SOIL_BETA",
    { calib_overrides: [{ key: "SOIL_BETA", multiplier: 2 }] },
    /calib_overrides/u,
  ],
  ["multiplier 1", { calib_overrides: [{ key: "GEOL_KSATH", multiplier: 1 }] }, /calib_overrides/u],
  ["multiplier 3", { calib_overrides: [{ key: "GEOL_KSATH", multiplier: 3 }] }, /calib_overrides/u],
  [
    "multiplier 0.49",
    { calib_overrides: [{ key: "GEOL_KSATH", multiplier: 0.49 }] },
    /calib_overrides/u,
  ],
  [
    "multiplier NaN",
    { calib_overrides: [{ key: "GEOL_KSATH", multiplier: NaN }] },
    /calib_overrides/u,
  ],
  [
    "multiplier Infinity",
    { calib_overrides: [{ key: "GEOL_KSATH", multiplier: Infinity }] },
    /calib_overrides/u,
  ],
  [
    "string multiplier",
    { calib_overrides: [{ key: "GEOL_KSATH", multiplier: "2" }] },
    /calib_overrides/u,
  ],
  [
    "extra override field",
    { calib_overrides: [{ key: "GEOL_KSATH", multiplier: 2, note: 1 }] },
    /calib_overrides/u,
  ],
  ["override object, not array", { calib_overrides: { GEOL_KSATH: 2 } }, /calib_overrides/u],
  [
    "overrides with null ids",
    { ...unbound, calib_overrides: bound.calib_overrides },
    /calib_overrides/u,
  ],
  [
    "overrides with omitted ids",
    { analysis_plan_id: undefined, parameter_set_id: undefined, input_digests: undefined },
    /calib_overrides/u,
  ],
  ["plan id without set id", { parameter_set_id: null }, /parameter_set_id/u],
  ["set id without plan id", { analysis_plan_id: null }, /analysis_plan_id/u],
  ["foreign brand plan id", { analysis_plan_id: "TASK-20261108T093000-5c1e" }, /analysis_plan_id/u],
  ["malformed plan id", { analysis_plan_id: "PLAN-1" }, /analysis_plan_id/u],
  ["set id out of range", { parameter_set_id: "PSET-6" }, /parameter_set_id/u],
  ["bound with null threads", { threads: null }, /threads/u],
  ["bound with omitted threads", { threads: undefined }, /threads/u],
  ["bound with null digests", { input_digests: null }, /input_digests/u],
  ["bound with omitted digests", { input_digests: undefined }, /input_digests/u],
  ["bound with empty digests", { input_digests: {} }, /input_digests/u],
  ["bound with array digests", { input_digests: [] }, /input_digests/u],
  [
    "parent traversal digest key",
    { input_digests: { "../tiny.cfg.calib": digest } },
    /input_digests/u,
  ],
  ["absolute digest key", { input_digests: { "/tiny.cfg.calib": digest } }, /input_digests/u],
  ["dot segment digest key", { input_digests: { "./tiny.cfg.calib": digest } }, /input_digests/u],
  [
    "empty segment digest key",
    { input_digests: { "nested//forcing.dat": digest } },
    /input_digests/u,
  ],
  [
    "uppercase digest value",
    { input_digests: { "tiny.cfg.calib": "A".repeat(64) } },
    /input_digests/u,
  ],
  ["short digest value", { input_digests: { "tiny.cfg.calib": "a".repeat(63) } }, /input_digests/u],
  [
    "unbound with digests",
    { ...unbound, input_digests: { "tiny.cfg.calib": digest } },
    /input_digests/u,
  ],
  ["unbound with empty digests", { ...unbound, input_digests: {} }, /input_digests/u],
])(
  "illegal internal request (%s) is rejected before any filesystem operation",
  async (_name, fields, reason) => {
    await rejectBeforeFilesystem({ ...bound, ...fields }, reason);
  },
);
