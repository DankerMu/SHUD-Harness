import * as childProcess from "node:child_process";
import type * as crypto from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";
import {
  ChangeIdSchema,
  ChangeRequestSchema,
  JobRecordIdSchema,
  ReportIdSchema,
  VerificationIdSchema,
  type TaskCard,
  type TaskId,
} from "@shud-harness/dsh-shud-core";
import { writeWorkspaceRecord } from "@shud-harness/dsh-shud-records";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { expectToolError } from "./task-linked/test-harness.ts";
import {
  changeHarness,
  fileSnapshot,
  noChangeObjects,
  PRIVATE,
  readCard,
  seedSource,
  seedTask,
  sourceSnapshot,
  taskPath,
  type ChangeHarness,
  valueOf,
} from "./change-create/test-harness.ts";

const controls = vi.hoisted(() => ({
  suffixes: [] as string[],
  git: undefined as ((argv: readonly string[]) => void) | undefined,
}));
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
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof childProcess>();
  return {
    ...actual,
    execFile: vi.fn((...args: Parameters<typeof actual.execFile>) => {
      if (Array.isArray(args[1])) controls.git?.(args[1]);
      return actual.execFile(...args);
    }),
  };
});
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    linkSync: vi.fn(actual.linkSync),
    unlinkSync: vi.fn(actual.unlinkSync),
    renameSync: vi.fn(actual.renameSync),
    mkdirSync: vi.fn(actual.mkdirSync),
  };
});
const native = await vi.importActual<typeof fs>("node:fs");
const first = ChangeIdSchema.parse("CHG-20261103T080005-a001");
const second = ChangeIdSchema.parse("CHG-20261103T080005-b002");
const old = ChangeIdSchema.parse("CHG-20261102T080005-c003");
let h: ChangeHarness;
let id: TaskId;
beforeEach(async () => {
  vi.clearAllMocks();
  controls.suffixes = [];
  controls.git = undefined;
  h = await changeHarness();
  seedSource(h);
  id = await seedTask(h);
  fs.writeFileSync(join(h.source, "Makefile"), "candidate\n");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-03T08:00:05Z"));
  controls.suffixes = ["a001"];
});
afterEach(async () => {
  controls.git = undefined;
  controls.suffixes = [];
  vi.useRealTimers();
  vi.mocked(fs.linkSync).mockImplementation(native.linkSync);
  vi.mocked(fs.unlinkSync).mockImplementation(native.unlinkSync);
  vi.mocked(fs.renameSync).mockImplementation(native.renameSync);
  vi.mocked(fs.mkdirSync).mockImplementation(native.mkdirSync);
  await h.dispose();
});
const call = () => h.invoke("change_create", { task_id: id, semantic_level: "pure_engineering" });
const recordPath = (changeId = first) => join(h.cwd, "changes", `${changeId}.json`);
const patchPath = (changeId = first) => join(h.cwd, "patches", `${changeId}.patch`);
function readChange(changeId = first) {
  return ChangeRequestSchema.parse(JSON.parse(fs.readFileSync(recordPath(changeId), "utf8")));
}

for (const target of ["changes", "patches", "tasks", "task-directory"]) {
  test.each(["symlink", "file", "fifo"])(
    `unsafe ${target} %s cannot publish objects or expose a candidate`,
    async (kind) => {
      const directory =
        target === "task-directory" ? join(h.cwd, "tasks", id) : join(h.cwd, target);
      const originalCard = fileSnapshot(taskPath(h, id));
      const sourceBefore = sourceSnapshot(h);
      const outside = join(h.root, "foreign");
      fs.mkdirSync(outside);
      fs.writeFileSync(join(outside, "sentinel"), PRIVATE);
      let displaced: string | undefined;
      // Task ancestors become unsafe across actual Git awaits, after readonly initial admission.
      const install = () => {
        if (fs.existsSync(directory)) {
          displaced = join(h.root, "displaced");
          fs.renameSync(directory, displaced);
        }
        if (kind === "symlink") fs.symlinkSync(outside, directory);
        if (kind === "file") fs.writeFileSync(directory, PRIVATE);
        if (kind === "fifo") childProcess.execFileSync("mkfifo", [directory]);
      };
      if (target === "tasks" || target === "task-directory")
        controls.git = (argv) => {
          if (argv.includes("diff")) {
            controls.git = undefined;
            install();
          }
        };
      else install();
      const message = expectToolError(await call(), /directory|task|preflight/iu);
      expect(message).not.toContain(PRIVATE);
      expect(message).not.toMatch(/CHG-[0-9]{8}T[0-9]{6}-[0-9a-f]{4}/u);
      expect(fs.readFileSync(join(outside, "sentinel"), "utf8")).toBe(PRIVATE);
      expect(fs.readdirSync(outside)).toEqual(["sentinel"]);
      if (displaced) {
        const saved =
          target === "tasks" ? join(displaced, id, "task.json") : join(displaced, "task.json");
        expect(fileSnapshot(saved)).toEqual(originalCard);
      } else expect(fileSnapshot(taskPath(h, id))).toEqual(originalCard);
      noChangeObjects(h);
      expect(sourceSnapshot(h)).toEqual(sourceBefore);
    },
  );
}

