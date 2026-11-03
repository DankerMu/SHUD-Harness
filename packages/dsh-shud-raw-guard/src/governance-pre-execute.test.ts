import { Context } from "@deepseek-ai/cordis";
import type { PreToolDecision, ToolExecution } from "@deepseek-ai/dsh-tools";
import { readCallerPresetId } from "@shud-harness/dsh-shud-core";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { apply } from "./index.ts";

test("governance write cannot bypass the real Cordis guard with unsupported file workdir", async () => {
  const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), "governance-pre-execute-")));
  const ctx = new Context();
  const messages: unknown[][] = [];
  const stop = ctx.logger.exporter({
    export(message) {
      if (message.name === "shud-raw-guard") messages.push(message.args as unknown[]);
    },
  });
  try {
    mkdirSync(join(cwd, "changes"));
    mkdirSync(join(cwd, "repos/SHUD"), { recursive: true });
    const filePath = "changes/CHG-20261102T090000-1a2b.json";
    const target = join(cwd, filePath);
    const original = Buffer.from('{"status":"proposed"}\n');
    writeFileSync(target, original);
    const before = statSync(target, { bigint: true });
    const fiber = await ctx.plugin({ apply }, { rawDirs: ["data/raw"] });
    try {
      const execution = {
        name: "write",
        arguments: {
          file_path: filePath,
          content: '{"status":"approved"}\n',
          workdir: "repos/SHUD",
        },
        agent: { session: { header: { cwd } } },
      } as unknown as ToolExecution;
      const next = vi.fn(() => Promise.resolve<PreToolDecision>({ kind: "cancel" }));

      const decision = await ctx.waterfall("tools/pre-execute", execution, next);

      expect(decision.kind).toBe("deny");
      expect(decision).toHaveProperty("reason", expect.stringContaining("immutable"));
      expect(decision).toHaveProperty("reason", expect.stringContaining("change_create"));
      expect(next).not.toHaveBeenCalled();
      expect(messages).toEqual([["deny write governance-immutable"]]);
      expect(readFileSync(target)).toEqual(original);
      expect(statSync(target, { bigint: true }).mtimeNs).toBe(before.mtimeNs);
    } finally {
      await fiber.dispose();
    }
  } finally {
    await stop();
    rmSync(cwd, { recursive: true, force: true });
  }
});

