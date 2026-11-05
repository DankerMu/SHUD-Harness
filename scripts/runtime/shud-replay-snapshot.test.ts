import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { snapshotTree } from "../../packages/dsh-shud-records/src/report-code-change-test-harness.ts";
import { makeReplayFixture } from "./replay/test-harness.ts";
import type { ReplayEvidence } from "./shud-replay-evidence.ts";
import { assertReplayEvidence } from "./shud-replay-evidence.ts";
import {
  collectReplayFiles,
  rememberReplayBuilds,
  replayRunPolicy,
  type ReplayBuildBinding,
} from "./shud-replay-snapshot.ts";
import { RunJobSchema } from "../../packages/dsh-shud-core/src/schemas/run-job.ts";

function workspaceFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "replay-snapshot-")));
  const snapshot = JSON.parse(
    JSON.stringify(makeReplayFixture().snapshot).replaceAll("/fixture/replay workspace", root),
  ) as ReplayEvidence;
  for (const [relative, value] of Object.entries(snapshot.files)) {
    const path = join(root, relative);
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.writeFileSync(
      path,
      typeof value === "string"
        ? value
        : relative === "input/keliya/PREPARED.json"
          ? `${JSON.stringify(value, null, 2)}\n`
          : JSON.stringify(value),
    );
  }
  return {
    root,
    snapshot,
    dispose() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("judges collected physical records and artifact receipts without modifying their bytes or namespace", () => {
  const h = workspaceFixture();
  try {
    const before = snapshotTree(h.root);
    const files = collectReplayFiles(h.root);
    expect(assertReplayEvidence({ ...h.snapshot, files }).status).toBe("PASS");
    expect(files["builds/BUILD-20261102T090000-f6a7/shud"]).toEqual({
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      size_bytes: 3,
    });
    expect(snapshotTree(h.root)).toEqual(before);
  } finally {
    h.dispose();
  }
});

test("rejects a symlinked artifact without reading or modifying the foreign target", () => {
  const h = workspaceFixture();
  const outside = join(h.root, "foreign");
  try {
    const bin = join(h.root, "builds/BUILD-20261102T090000-f6a7/shud");
    fs.writeFileSync(outside, "retain foreign bytes");
    fs.unlinkSync(bin);
    fs.symlinkSync(outside, bin);
    const before = snapshotTree(h.root);
    expect(() => collectReplayFiles(h.root)).toThrow("Symbolic evidence");
    expect(snapshotTree(h.root)).toEqual(before);
  } finally {
    h.dispose();
  }
});

test("cleanup argv is authorized by successful owned base/candidate build results, not merely two files", () => {
  const h = workspaceFixture();
  try {
    const bindings = new Map<string, ReplayBuildBinding>();
    const policy = replayRunPolicy(h.root, bindings);
    const job = RunJobSchema.parse(h.snapshot.files["runs/RUN-20261102T090000-d4e5/run-job.json"]);
    expect(() => policy.expectedArgv(job)).toThrow("canonical build binding");
    rememberReplayBuilds(h.snapshot.root, h.snapshot.children, bindings);
    expect([...bindings.keys()]).toEqual([
      "BUILD-20261102T090000-f6a7",
      "BUILD-20261102T090000-a7b8",
    ]);
    expect(policy.expectedArgv(job)).toEqual([
      `${h.root}/runs/RUN-20261102T090000-d4e5/bin/shud`,
      "-o",
      "output/keliya.out",
      "keliya",
    ]);
    const foreign = { ...job, task_id: "TASK-20261102T090000-ffff" };
    expect(() => policy.expectedArgv(foreign)).toThrow("canonical build binding");
    fs.writeFileSync(join(job.run_dir, "bin/shud"), "different bytes");
    expect(() => policy.expectedArgv(job)).toThrow("binary digest");
  } finally {
    h.dispose();
  }
});
