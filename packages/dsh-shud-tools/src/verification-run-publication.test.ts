import type * as crypto from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";
import { VerificationCaseSchema, VerificationIdSchema } from "@shud-harness/dsh-shud-core";
import { readWorkspaceRecord } from "@shud-harness/dsh-shud-records";
import { afterEach, expect, test, vi } from "vitest";
import { verificationCase } from "../../dsh-shud-records/src/workspace-files-test-harness.ts";
import { fileSnapshot, resultValue } from "./report-workflow/test-harness.ts";
import { expectToolError } from "./task-linked/test-harness.ts";
import { fixturePaths, PRIVATE } from "./verification-run/matrix/test-harness.ts";
import { PRIOR_VERIFICATION, verificationHarness } from "./verification-run/test-harness.ts";

const controls = vi.hoisted(() => ({ suffixes: [] as string[] }));
vi.mock("node:crypto", async (original) => {
  const actual = await original<typeof crypto>();
  return {
    ...actual,
    randomBytes(size: number, callback?: (error: Error | null, bytes: Buffer) => void) {
      if (callback) return actual.randomBytes(size, callback);
      const suffix = size === 2 ? controls.suffixes.shift() : undefined;
      return suffix === undefined ? actual.randomBytes(size) : Buffer.from(suffix, "hex");
    },
  };
});
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    linkSync: vi.fn(actual.linkSync),
    unlinkSync: vi.fn(actual.unlinkSync),
    renameSync: vi.fn(actual.renameSync),
  };
});
const native = await vi.importActual<typeof fs>("node:fs");
const suffixes = ["a001", "b002", "c003", "d004", "e005"];
const ids = suffixes.map((suffix) => VerificationIdSchema.parse(`VC-20261103T080005-${suffix}`));
function fixedAllocation() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-03T08:00:05Z"));
  controls.suffixes = [...suffixes];
}
function restoreIO() {
  vi.mocked(fs.openSync).mockImplementation(native.openSync);
  vi.mocked(fs.linkSync).mockImplementation(native.linkSync);
  vi.mocked(fs.unlinkSync).mockImplementation(native.unlinkSync);
  vi.mocked(fs.renameSync).mockImplementation(native.renameSync);
}
afterEach(() => {
  controls.suffixes = [];
  vi.useRealTimers();
  restoreIO();
});

test.each([0, 1, 2, 3])(
  "%i occupied VC allocations preserve existing records and publish the next actual id",
  async (collisions) => {
    const h = await verificationHarness();
    try {
      const directory = join(h.cwd, "verifications");
      fs.mkdirSync(directory);
      const occupied = ids.slice(0, collisions);
      for (const id of occupied)
        fs.writeFileSync(
          join(directory, `${id}.json`),
          JSON.stringify(VerificationCaseSchema.parse({ ...verificationCase.value, vc_id: id })),
        );
      const before = await Promise.all(
        occupied.map((id) => fileSnapshot(join(directory, `${id}.json`))),
      );
      const evidence = await h.evidenceSnapshot();
      fixedAllocation();
      const value = resultValue(await h.invoke());
      const expected = ids[collisions];
      expect(value.vc_id).toBe(expected);
      expect(
        readWorkspaceRecord(h.cwd, "verification", expected, { readonly: true }),
      ).toMatchObject({ vc_id: expected, status: "passed" });
      const card = readWorkspaceRecord(h.cwd, "task", h.card.task_id, { readonly: true });
      expect(card.linked_verifications).toEqual([PRIOR_VERIFICATION, expected].sort());
      expect(
        await Promise.all(occupied.map((id) => fileSnapshot(join(directory, `${id}.json`)))),
      ).toEqual(before);
      expect(fs.readdirSync(directory).sort()).toEqual(
        [...occupied, expected].map((id) => `${id}.json`).sort(),
      );
      expect(controls.suffixes).toEqual(suffixes.slice(collisions + 1));
      expect(await h.evidenceSnapshot()).toEqual(evidence);
    } finally {
      restoreIO();
      vi.useRealTimers();
      await h.dispose();
    }
  },
);

