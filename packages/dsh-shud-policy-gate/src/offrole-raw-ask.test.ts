import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createPolicyHarness } from "./test-harness.ts";

// #713 option B (ADR-0016): raw-guard, policy-gate and role-restrict are mounted in the
// profile insert order, and the restricted tools are real ToolRuntime registrations.
// Independent oracles: the raw-data-guard provenance reason as written in the spec, and the
// RFC 1321 known answer md5("abc").
const RAW_PROVENANCE_REASON = "Reading raw data requires PI approval (provenance rule).";
const RAW_SAMPLE_MD5 = "900150983cd24fb0d6963f7d28e17f72";
const RAW_DIR = "raw-sample";
const OUTCOMES = ["allowed-once", "rejected"] as const;

async function md5(path: string) {
  return createHash("md5")
    .update(await readFile(path))
    .digest("hex");
}

async function rawChain(preset: string, approval: (typeof OUTCOMES)[number]) {
  const h = await createPolicyHarness({ preset, approval, rawDirs: [RAW_DIR], restrict: true });
  const sample = join(h.cwd, RAW_DIR, "sample.csv");
  await mkdir(join(h.cwd, RAW_DIR));
  await writeFile(sample, "abc");
  expect(await md5(sample)).toBe(RAW_SAMPLE_MD5);
  return { h, sample, surface: () => h.tools.schemas(h.agent).map((schema) => schema.name) };
}

const OFF_ROLE = [
  { preset: "worker", tool: "analysis_create" },
  { preset: "coder", tool: "analysis_create" },
  { preset: "reviewer", tool: "analysis_create" },
  { preset: "coordinator", tool: "shud_run" },
] as const;

test.each(OFF_ROLE)(
  "off-role $preset $tool with raw input_dir is denied by role without a card",
  async ({ preset, tool }) => {
    const { h, sample, surface } = await rawChain(preset, "allowed-once");
    try {
      // Registered globally and hidden only by the role mask, not merely absent.
      expect(h.tools.schemas().map((schema) => schema.name)).toContain(tool);
      expect(surface()).not.toContain(tool);
      const result = await h.call(tool, { input_dir: `${RAW_DIR}/` });
      expect(result).toMatchObject({
        isError: true,
        error: { message: `Role ${preset} cannot call tool ${tool}.` },
      });
      expect(h.request).not.toHaveBeenCalled();
      expect(h.logs).toEqual([
        { name: "shud-raw-guard", args: [`next ${tool} role-deferred`] },
        { name: "shud-policy-gate", args: [`deny ${tool} role-tool-surface`] },
      ]);
      expect(h.executions).toEqual([]);
      expect(await md5(sample)).toBe(RAW_SAMPLE_MD5);
    } finally {
      await h.dispose();
    }
  },
);

test("off-role coordinator bash raw write is denied as raw-immutable before any role check", async () => {
  const { h, sample, surface } = await rawChain("coordinator", "allowed-once");
  try {
    expect(surface()).not.toContain("bash");
    h.stateOf.mockClear();
    const result = await h.call("bash", { command: `echo x > ${RAW_DIR}/sample.csv` });
    expect(result.isError).toBe(true);
    if (!result.isError) throw new Error("Raw write unexpectedly executed");
    expect(result.error.message).toContain("immutable");
    expect(h.stateOf).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
    expect(h.logs).toEqual([{ name: "shud-raw-guard", args: ["deny bash raw-immutable"] }]);
    expect(h.executions).toEqual([]);
    expect(await md5(sample)).toBe(RAW_SAMPLE_MD5);
  } finally {
    await h.dispose();
  }
});

test.each(
  [
    { preset: "worker", tool: "shud_run" },
    { preset: "coordinator", tool: "analysis_create" },
  ].flatMap((call) => OUTCOMES.map((approval) => ({ ...call, approval }))),
)(
  "on-role $preset $tool with raw input_dir keeps the provenance ask ($approval)",
  async ({ preset, tool, approval }) => {
    const { h, sample, surface } = await rawChain(preset, approval);
    try {
      expect(surface()).toContain(tool);
      const input = { input_dir: `${RAW_DIR}/` };
      const result = await h.call(tool, input);
      expect(h.request).toHaveBeenCalledTimes(1);
      expect(h.request.mock.calls[0][0].reason).toBe(RAW_PROVENANCE_REASON);
      expect(h.policyLogs()).toEqual([]);
      if (approval === "allowed-once") {
        expect(result).toMatchObject({ isError: false, value: "executed" });
        expect(h.executions).toEqual([{ name: tool, arguments: input }]);
      } else {
        expect(result.isError).toBe(true);
        if (!result.isError) throw new Error(`Rejected ${tool} unexpectedly executed`);
        expect(result.error.message).toMatch(/rejected/iu);
        expect(h.executions).toEqual([]);
      }
      expect(await md5(sample)).toBe(RAW_SAMPLE_MD5);
    } finally {
      await h.dispose();
    }
  },
);

test("off-role coordinator shud_run with ordinary input_dir is denied by role without a card", async () => {
  const { h, sample } = await rawChain("coordinator", "allowed-once");
  try {
    const result = await h.call("shud_run", { input_dir: "ordinary-input" });
    expect(result).toMatchObject({
      isError: true,
      error: { message: "Role coordinator cannot call tool shud_run." },
    });
    expect(h.request).not.toHaveBeenCalled();
    expect(h.policyLogs()).toEqual([["deny shud_run role-tool-surface"]]);
    expect(h.executions).toEqual([]);
    expect(await md5(sample)).toBe(RAW_SAMPLE_MD5);
  } finally {
    await h.dispose();
  }
});
