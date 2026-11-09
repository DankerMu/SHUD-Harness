import { Context } from "@deepseek-ai/cordis";
import type { PreToolDecision, ToolExecution } from "@deepseek-ai/dsh-tools";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { RAW_READ_PROVENANCE_REASON } from "./decide.ts";
import { apply } from "./index.ts";

// Content-I/O observation stays isolated from the other real-waterfall tests.
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

const PRIVATE = "PRIVATE_ANALYSIS_CREATE_663";
const taskId = "TASK-20261108T093000-c3d4";
const taskPath = `tasks/${taskId}/task.json`;
const planPath = "analyses/PLAN-20261108T093000-5c1e.json";
type Outcome = "allowed-once" | "rejected";

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

/**
 * Real raw-guard plugin and Cordis waterfall. The registered `analysis_create` test
 * tool and its approval card are host doubles mirroring the pinned ToolRuntime:
 * downstream defaults to allow, ask goes to approval, only allowed-once executes.
 */
async function analysisRuntime(rawDirs: string[], setup: (cwd: string) => void = () => {}) {
  const cwd = native.realpathSync.native(
    native.mkdtempSync(join(tmpdir(), "analysis-create-waterfall-")),
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
    native.writeFileSync(join(cwd, "data/raw/canary.bin"), "raw canary must remain unchanged\n");
    setup(cwd);
    const fiber = await ctx.plugin({ apply }, { rawDirs });
    const execute = vi.fn(() => {
      native.mkdirSync(join(cwd, "analyses"), { recursive: true });
      native.writeFileSync(join(cwd, "analyses/PLAN-20261108T093000-aaaa.json"), "{}\n");
    });
    const approval = vi.fn((_request: { reason?: string }) => Promise.resolve<Outcome>("rejected"));
    return {
      cwd,
      messages,
      execute,
      approval,
      async decide(args: unknown, next: () => Promise<PreToolDecision>) {
        const execution = {
          name: "analysis_create",
          arguments: args,
          agent: { session: { header: { cwd } } },
        } as unknown as ToolExecution;
        const before = snapshot(cwd);
        vi.mocked(fs.readFileSync).mockClear();
        vi.mocked(fs.mkdirSync).mockClear();
        vi.mocked(fs.writeFileSync).mockClear();
        try {
          return await ctx.waterfall("tools/pre-execute", execution, next);
        } finally {
          // The guard reads no content and creates nothing before the host acts.
          expect(fs.readFileSync).not.toHaveBeenCalled();
          expect(fs.mkdirSync).not.toHaveBeenCalled();
          expect(fs.writeFileSync).not.toHaveBeenCalled();
          expect(snapshot(cwd)).toEqual(before);
          expect(JSON.stringify(messages)).not.toContain(PRIVATE);
        }
      },
      async call(args: unknown, outcome: Outcome = "rejected") {
        approval.mockImplementation(() => Promise.resolve(outcome));
        const next = vi.fn(() => Promise.resolve<PreToolDecision>({ kind: "allow" }));
        const before = snapshot(cwd);
        const decision = await this.decide(args, next);
        expect(JSON.stringify(decision)).not.toContain(PRIVATE);
        if (decision.kind === "ask") {
          if ((await approval({ reason: decision.reason })) === "allowed-once") execute();
        } else if (decision.kind === "allow") execute();
        return { decision, next, before };
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

function seedTargets(cwd: string) {
  native.mkdirSync(join(cwd, "analyses"), { recursive: true });
  native.writeFileSync(join(cwd, planPath), PRIVATE);
  native.mkdirSync(join(cwd, "tasks", taskId), { recursive: true });
  native.writeFileSync(join(cwd, taskPath), PRIVATE);
}

const validArgs = {
  task_id: taskId,
  input_dir: "input/ccw",
  rationale_basis: PRIVATE,
  parameter_sets: [{ name: PRIVATE }],
};

async function expectRawDenial(rawDirs: string[], args: unknown, exists: boolean) {
  const runtime = await analysisRuntime(rawDirs, exists ? seedTargets : undefined);
  try {
    const { decision, next, before } = await runtime.call(args, "allowed-once");
    expect(decision.kind).toBe("deny");
    expect(decision).toHaveProperty("reason", expect.stringContaining("immutable"));
    expect(next).not.toHaveBeenCalled();
    expect(runtime.approval).not.toHaveBeenCalled();
    expect(runtime.execute).not.toHaveBeenCalled();
    expect(runtime.messages).toEqual([["deny analysis_create raw-immutable"]]);
    expect(snapshot(runtime.cwd)).toEqual(before);
  } finally {
    await runtime.close();
  }
}

for (const exists of [false, true]) {
  test.each(["analyses", "tasks", `tasks/${taskId}`, taskPath])(
    `raw %s blocks plan creation before execute and approval with existing targets=${exists}`,
    (raw) => expectRawDenial([raw], validArgs, exists),
  );
}

test.each([
  [["prot", "analyses"]],
  [["analyses", "prot"]],
  [["prot", taskPath]],
  [[taskPath, "prot"]],
])("write denial precedes the raw input approval for rawDirs %j", (rawDirs) =>
  expectRawDenial(rawDirs, { ...validArgs, input_dir: "prot/ccw" }, true),
);

test.each<[string, unknown]>([
  ["missing input", { task_id: taskId }],
  ["numeric input", { task_id: taskId, input_dir: 7 }],
  ["malformed task id", { task_id: "TASK-0001", input_dir: "prot/ccw" }],
  ["null arguments", null],
])("%s still uses the fixed write targets without throwing", async (_label, args) => {
  await expectRawDenial(["prot", "analyses"], args, false);
  await expectRawDenial(["tasks"], args, false);
});

test.each(["prot/ccw", "ccw-link"])(
  "raw input %s asks with the shud_run provenance reason and runs only on allowed-once",
  async (input) => {
    const runtime = await analysisRuntime(["prot"], (cwd) => {
      seedTargets(cwd);
      native.mkdirSync(join(cwd, "prot/ccw"), { recursive: true });
      native.symlinkSync(join(cwd, "prot/ccw"), join(cwd, "ccw-link"));
    });
    try {
      const args = { ...validArgs, input_dir: input };
      const rejected = await runtime.call(args, "rejected");
      expect(rejected.decision).toEqual({
        kind: "ask",
        reason: RAW_READ_PROVENANCE_REASON,
        displayReason: { en: "Read raw data — approve?", zh: "读取原始数据，是否批准？" },
      });
      expect(rejected.next).not.toHaveBeenCalled();
      expect(runtime.approval).toHaveBeenCalledWith({ reason: RAW_READ_PROVENANCE_REASON });
      expect(runtime.execute).not.toHaveBeenCalled();
      expect(snapshot(runtime.cwd)).toEqual(rejected.before);
      const approved = await runtime.call(args, "allowed-once");
      expect(approved.decision.kind).toBe("ask");
      expect(runtime.approval).toHaveBeenCalledTimes(2);
      expect(runtime.execute).toHaveBeenCalledTimes(1);
      expect(runtime.messages).toEqual([
        ["ask analysis_create raw-read-provenance"],
        ["ask analysis_create raw-read-provenance"],
      ]);
    } finally {
      await runtime.close();
    }
  },
);

test.each<[string, unknown]>([
  ["valid arguments with raw path text", { ...validArgs, rationale_basis: "see data/raw/x" }],
  ["malformed task id", { task_id: "TASK-0001" }],
  ["null arguments", null],
])("disjoint raw data delegates %s exactly once", async (_label, args) => {
  const runtime = await analysisRuntime(["data/raw"], seedTargets);
  try {
    const { decision, next } = await runtime.call(args);
    expect(decision).toEqual({ kind: "allow" });
    expect(next).toHaveBeenCalledTimes(1);
    expect(runtime.approval).not.toHaveBeenCalled();
    expect(runtime.execute).toHaveBeenCalledTimes(1);
    expect(runtime.messages).toEqual([]);
    expect(native.readFileSync(join(runtime.cwd, "data/raw/canary.bin"), "utf8")).toBe(
      "raw canary must remain unchanged\n",
    );
  } finally {
    await runtime.close();
  }
});

test("downstream rejection is preserved exactly once for a disjoint plan", async () => {
  const runtime = await analysisRuntime(["data/raw"]);
  try {
    const failure = new Error("independent downstream validation failure");
    const next = vi.fn(() => Promise.reject(failure));
    await expect(runtime.decide(validArgs, next)).rejects.toBe(failure);
    expect(next).toHaveBeenCalledTimes(1);
    expect(runtime.messages).toEqual([]);
  } finally {
    await runtime.close();
  }
});

test.each(["analyses", "input-loop"] as const)(
  "unresolvable %s path denies as unavailable without leaking the path",
  async (loop) => {
    const runtime = await analysisRuntime(["data/raw"], (cwd) =>
      native.symlinkSync(loop, join(cwd, loop)),
    );
    try {
      const next = vi.fn(() => Promise.resolve<PreToolDecision>({ kind: "allow" }));
      const decision = await runtime.decide({ task_id: taskId, input_dir: "input-loop/x" }, next);
      expect(decision.kind).toBe("deny");
      expect(decision).toHaveProperty("reason", expect.stringContaining("safely resolved"));
      expect(decision).toHaveProperty("reason", expect.not.stringContaining(loop));
      expect(next).not.toHaveBeenCalled();
      expect(runtime.messages).toEqual([["deny analysis_create raw-target-unavailable"]]);
    } finally {
      await runtime.close();
    }
  },
);