test("four occupied allocations exhaust without overwriting cases or linking a fifth id", async () => {
  const h = await verificationHarness();
  try {
    const directory = join(h.cwd, "verifications");
    fs.mkdirSync(directory);
    for (const id of ids.slice(0, 4))
      fs.writeFileSync(
        join(directory, `${id}.json`),
        JSON.stringify(VerificationCaseSchema.parse({ ...verificationCase.value, vc_id: id })),
      );
    const before = await Promise.all(
      ids.slice(0, 4).map((id) => fileSnapshot(join(directory, `${id}.json`))),
    );
    const card = await fileSnapshot(fixturePaths(h, "base").task);
    const evidence = await h.evidenceSnapshot();
    fixedAllocation();
    expectToolError(await h.invoke(), /collision/iu);
    expect(controls.suffixes).toEqual(["e005"]);
    expect(fs.readdirSync(directory).sort()).toEqual(
      ids
        .slice(0, 4)
        .map((id) => `${id}.json`)
        .sort(),
    );
    expect(
      await Promise.all(ids.slice(0, 4).map((id) => fileSnapshot(join(directory, `${id}.json`)))),
    ).toEqual(before);
    expect(await fileSnapshot(fixturePaths(h, "base").task)).toEqual(card);
    expect(await h.evidenceSnapshot()).toEqual(evidence);
  } finally {
    restoreIO();
    vi.useRealTimers();
    await h.dispose();
  }
});

test.each(["open", "link"] as const)(
  "VC %s publication failure creates no case or card link and hides OS payload",
  async (phase) => {
    const h = await verificationHarness();
    try {
      const directory = join(native.realpathSync.native(h.cwd), "verifications");
      fs.mkdirSync(directory);
      const card = await fileSnapshot(fixturePaths(h, "base").task);
      const evidence = await h.evidenceSnapshot();
      fixedAllocation();
      let failures = 0;
      if (phase === "open")
        vi.mocked(fs.openSync).mockImplementation((...args) => {
          if (String(args[0]).startsWith(`${directory}/`)) {
            failures++;
            throw Object.assign(new Error(PRIVATE), { code: "EACCES" });
          }
          return native.openSync(...args);
        });
      else
        vi.mocked(fs.linkSync).mockImplementation((source, target) => {
          if (String(target).startsWith(`${directory}/`)) {
            failures++;
            throw Object.assign(new Error(PRIVATE), { code: "EACCES" });
          }
          return native.linkSync(source, target);
        });
      const result = await h.invoke();
      expectToolError(result, /write|publication/iu);
      expect(failures).toBe(1);
      expect(JSON.stringify(result)).not.toContain(PRIVATE);
      expect(fs.readdirSync(directory)).toEqual([]);
      expect(await fileSnapshot(fixturePaths(h, "base").task)).toEqual(card);
      expect(await h.evidenceSnapshot()).toEqual(evidence);
    } finally {
      restoreIO();
      vi.useRealTimers();
      await h.dispose();
    }
  },
);

test("card write-back failure retains the collision-reallocated VC and reports its actual id", async () => {
  const h = await verificationHarness();
  try {
    const directory = join(h.cwd, "verifications");
    fs.mkdirSync(directory);
    const occupied = join(directory, `${ids[0]}.json`);
    fs.writeFileSync(
      occupied,
      JSON.stringify(VerificationCaseSchema.parse({ ...verificationCase.value, vc_id: ids[0] })),
    );
    const occupiedBefore = await fileSnapshot(occupied);
    const taskPath = fixturePaths(h, "base").task;
    const card = await fileSnapshot(taskPath);
    const evidence = await h.evidenceSnapshot();
    fixedAllocation();
    let failures = 0;
    vi.mocked(fs.renameSync).mockImplementation((source, target) => {
      if (String(target) === taskPath) {
        failures++;
        throw Object.assign(new Error(PRIVATE), { code: "EIO" });
      }
      return native.renameSync(source, target);
    });
    const result = await h.invoke();
    const message = expectToolError(result, /task_card|retained/iu);
    expect(failures).toBe(1);
    expect(message).toContain(ids[1]);
    expect(JSON.stringify(result)).not.toContain(PRIVATE);
    expect(readWorkspaceRecord(h.cwd, "verification", ids[1], { readonly: true })).toMatchObject({
      vc_id: ids[1],
      status: "passed",
    });
    expect(await fileSnapshot(occupied)).toEqual(occupiedBefore);
    expect(await fileSnapshot(taskPath)).toEqual(card);
    expect(fs.readdirSync(directory).sort()).toEqual([`${ids[0]}.json`, `${ids[1]}.json`]);
    expect(fs.readdirSync(join(h.cwd, "tasks", h.card.task_id))).toEqual(["task.json"]);
    expect(await h.evidenceSnapshot()).toEqual(evidence);
  } finally {
    restoreIO();
    vi.useRealTimers();
    await h.dispose();
  }
});
