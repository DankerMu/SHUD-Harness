import { Context } from "@deepseek-ai/cordis";
import type { PreToolDecision, ToolExecution } from "@deepseek-ai/dsh-tools";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { apply } from "./index.ts";

// Keep content-I/O observation isolated from the other real-waterfall tests.
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    mkdirSync: vi.fn(actual.mkdirSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  };
});
const native = await vi.importActual<typeof fs>("node:fs");

test("change_create delegates once with unavailable task identity and disjoint raw data", async () => {
  const cwd = native.realpathSync.native(
    native.mkdtempSync(join(tmpdir(), "change-create-pre-execute-")),
  );
  const ctx = new Context();
  const messages: unknown[][] = [];
  const stop = ctx.logger.exporter({
    export(message) {
      if (message.name === "shud-raw-guard") messages.push(message.args as unknown[]);
    },
  });
  try {
    native.mkdirSync(join(cwd, "data/raw"), { recursive: true });
    const canary = join(cwd, "data/raw/canary.bin");
    const bytes = Buffer.from("raw canary must remain unchanged\n");
    const timestamp = new Date("2026-11-02T09:00:00.000Z");
    native.writeFileSync(canary, bytes);
    native.utimesSync(canary, timestamp, timestamp);
    const before = native.statSync(canary, { bigint: true });
    const inventory = native.readdirSync(cwd, { recursive: true }).map(String).sort();
    expect(inventory).toEqual(["data", "data/raw", "data/raw/canary.bin"]);
    const fiber = await ctx.plugin({ apply }, { rawDirs: ["data/raw"] });
    try {
      const privatePayload = "PRIVATE_CHANGE_CREATE_TASK_ID_590";
      const getter = vi.fn(() => {
        throw new Error(privatePayload);
      });
      // Direct JS seam: this non-enumerable throwing getter is rejected during native
      // argument snapshotting; this is not a blanket accessor-rejection contract.
      const args = Object.defineProperty({ description: privatePayload }, "task_id", {
        get: getter,
      });
      const execution = {
        name: "change_create",
        arguments: args,
        agent: { session: { header: { cwd } } },
      } as unknown as ToolExecution;
      const downstream: PreToolDecision = { kind: "ask", reason: "independent policy" };
      const next = vi.fn(() => Promise.resolve(downstream));
      vi.mocked(fs.readFileSync).mockClear();
      vi.mocked(fs.mkdirSync).mockClear();
      vi.mocked(fs.writeFileSync).mockClear();

      const decision = await ctx.waterfall("tools/pre-execute", execution, next);

      // End the observation window before canary inspection or plugin cleanup.
      expect(fs.readFileSync).not.toHaveBeenCalled();
      expect(fs.mkdirSync).not.toHaveBeenCalled();
      expect(fs.writeFileSync).not.toHaveBeenCalled();
      expect(getter).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(decision)).not.toContain(privatePayload);
      expect(JSON.stringify(messages)).not.toContain(privatePayload);
      expect(native.readFileSync(canary)).toEqual(bytes);
      expect(native.statSync(canary, { bigint: true }).mtimeNs).toBe(before.mtimeNs);
      expect(native.readdirSync(cwd, { recursive: true }).map(String).sort()).toEqual(inventory);
      expect.soft(decision).toBe(downstream);
      expect.soft(next).toHaveBeenCalledTimes(1);
      expect.soft(messages).toEqual([]);
    } finally {
      await fiber.dispose();
    }
  } finally {
    await stop();
    native.rmSync(cwd, { recursive: true, force: true });
  }
});

const privatePayload = "PRIVATE_TASK_ID_590 SYNTHETIC_SECRET_590_NOT_A_CREDENTIAL";
const taskId = "TASK-20261102T090000-c3d4";
const taskPath = `tasks/${taskId}/task.json`;

function expectPrivatePayloadAbsent(value: unknown) {
  const serialized = JSON.stringify(value);
  for (const secret of privatePayload.split(" ")) expect(serialized).not.toContain(secret);
}