async function governanceRuntime(rawDirs = ["data/raw"]) {
  const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), "governance-waterfall-")));
  const context = new Context();
  const audit: unknown[][] = [];
  const stop = context.logger.exporter({
    export(message) {
      if (message.name === "shud-raw-guard") audit.push(message.args as unknown[]);
    },
  });
  const fiber = await context.plugin({ apply }, { rawDirs });
  const session = { header: { cwd, agentPreset: "stale-header" } };
  const current: { preset: string | undefined } = { preset: undefined };
  // The host projection service is a boundary double; the plugin and waterfall are real.
  const sessionProjections = {
    stateOf(actual: unknown, key: string) {
      return actual === session && key === "agentPreset" ? current.preset : undefined;
    },
  };
  const agent = {
    session,
    ctx: {
      sessionProjections,
      get: (name: string) => (name === "sessionProjections" ? sessionProjections : undefined),
    },
  };
  return {
    cwd,
    audit,
    agent,
    current,
    decide(name: string, args: unknown, next: () => Promise<PreToolDecision>) {
      const execution = { name, arguments: args, agent } as unknown as ToolExecution;
      return context.waterfall("tools/pre-execute", execution, next);
    },
    async close() {
      try {
        await fiber.dispose();
      } finally {
        await stop();
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  };
}

test.each<[string, string | undefined]>([
  ["coordinator", undefined],
  ["worker", "require_escalated"],
  ["coder", "use_default"],
  ["reviewer", "require_escalated"],
  ["unknown", "require_escalated"],
])("%s cannot approve or escalate governance mutations", async (role, permissions) => {
  const runtime = await governanceRuntime();
  try {
    runtime.current.preset = role === "unknown" ? undefined : role;
    expect(readCallerPresetId(runtime.agent)).toBe(role);
    mkdirSync(join(runtime.cwd, "changes"));
    const path = join(runtime.cwd, "changes/private-record.json");
    writeFileSync(path, "private-original\n");
    const before = statSync(path, { bigint: true }).mtimeNs;
    const next = vi.fn(() =>
      Promise.resolve<PreToolDecision>({ kind: "ask", reason: "later PI gate" }),
    );
    for (const [name, args] of [
      ["edit", { file_path: "changes/private-record.json", new_string: "private-replacement" }],
      ["bash", { command: "rm changes/private-record.json" }],
    ] as const) {
      const result = await runtime.decide(
        name,
        { ...args, sandbox_permissions: permissions },
        next,
      );
      expect(result.kind).toBe("deny");
      expect(result).toHaveProperty("reason", expect.stringContaining("immutable"));
    }
    expect(next).not.toHaveBeenCalled();
    expect(runtime.audit).toEqual([
      ["deny edit governance-immutable"],
      ["deny bash governance-immutable"],
    ]);
    expect(readFileSync(path, "utf8")).toBe("private-original\n");
    expect(statSync(path, { bigint: true }).mtimeNs).toBe(before);
  } finally {
    await runtime.close();
  }
});

test("governance reads and exclusions preserve downstream identity and rejection exactly once", async () => {
  const runtime = await governanceRuntime(["/unrelated-raw"]);
  try {
    const downstream: PreToolDecision = { kind: "ask", reason: "independent policy" };
    for (const [name, args] of [
      ["read", { file_path: "changes/x.json" }],
      ["str_replace_editor", { command: "view", path: "changes/x.json" }],
      ["bash", { command: "cat changes/x.json" }],
      ["pwsh", { command: "Get-Content changes\\x.json" }],
      ["write", { file_path: "repos/SHUD/x.cpp", workdir: "changes" }],
      ["bash", { command: "rm -rf ." }],
      ["bash", { command: "rm -rf *" }],
      ["bash", { command: "rm -rf ./*" }],
      ["write", null],
      ["bash", { command: 7, workdir: "changes" }],
    ] as const) {
      const next = vi.fn(() => Promise.resolve(downstream));
      expect(await runtime.decide(name, args, next)).toBe(downstream);
      expect(next).toHaveBeenCalledTimes(1);
    }
    const failure = new Error("downstream original failure");
    const next = vi.fn(() => Promise.reject(failure));
    await expect(runtime.decide("bash", { command: "ls changes" }, next)).rejects.toBe(failure);
    expect(next).toHaveBeenCalledTimes(1);
    expect(runtime.audit).toEqual([]);
  } finally {
    await runtime.close();
  }
});

test("real waterfall preserves raw write, read and ancestor decisions before governance", async () => {
  const runtime = await governanceRuntime();
  try {
    const next = vi.fn(() => Promise.resolve<PreToolDecision>({ kind: "cancel" }));
    expect((await runtime.decide("bash", { command: "rm -rf data tasks" }, next)).kind).toBe(
      "deny",
    );
    expect((await runtime.decide("bash", { command: "cat data/raw/x > tasks/x" }, next)).kind).toBe(
      "deny",
    );
    expect((await runtime.decide("bash", { command: "cat data/raw/x; ls tasks" }, next)).kind).toBe(
      "ask",
    );
    expect(next).not.toHaveBeenCalled();
    expect(runtime.audit).toEqual([
      ["deny bash raw-ancestor-write"],
      ["deny bash raw-immutable"],
      ["ask bash raw-read-provenance"],
    ]);
  } finally {
    await runtime.close();
  }
});

test.each([
  { path: "changes/x.json" },
  { command: null, path: "changes/x.json" },
  { command: 7, path: "changes/x.json" },
])("malformed editor arguments preserve downstream decisions and errors: %j", async (args) => {
  const runtime = await governanceRuntime(["/unrelated-raw"]);
  try {
    const downstream: PreToolDecision = { kind: "cancel" };
    const next = vi.fn(() => Promise.resolve(downstream));
    expect(await runtime.decide("str_replace_editor", args, next)).toBe(downstream);
    expect(next).toHaveBeenCalledTimes(1);
    const failure = new Error("downstream editor validation failed");
    const reject = vi.fn(() => Promise.reject(failure));
    await expect(runtime.decide("str_replace_editor", args, reject)).rejects.toBe(failure);
    expect(reject).toHaveBeenCalledTimes(1);
    expect(runtime.audit).toEqual([]);
  } finally {
    await runtime.close();
  }
});

test.each([
  { path: "changes/x.json" },
  { command: null, path: "changes/x.json" },
  { command: 7, path: "changes/x.json" },
])("raw overlap blocks downstream for malformed editor arguments: %j", async (args) => {
  const runtime = await governanceRuntime(["changes"]);
  try {
    const next = vi.fn(() => Promise.resolve<PreToolDecision>({ kind: "cancel" }));
    const result = await runtime.decide("str_replace_editor", args, next);
    expect(result.kind).toBe("deny");
    expect(next).not.toHaveBeenCalled();
    expect(runtime.audit).toEqual([["deny str_replace_editor raw-immutable"]]);
  } finally {
    await runtime.close();
  }
});

test("editor string mutations still deny while view preserves the downstream result", async () => {
  const runtime = await governanceRuntime(["/unrelated-raw"]);
  try {
    const downstream: PreToolDecision = { kind: "cancel" };
    const next = vi.fn(() => Promise.resolve(downstream));
    const result = await runtime.decide(
      "str_replace_editor",
      { command: "insert", path: "changes/x.json" },
      next,
    );
    expect(result.kind).toBe("deny");
    expect(next).not.toHaveBeenCalled();
    expect(runtime.audit).toEqual([["deny str_replace_editor governance-immutable"]]);
    runtime.audit.length = 0;
    expect(
      await runtime.decide("str_replace_editor", { command: "view", path: "changes/x.json" }, next),
    ).toBe(downstream);
    expect(next).toHaveBeenCalledTimes(1);
    expect(runtime.audit).toEqual([]);
  } finally {
    await runtime.close();
  }
});