test("native preflight error hides private OS payload and the unclaimed candidate", async () => {
  const before = fileSnapshot(taskPath(h, id));
  vi.mocked(fs.mkdirSync).mockImplementation((...args) => {
    if (String(args[0]) === join(h.cwd, "patches"))
      throw Object.assign(new Error(PRIVATE), { code: "EIO" });
    return native.mkdirSync(...args);
  });
  const message = expectToolError(await call(), /patches/iu);
  expect(message).not.toContain(PRIVATE);
  expect(message).not.toContain(first);
  noChangeObjects(h);
  expect(fileSnapshot(taskPath(h, id))).toEqual(before);
});

test("a CR collision preserves occupied evidence and uses the actual replacement for patch, result and link", async () => {
  fs.mkdirSync(join(h.cwd, "changes"));
  fs.writeFileSync(recordPath(), "occupied CR\n");
  const occupied = fileSnapshot(recordPath());
  controls.suffixes = ["a001", "b002"];
  const result = valueOf(await call());
  expect(result).toMatchObject({ change_id: second, patch_path: `patches/${second}.patch` });
  expect(fileSnapshot(recordPath())).toEqual(occupied);
  expect(readChange(second)).toMatchObject({
    change_id: second,
    patch_path: `patches/${second}.patch`,
  });
  expect(fs.existsSync(patchPath())).toBe(false);
  expect(fs.existsSync(patchPath(second))).toBe(true);
  expect(readCard(h, id).linked_changes).toEqual([second]);
});

test("four occupied CR candidates exhaust without patch or card publication", async () => {
  const ids = ["a001", "b002", "c003", "d004"].map((suffix) =>
    ChangeIdSchema.parse(`CHG-20261103T080005-${suffix}`),
  );
  fs.mkdirSync(join(h.cwd, "changes"));
  for (const changeId of ids) fs.writeFileSync(recordPath(changeId), `occupied ${changeId}\n`);
  const occupied = ids.map((changeId) => fileSnapshot(recordPath(changeId)));
  const card = fileSnapshot(taskPath(h, id));
  controls.suffixes = ["a001", "b002", "c003", "d004", "e005"];
  expectToolError(await call(), /collision/iu);
  expect(controls.suffixes).toEqual(["e005"]);
  expect(ids.map((changeId) => fileSnapshot(recordPath(changeId)))).toEqual(occupied);
  expect(fs.readdirSync(join(h.cwd, "changes"))).toEqual(ids.map((changeId) => `${changeId}.json`));
  expect(fs.readdirSync(join(h.cwd, "patches"))).toEqual([]);
  expect(fileSnapshot(taskPath(h, id))).toEqual(card);
});

test("companion patch collision retains CR and occupied patch without a false task link", async () => {
  fs.mkdirSync(join(h.cwd, "patches"));
  fs.writeFileSync(patchPath(), "occupied patch\n");
  const occupied = fileSnapshot(patchPath());
  const card = fileSnapshot(taskPath(h, id));
  const message = expectToolError(await call(), /patch.*failed/iu);
  expect(message).toContain(first);
  expect(readChange().status).toBe("proposed");
  expect(fileSnapshot(patchPath())).toEqual(occupied);
  expect(fileSnapshot(taskPath(h, id))).toEqual(card);
});

test.each(["CR", "patch", "card"])(
  "%s publication fault is attempted once and never retried into success",
  async (stage) => {
    const card = fileSnapshot(taskPath(h, id));
    let attempts = 0;
    const sourceBefore = sourceSnapshot(h);
    if (stage === "card")
      vi.mocked(fs.renameSync).mockImplementation((from, to) => {
        if (String(to) === taskPath(h, id)) {
          attempts++;
          if (attempts === 1) throw new Error(PRIVATE);
        }
        native.renameSync(from, to);
      });
    else
      vi.mocked(fs.linkSync).mockImplementation((from, to) => {
        if (String(to) === (stage === "CR" ? recordPath() : patchPath())) {
          attempts++;
          if (attempts === 1) throw new Error(PRIVATE);
        }
        native.linkSync(from, to);
      });
    const message = expectToolError(await call(), /publication|write|task_card/iu);
    expect(attempts).toBe(1);
    expect(message).not.toContain(PRIVATE);
    expect(fileSnapshot(taskPath(h, id))).toEqual(card);
    if (stage === "CR") noChangeObjects(h);
    else {
      expect(message).toContain(first);
      expect(readChange().status).toBe("proposed");
      expect(fs.existsSync(patchPath())).toBe(stage === "card");
    }
    expect(sourceSnapshot(h)).toEqual(sourceBefore);
  },
);

