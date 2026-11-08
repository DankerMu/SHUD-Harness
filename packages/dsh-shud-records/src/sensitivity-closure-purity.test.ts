import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createSensitivityClosureLoaders, serializeRunMetrics } from "./index.ts";
import {
  evaluateSensitivity,
  sensitivityEvidence,
  sensitivityLoaders,
} from "./sensitivity-closure-test-harness.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    mkdirSync: vi.fn(actual.mkdirSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    renameSync: vi.fn(actual.renameSync),
    readdirSync: vi.fn(actual.readdirSync),
    lstatSync: vi.fn(actual.lstatSync),
    readFileSync: vi.fn(actual.readFileSync),
    openSync: vi.fn(actual.openSync),
  };
});
const native = await vi.importActual<typeof fs>("node:fs");
let root: string | undefined;
afterEach(() => {
  if (root !== undefined) native.rmSync(root, { recursive: true, force: true });
  root = undefined;
  vi.clearAllMocks();
});

test("in-memory closure performs no implicit filesystem IO or extra reader calls", () => {
  const input = sensitivityEvidence();
  const { loaders, reads } = sensitivityLoaders(input);
  vi.clearAllMocks();
  expect(evaluateSensitivity(input, loaders).ok).toBe(true);
  expect(reads).toEqual({
    plans: ["PLAN-20261108T093000-5c1e"],
    metrics: [
      "RUN-20261108T093000-0001",
      "RUN-20261108T093000-0002",
      "RUN-20261108T093000-0003",
      "RUN-20261108T093000-0004",
    ],
  });
  for (const operation of [
    fs.mkdirSync,
    fs.writeFileSync,
    fs.renameSync,
    fs.readdirSync,
    fs.lstatSync,
    fs.readFileSync,
    fs.openSync,
  ]) {
    expect(operation).not.toHaveBeenCalled();
  }
});

test.each([true, false])("readonly adapters never write or scan, linked plan %s", (linked) => {
  const input = sensitivityEvidence();
  root = native.mkdtempSync(join(tmpdir(), "sensitivity-no-discovery-"));
  native.mkdirSync(join(root, "analyses"));
  native.writeFileSync(
    join(root, "analyses", `${input.plan.analysis_plan_id}.json`),
    JSON.stringify(input.plan),
  );
  for (const record of input.records) {
    const run = join(root, "runs", record.run_id);
    native.mkdirSync(run, { recursive: true });
    native.writeFileSync(join(run, "metrics.json"), serializeRunMetrics(input.metrics));
  }
  if (!linked) input.card.linked_analyses = [];
  vi.clearAllMocks();
  const result = evaluateSensitivity(input, createSensitivityClosureLoaders(root));
  expect(result.ok).toBe(linked);
  for (const operation of [fs.mkdirSync, fs.writeFileSync, fs.renameSync, fs.readdirSync]) {
    expect(operation).not.toHaveBeenCalled();
  }
  if (!linked) {
    expect(fs.lstatSync).not.toHaveBeenCalled();
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(fs.openSync).not.toHaveBeenCalled();
  }
});