function throwingTaskIdentity() {
  const getter = vi.fn(() => {
    throw new Error(privatePayload);
  });
  const args = Object.defineProperty({ description: privatePayload }, "task_id", {
    get: getter,
  });
  return { args, getter };
}

function snapshot(cwd: string) {
  return ["", ...native.readdirSync(cwd, { recursive: true }).map(String).sort()].map(
    (relative) => {
      const path = join(cwd, relative);
      const stat = native.lstatSync(path, { bigint: true });
      return {
        relative,
        ino: stat.ino,
        mode: stat.mode,
        mtimeNs: stat.mtimeNs,
        bytes: stat.isFile() ? native.readFileSync(path) : undefined,
        link: stat.isSymbolicLink() ? native.readlinkSync(path) : undefined,
      };
    },
  );
}

async function changeCreateRuntime(rawDirs: string[], setup: (cwd: string) => void = () => {}) {
  const cwd = native.realpathSync.native(
    native.mkdtempSync(join(tmpdir(), "change-create-waterfall-")),
  );
  const ctx = new Context();
  const messages: unknown[][] = [];
  const stop = ctx.logger.exporter({
    export(message) {
      if (message.name === "shud-raw-guard") messages.push(message.args as unknown[]);
    },
  });
  try {
    native.mkdirSync(join(cwd, "data/raw"), { recursive: true });
    const canary = join(cwd, "data/raw/canary.bin");
    native.writeFileSync(canary, "raw canary must remain unchanged\n");
    const timestamp = new Date("2026-11-02T09:00:00.000Z");
    native.utimesSync(canary, timestamp, timestamp);
    setup(cwd);
    const before = snapshot(cwd);
    const fiber = await ctx.plugin({ apply }, { rawDirs });
    return {
      messages,
      async decide(args: unknown, next: () => Promise<PreToolDecision>) {
        const execution = {
          name: "change_create",
          arguments: args,
          agent: { session: { header: { cwd } } },
        } as unknown as ToolExecution;
        vi.mocked(fs.readFileSync).mockClear();
        vi.mocked(fs.mkdirSync).mockClear();
        vi.mocked(fs.writeFileSync).mockClear();
        try {
          const decision = await ctx.waterfall("tools/pre-execute", execution, next);
          expectPrivatePayloadAbsent(decision);
          return decision;
        } finally {
          expect(fs.readFileSync).not.toHaveBeenCalled();
          expect(fs.mkdirSync).not.toHaveBeenCalled();
          expect(fs.writeFileSync).not.toHaveBeenCalled();
          expectPrivatePayloadAbsent(messages);
          expect(snapshot(cwd)).toEqual(before);
        }
      },
      async close() {
        try {
          await fiber.dispose();
        } finally {
          await stop();
          native.rmSync(cwd, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await stop();
    native.rmSync(cwd, { recursive: true, force: true });
    throw error;
  }
}

for (const exists of [false, true]) {
  test.each(["changes", "patches", "tasks", "repos/SHUD"])(
    `unavailable task identity protects fixed raw root %s with existing targets=${exists}`,
    async (raw) => {
      const runtime = await changeCreateRuntime([raw], (cwd) => {
        if (exists) {
          native.mkdirSync(join(cwd, raw), { recursive: true });
          native.writeFileSync(join(cwd, raw, "canary.bin"), privatePayload);
        }
      });
      try {
        const { args, getter } = throwingTaskIdentity();
        const next = vi.fn(() => Promise.resolve<PreToolDecision>({ kind: "cancel" }));
        const decision = await runtime.decide(args, next);
        expect(decision.kind).toBe("deny");
        expect(decision).toHaveProperty("reason", expect.stringContaining("immutable"));
        expect(next).not.toHaveBeenCalled();
        expect(getter).toHaveBeenCalledTimes(1);
        expect(runtime.messages).toEqual([["deny change_create raw-immutable"]]);
      } finally {
        await runtime.close();
      }
    },
  );

  test.each([
    [taskPath, true],
    ["tasks/TASK-20261102T090000-ffff/task.json", false],
  ] as const)(
    `valid task identity checks exact raw task %s with existing targets=${exists}`,
    async (raw, denied) => {
      const runtime = await changeCreateRuntime([raw], (cwd) => {
        if (exists) {
          native.mkdirSync(join(cwd, "tasks", taskId), { recursive: true });
          native.writeFileSync(join(cwd, taskPath), privatePayload);
        }
      });
      try {
        const downstream: PreToolDecision = { kind: "ask", reason: "independent policy" };
        const next = vi.fn(() => Promise.resolve(downstream));
        const decision = await runtime.decide(
          { task_id: taskId, description: privatePayload },
          next,
        );
        if (denied) {
          expect(decision.kind).toBe("deny");
          expect(decision).toHaveProperty("reason", expect.stringContaining("immutable"));
          expect(next).not.toHaveBeenCalled();
          expect(runtime.messages).toEqual([["deny change_create raw-immutable"]]);
        } else {
          expect(decision).toBe(downstream);
          expect(next).toHaveBeenCalledTimes(1);
          expect(runtime.messages).toEqual([]);
        }
      } finally {
        await runtime.close();
      }
    },
  );
}

for (const identity of ["missing", "malformed", "wrong-type"] as const) {
  test.each([
    ["tasks", true],
    ["data/raw", false],
    [taskPath, false],
  ] as const)(
    `${identity} task identity uses the fixed tasks fallback against %s`,
    async (raw, denied) => {
      const runtime = await changeCreateRuntime([raw]);
      try {
        const args =
          identity === "missing"
            ? { description: privatePayload }
            : {
                description: privatePayload,
                task_id: identity === "malformed" ? `../${privatePayload}` : 7,
              };
        const downstream: PreToolDecision = { kind: "ask", reason: "independent policy" };
        const next = vi.fn(() => Promise.resolve(downstream));
        const decision = await runtime.decide(args, next);
        if (denied) {
          expect(decision.kind).toBe("deny");
          expect(decision).toHaveProperty("reason", expect.stringContaining("immutable"));
          expect(next).not.toHaveBeenCalled();
          expect(runtime.messages).toEqual([["deny change_create raw-immutable"]]);
        } else {
          expect(decision).toBe(downstream);
          expect(next).toHaveBeenCalledTimes(1);
          expect(runtime.messages).toEqual([]);
        }
      } finally {
        await runtime.close();
      }
    },
  );
}

test("unavailable task identity preserves the exact downstream rejection once", async () => {
  const runtime = await changeCreateRuntime(["data/raw"]);
  try {
    const { args, getter } = throwingTaskIdentity();
    const failure = new Error("independent downstream validation failure");
    const next = vi.fn(() => Promise.reject(failure));
    await expect(runtime.decide(args, next)).rejects.toBe(failure);
    expect(next).toHaveBeenCalledTimes(1);
    expect(getter).toHaveBeenCalledTimes(1);
    expect(runtime.messages).toEqual([]);
  } finally {
    await runtime.close();
  }
});

test.each(["target", "raw-root"] as const)(
  "unavailable physical %s remains fail-closed after task identity extraction throws",
  async (fault) => {
    const loop = fault === "target" ? "changes" : "raw-loop";
    const runtime = await changeCreateRuntime([fault === "target" ? "data/raw" : loop], (cwd) =>
      native.symlinkSync(loop, join(cwd, loop)),
    );
    try {
      const { args, getter } = throwingTaskIdentity();
      const next = vi.fn(() => Promise.resolve<PreToolDecision>({ kind: "cancel" }));
      const decision = await runtime.decide(args, next);
      expect(decision.kind).toBe("deny");
      expect(decision).toHaveProperty("reason", expect.stringContaining("safely resolved"));
      expect(next).not.toHaveBeenCalled();
      expect(getter).toHaveBeenCalledTimes(1);
      expect(runtime.messages).toEqual([["deny change_create raw-target-unavailable"]]);
    } finally {
      await runtime.close();
    }
  },
);