test("committed CR cleanup failure retains the collision-resolved identity and no false link", async () => {
  fs.mkdirSync(join(h.cwd, "changes"));
  fs.writeFileSync(recordPath(), "occupied\n");
  const occupied = fileSnapshot(recordPath());
  const card = fileSnapshot(taskPath(h, id));
  controls.suffixes = ["a001", "b002"];
  let attempts = 0;
  vi.mocked(fs.unlinkSync).mockImplementation((path) => {
    if (String(path).startsWith(`${recordPath(second)}.`)) {
      attempts++;
      throw new Error(PRIVATE);
    }
    native.unlinkSync(path);
  });
  const message = expectToolError(await call(), /committed cleanup/iu);
  expect(message).toContain(second);
  expect(message).not.toContain(PRIVATE);
  expect(attempts).toBe(1);
  expect(readChange(second).change_id).toBe(second);
  expect(fileSnapshot(recordPath())).toEqual(occupied);
  expect(fs.existsSync(patchPath(second))).toBe(false);
  expect(fileSnapshot(taskPath(h, id))).toEqual(card);
});

test.each(["patch", "card"])(
  "post-collision %s failure reports only the actual newly committed id",
  async (stage) => {
    fs.mkdirSync(join(h.cwd, "changes"));
    fs.writeFileSync(recordPath(), "occupied\n");
    const occupied = fileSnapshot(recordPath());
    const card = fileSnapshot(taskPath(h, id));
    controls.suffixes = ["a001", "b002"];
    if (stage === "patch")
      vi.mocked(fs.linkSync).mockImplementation((from, to) => {
        if (String(to) === patchPath(second)) throw new Error(PRIVATE);
        native.linkSync(from, to);
      });
    else
      vi.mocked(fs.renameSync).mockImplementation((from, to) => {
        if (String(to) === taskPath(h, id)) throw new Error(PRIVATE);
        native.renameSync(from, to);
      });
    const message = expectToolError(await call(), /publication failed/iu);
    expect(message).toContain(second);
    expect(message).not.toContain(first);
    expect(message).not.toContain(PRIVATE);
    expect(readChange(second).patch_path).toBe(`patches/${second}.patch`);
    expect(fs.existsSync(patchPath(second))).toBe(stage === "card");
    expect(fileSnapshot(recordPath())).toEqual(occupied);
    expect(fileSnapshot(taskPath(h, id))).toEqual(card);
  },
);

test.each([null, "submitted_job"] as const)(
  "fresh running card keeps phase %j and all concurrent links",
  async (runtime_phase) => {
    const job = JobRecordIdSchema.parse("JOB-20261102T080005-a001");
    const report = ReportIdSchema.parse("REPORT-20261102T080005-a001");
    const verification = VerificationIdSchema.parse("VC-20261102T080005-a001");
    let concurrent: TaskCard | undefined;
    controls.git = (argv) => {
      if (!argv.includes("diff")) return;
      controls.git = undefined;
      concurrent = {
        ...readCard(h, id),
        status: "running",
        runtime_phase,
        title: "Concurrent title",
        linked_changes: [second, old, old],
        linked_jobs: [job],
        linked_reports: [report],
        linked_verifications: [verification],
      };
      writeWorkspaceRecord(h.cwd, "task", concurrent);
    };
    valueOf(await call());
    expect(concurrent).toBeDefined();
    expect(readCard(h, id)).toEqual({
      ...concurrent,
      linked_changes: [old, first, second],
      updated_at: "2026-11-03T08:00:05.000Z",
    });
  },
);

test.each(["status", "type", "pin", "malformed"])(
  "fresh %s change across Git awaits rejects without overwriting the new card",
  async (kind) => {
    let concurrent: { bytes: Buffer; mtime: bigint } | undefined;
    controls.git = (argv) => {
      if (!argv.includes("diff")) return;
      controls.git = undefined;
      const card = readCard(h, id);
      if (kind === "malformed")
        fs.writeFileSync(taskPath(h, id), JSON.stringify({ ...card, source_base_commit: PRIVATE }));
      else if (kind === "type")
        writeWorkspaceRecord(h.cwd, "task", {
          ...card,
          type: "science_assist",
          source_base_commit: null,
        });
      else
        writeWorkspaceRecord(
          h.cwd,
          "task",
          kind === "status"
            ? { ...card, status: "done" }
            : { ...card, source_base_commit: "a".repeat(40) },
        );
      concurrent = fileSnapshot(taskPath(h, id));
    };
    const message = expectToolError(await call(), /task|pin|status/iu);
    expect(message).not.toContain(PRIVATE);
    expect(concurrent).toBeDefined();
    expect(fileSnapshot(taskPath(h, id))).toEqual(concurrent);
    noChangeObjects(h);
  },
);

test("committed patch cleanup failure retains both artifacts and does not link the card", async () => {
  const card = fileSnapshot(taskPath(h, id));
  let attempts = 0;
  vi.mocked(fs.unlinkSync).mockImplementation((path) => {
    if (String(path).startsWith(`${patchPath()}.`)) {
      attempts++;
      throw new Error(PRIVATE);
    }
    native.unlinkSync(path);
  });
  const message = expectToolError(await call(), /patch.*failed/iu);
  expect(message).toContain(first);
  expect(message).not.toContain(PRIVATE);
  expect(attempts).toBe(1);
  expect(readChange().status).toBe("proposed");
  expect(fs.existsSync(patchPath())).toBe(true);
  expect(fileSnapshot(taskPath(h, id))).toEqual(card);
});
