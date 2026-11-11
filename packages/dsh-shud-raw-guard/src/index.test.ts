import { Context } from "@deepseek-ai/cordis";
import type { PreToolDecision, ToolExecution } from "@deepseek-ai/dsh-tools";
import { expect, test, vi } from "vitest";
import { apply } from "./index.ts";

type Listener = (exec: unknown, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>;
function harness() {
  const listeners = new Map<string, unknown>();
  const info = vi.fn();
  const on = vi.fn((event: string, listener: unknown) => {
    listeners.set(event, listener);
  });
  const effect = vi.fn((setup: () => () => void) => {
    listeners.set("cleanup", setup());
  });
  const ctx = { on, effect, logger: () => ({ info }) } as unknown as Context;
  return { ctx, on, effect, info, listeners };
}

test("invalid configuration fails before installing listeners", () => {
  const { ctx, on, effect } = harness();
  expect(() => apply(ctx, { rawDir: ["protected"] })).toThrow(/rawDirs/);
  expect(on).not.toHaveBeenCalled();
  expect(effect).not.toHaveBeenCalled();
});

test("raw decisions terminate the waterfall and audit no sensitive arguments", async () => {
  const { ctx, listeners, info } = harness();
  apply(ctx, { rawDirs: ["protected"] });
  const listener = listeners.get("tools/pre-execute") as Listener;
  const agent = { session: { header: { cwd: "/workspace" } } };
  const next = vi.fn<() => Promise<PreToolDecision>>();
  const denied = await listener(
    {
      name: "write",
      agent,
      arguments: { file_path: "protected/secret.csv", content: "private-data" },
    },
    next,
  );
  expect(denied.kind).toBe("deny");
  expect(denied).toHaveProperty("reason", expect.stringContaining("immutable"));
  const asked = await listener(
    { name: "bash", agent, arguments: { command: "cat protected/secret.csv" } },
    next,
  );
  expect(asked.kind).toBe("ask");
  expect(asked).toHaveProperty("displayReason.zh", expect.stringContaining("原始"));
  expect(next).not.toHaveBeenCalled();
  const dispose = listeners.get("cleanup") as () => void;
  dispose();
  expect(info.mock.calls).toEqual([
    ["deny write raw-immutable"],
    ["ask bash raw-read-provenance"],
    ["deny=1 ask=1"],
  ]);
});

test("delegation preserves later policy decisions and failures exactly once", async () => {
  const { ctx, listeners } = harness();
  apply(ctx);
  const listener = listeners.get("tools/pre-execute") as Listener;
  const downstream: PreToolDecision = { kind: "deny", reason: "another guard" };
  for (const exec of [
    null,
    {},
    { name: 7 },
    { name: "read", arguments: { file_path: "data/raw/x" } },
    { name: "write", arguments: null },
  ]) {
    const next = vi.fn(() => Promise.resolve(downstream));
    expect(await listener(exec, next)).toBe(downstream);
    expect(next).toHaveBeenCalledTimes(1);
  }
  const failure = new Error("downstream failed");
  const next = vi.fn(() => Promise.reject(failure));
  await expect(listener({ name: "read" }, next)).rejects.toBe(failure);
  expect(next).toHaveBeenCalledTimes(1);
});

test("raw identity follows the calling session rather than process cwd or another session", async () => {
  const { ctx, listeners } = harness();
  apply(ctx, { rawDirs: ["protected"] });
  const listener = listeners.get("tools/pre-execute") as Listener;
  const next = vi.fn(() => Promise.resolve<PreToolDecision>({ kind: "cancel" }));
  for (const [cwd, expected] of [
    ["/session-a", "deny"],
    ["/session-b", "cancel"],
  ]) {
    const agent = { session: { header: { cwd } } };
    const result = await listener(
      { name: "write", agent, arguments: { file_path: "/session-a/protected/new.csv" } },
      next,
    );
    expect(result.kind).toBe(expected);
  }
  expect(next).toHaveBeenCalledTimes(1);
});

test("missing or malformed session cwd falls back safely and instance counts stay separate", async () => {
  const first = harness();
  const second = harness();
  apply(first.ctx);
  apply(second.ctx);
  const listener = first.listeners.get("tools/pre-execute") as Listener;
  for (const agent of [
    undefined,
    null,
    3,
    {},
    { session: false },
    { session: { header: null } },
    { session: { header: { cwd: 3 } } },
  ]) {
    const next = vi.fn<() => Promise<PreToolDecision>>();
    const result = await listener(
      { name: "edit", agent, arguments: { file_path: "data/raw/new.csv" } },
      next,
    );
    expect(result.kind).toBe("deny");
    expect(next).not.toHaveBeenCalled();
  }
  (first.listeners.get("cleanup") as () => void)();
  (second.listeners.get("cleanup") as () => void)();
  expect(first.info).toHaveBeenLastCalledWith("deny=7 ask=0");
  expect(second.info).toHaveBeenLastCalledWith("deny=0 ask=0");
});

test("real Cordis unload emits counts once and removes the guard", async () => {
  const ctx = new Context();
  const messages: unknown[][] = [];
  const stop = ctx.logger.exporter({
    export(message) {
      if (message.name === "shud-raw-guard") messages.push(message.args as unknown[]);
    },
  });
  const fiber = await ctx.plugin({ apply }, { rawDirs: ["protected"] });
  const execution = {
    name: "write",
    arguments: { file_path: "protected/x" },
    agent: { session: { header: { cwd: "/workspace" } } },
  } as unknown as ToolExecution;
  const next = vi.fn(() => Promise.resolve<PreToolDecision>({ kind: "cancel" }));
  expect((await ctx.waterfall("tools/pre-execute", execution, next)).kind).toBe("deny");
  await fiber.dispose();
  await fiber.dispose();
  expect(messages.filter((row) => row[0] === "deny=1 ask=0")).toHaveLength(1);
  expect((await ctx.waterfall("tools/pre-execute", execution, next)).kind).toBe("cancel");
  expect(next).toHaveBeenCalledTimes(1);
  await stop();
});

// ADR-0016 oracles: the provenance reason as written in the raw-data-guard spec, and the
// role surfaces of the Runtime Lifecycle role-tool table (worker lacks analysis_create,
// coordinator lacks bash, worker has shud_run).
const PROVENANCE_REASON = "Reading raw data requires PI approval (provenance rule).";

function agentAs(preset: string | undefined) {
  const stateOf = vi.fn(() => preset);
  const session = { header: { cwd: "/workspace" } };
  const agent =
    preset === undefined ? { session } : { session, ctx: { sessionProjections: { stateOf } } };
  return { agent, stateOf };
}

test("off-role raw read defers to the role deny without asking or counting", async () => {
  const { ctx, listeners, info } = harness();
  apply(ctx, { rawDirs: ["protected"] });
  const listener = listeners.get("tools/pre-execute") as Listener;
  const downstream: PreToolDecision = { kind: "deny", reason: "role surface" };
  const next = vi.fn(() => Promise.resolve(downstream));
  const { agent } = agentAs("worker");
  const result = await listener(
    { name: "analysis_create", agent, arguments: { input_dir: "protected/ccw" } },
    next,
  );
  expect(result).toBe(downstream);
  expect(next).toHaveBeenCalledTimes(1);
  (listeners.get("cleanup") as () => void)();
  expect(info.mock.calls).toEqual([["next analysis_create role-deferred"], ["deny=0 ask=0"]]);
});

test("off-role raw write is still denied first without reading the role", async () => {
  const { ctx, listeners, info } = harness();
  apply(ctx, { rawDirs: ["protected"] });
  const listener = listeners.get("tools/pre-execute") as Listener;
  const next = vi.fn<() => Promise<PreToolDecision>>();
  const { agent, stateOf } = agentAs("coordinator");
  const result = await listener(
    { name: "bash", agent, arguments: { command: "echo x > protected/new.csv" } },
    next,
  );
  expect(result.kind).toBe("deny");
  expect(result).toHaveProperty("reason", expect.stringContaining("immutable"));
  expect(next).not.toHaveBeenCalled();
  expect(stateOf).not.toHaveBeenCalled();
  (listeners.get("cleanup") as () => void)();
  expect(info.mock.calls).toEqual([["deny bash raw-immutable"], ["deny=1 ask=0"]]);
});

test("unknown role and on-role raw reads keep the provenance ask", async () => {
  const { ctx, listeners, info } = harness();
  apply(ctx, { rawDirs: ["protected"] });
  const listener = listeners.get("tools/pre-execute") as Listener;
  const next = vi.fn<() => Promise<PreToolDecision>>();
  for (const [preset, name, args] of [
    [undefined, "bash", { command: "cat protected/secret.csv" }],
    ["unknown-custom", "bash", { command: "cat protected/secret.csv" }],
    ["worker", "shud_run", { input_dir: "protected/ccw" }],
  ] as const) {
    const decision = await listener({ name, agent: agentAs(preset).agent, arguments: args }, next);
    expect(decision).toMatchObject({ kind: "ask", reason: PROVENANCE_REASON });
  }
  expect(next).not.toHaveBeenCalled();
  (listeners.get("cleanup") as () => void)();
  expect(info.mock.calls).toEqual([
    ["ask bash raw-read-provenance"],
    ["ask bash raw-read-provenance"],
    ["ask shud_run raw-read-provenance"],
    ["deny=0 ask=3"],
  ]);
});
