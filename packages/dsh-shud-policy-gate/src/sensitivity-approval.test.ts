import fs from "node:fs";
import fsp, { mkdir, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import type { PreToolDecision } from "@deepseek-ai/dsh-tools";
import { afterEach, expect, test, vi } from "vitest";
import { createPolicyHarness, expectAsk, REPORT_ID, writeReport } from "./test-harness.ts";

// Sensitivity tools do not ask: the gate decides by tool id and never opens workspace files.
const TASK_ID = "TASK-20261109T080000-5a6b";
const PLAN_ID = "PLAN-20261109T080000-7c8d";
const MISSING_INPUT = "input/missing-ccw";
const PLAN_BOUND_RUN = Object.freeze({
  task_id: TASK_ID,
  input_dir: MISSING_INPUT,
  analysis_plan_id: PLAN_ID,
  parameter_set_id: "PSET-2",
});
const ANALYSIS_ARGS = Object.freeze({
  task_id: TASK_ID,
  input_dir: MISSING_INPUT,
  end_days: 30,
  parameter_sets: [
    { baseline: true, changes: {} },
    { baseline: false, changes: { GEOL_KSATH: 1.5 } },
  ],
  rationale_basis: "Policy boundary fixture, not a scientific parameter proposal.",
});
const SYNC_READERS = ["readFileSync", "statSync", "lstatSync", "readdirSync", "openSync"] as const;
const ASYNC_READERS = ["readFile", "stat", "lstat", "readdir", "open"] as const;

let restoreReaders: (() => void) | undefined;
afterEach(() => {
  restoreReaders?.();
  restoreReaders = undefined;
});

/** Spy on the CJS objects and resync builtin ESM bindings so named importers also hit the spies. */
function spyOnReaders() {
  const spies = [
    ...SYNC_READERS.map((name) => ({ name, spy: vi.spyOn(fs, name) })),
    ...ASYNC_READERS.map((name) => ({ name: `promises.${name}`, spy: vi.spyOn(fsp, name) })),
  ];
  syncBuiltinESMExports();
  restoreReaders = () => {
    for (const { spy } of spies) spy.mockRestore();
    syncBuiltinESMExports();
  };
  return () => spies.flatMap(({ name, spy }) => spy.mock.calls.map(() => name));
}

/** Governance roots that would fail any read: analyses/ holds garbage, tasks is not a directory. */
async function corruptWorkspace(cwd: string) {
  await mkdir(join(cwd, "analyses"));
  await writeFile(join(cwd, "analyses", `${PLAN_ID}.json`), "{not json");
  await writeFile(join(cwd, "tasks"), "not a directory");
}

test("reader spies intercept cross-module sync reads and named async bindings", async () => {
  const h = await createPolicyHarness({ preset: "coordinator" });
  try {
    await writeReport(h.cwd);
    const reads = spyOnReaders();
    expectAsk(await h.decide("report_submit", { report_id: REPORT_ID }));
    const syncReads = reads();
    await stat(h.cwd);
    const allReads = reads();
    restoreReaders?.();
    restoreReaders = undefined;
    expect(syncReads.length).toBeGreaterThan(0);
    expect(allReads.slice(syncReads.length)).toEqual(["promises.stat"]);
  } finally {
    await h.dispose();
  }
});

test.each([
  { label: "coordinator analysis_create with valid arguments", preset: "coordinator" },
  { label: "coordinator analysis_create with null arguments", preset: "coordinator", args: null },
  { label: "unknown analysis_create", preset: "unknown" },
  { label: "worker plan-bound shud_run", preset: "worker", tool: "shud_run", args: PLAN_BOUND_RUN },
])("$label delegates once without asking or reading", async ({ preset, tool, ...rest }) => {
  const h = await createPolicyHarness({ preset });
  try {
    await corruptWorkspace(h.cwd);
    const downstream: PreToolDecision = { kind: "deny", reason: "later guard owns this result" };
    h.next.mockResolvedValue(downstream);
    const reads = spyOnReaders();
    const args = "args" in rest ? rest.args : ANALYSIS_ARGS;
    const decision = await h.decide(tool ?? "analysis_create", args);
    expect(reads()).toEqual([]);
    expect(decision).toBe(downstream);
    expect(h.next).toHaveBeenCalledTimes(1);
    expect(h.request).not.toHaveBeenCalled();
    expect(h.policyLogs()).toEqual([]);
  } finally {
    restoreReaders?.();
    restoreReaders = undefined;
    await h.dispose();
  }
});

test("coordinator plan-bound shud_run is denied by tool id without reading", async () => {
  const h = await createPolicyHarness({ preset: "coordinator" });
  try {
    await corruptWorkspace(h.cwd);
    const reads = spyOnReaders();
    expect(await h.decide("shud_run", PLAN_BOUND_RUN)).toEqual({
      kind: "deny",
      reason: "Role coordinator cannot call tool shud_run.",
    });
    expect(reads()).toEqual([]);
    expect(h.next).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
    expect(h.policyLogs()).toEqual([["deny shud_run role-tool-surface"]]);
  } finally {
    restoreReaders?.();
    restoreReaders = undefined;
    await h.dispose();
  }
});
