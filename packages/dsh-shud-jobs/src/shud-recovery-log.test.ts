import { spawn } from "node:child_process";
import type * as NodeFs from "node:fs";
import { Context } from "@deepseek-ai/cordis";
import { expect, test, vi } from "vitest";
import { captureRecoveryStderr } from "./reconcile-shud/test-harness.ts";
import { createRecoveryReporter } from "./shud-recovery-log.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof NodeFs>();
  return { ...actual, write: vi.fn(actual.write) };
});

test("recovery stderr is isolated by facade and stops with its owning plugin", async () => {
  const ctx = new Context();
  const stderr = captureRecoveryStderr();
  async function mountReporter() {
    let report: ((message: string) => void) | undefined;
    const fiber = ctx.plugin((child: Context) => {
      report = createRecoveryReporter(child);
    });
    await fiber;
    if (!report) throw new Error("Recovery reporter plugin did not initialize");
    return { fiber, report };
  }
  try {
    const first = await mountReporter();
    const sibling = await mountReporter();
    first.report("R7 first-run diagnostic");
    sibling.report("R7 sibling-run diagnostic");
    expect(stderr.lines("first-run")).toHaveLength(1);
    expect(stderr.lines("sibling-run")).toHaveLength(1);

    const sameName = first.fiber.ctx.logger("shud-recovery");
    sameName.level = 2;
    sameName.warn("PRIVATE_SAME_FIBER_OTHER_FACADE_343");
    const unrelated = first.fiber.ctx.logger("unrelated-plugin");
    unrelated.level = 2;
    unrelated.warn("PRIVATE_UNRELATED_WARNING_343");
    unrelated.error(new Error("PRIVATE_UNRELATED_ERROR_343"));
    expect(stderr.text()).not.toContain("PRIVATE_");

    await first.fiber.dispose();
    const before = stderr.text();
    first.report("R7 disposed-run diagnostic");
    expect(stderr.text()).toBe(before);
    sibling.report("R7 surviving-run diagnostic");
    expect(stderr.lines("surviving-run")).toHaveLength(1);

    const replacement = await mountReporter();
    replacement.report("R7 replacement-run diagnostic");
    expect(stderr.lines("replacement-run")).toHaveLength(1);
    first.report("R7 stale-run diagnostic");
    expect(stderr.lines("stale-run")).toEqual([]);
    await replacement.fiber.dispose();
    replacement.report("R7 disposed-replacement diagnostic");
    expect(stderr.lines("disposed-replacement")).toEqual([]);
    await sibling.fiber.dispose();
    sibling.report("R7 disposed-sibling diagnostic");
    expect(stderr.lines("disposed-sibling")).toEqual([]);
  } finally {
    stderr.restore();
    await ctx.fiber.dispose();
  }
});

test.each(["open-pipe", "closed-pipe", "closed-pipe-no-log", "closed-fd"] as const)(
  "recovery diagnostic survives %s without terminating the host",
  async (mode) => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
import { closeSync } from "node:fs";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
// Exercise native module loading in a fresh process, outside Vitest's transformed module graph.
const require = createRequire(${JSON.stringify(import.meta.url)});
const { Context } = await import(require.resolve("@deepseek-ai/cordis"));
const { createRecoveryReporter } = await import(${JSON.stringify(new URL("./shud-recovery-log.ts", import.meta.url).href)});
const ctx = new Context();
let report;
const fiber = ctx.plugin(child => { report = createRecoveryReporter(child); });
await fiber;
process.on("uncaughtExceptionMonitor", error => {
  process.stdout.write(JSON.stringify({
    monitor: "uncaughtException", code: error.code, syscall: error.syscall,
  }) + "\\n");
});
process.stdout.write("READY\\n");
process.stdin.once("data", async () => {
  if (process.argv[1] === "closed-fd") closeSync(process.stderr.fd);
  if (process.argv[1] !== "closed-pipe-no-log")
    report("R7 native-stderr-survival diagnostic");
  await delay(50);
  process.stdout.write("SURVIVED\\n");
  await fiber.dispose();
  await ctx.fiber.dispose();
});
`,
        mode,
      ],
      { stdio: ["pipe", "pipe", "pipe"], timeout: 5000, killSignal: "SIGKILL" },
    );
    let stdout = "";
    let stderr = "";
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      },
    );
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const ready = new Promise<void>((resolve) => {
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.includes("READY\n")) resolve();
      });
    });
    try {
      await Promise.race([
        ready,
        closed.then(() => {
          throw new Error(`Diagnostic child exited before READY: ${stdout}\n${stderr}`);
        }),
      ]);
      if (mode === "closed-pipe" || mode === "closed-pipe-no-log") {
        await new Promise<void>((resolve) => {
          child.stderr.once("close", resolve);
          child.stderr.destroy();
        });
      }
      child.stdin.end("emit\n");
      const result = await closed;
      expect(result, `${stdout}\n${stderr}`).toEqual({ code: 0, signal: null });
      expect(stdout.split("\n")).toContain("SURVIVED");
      expect(stdout).not.toContain("uncaughtException");
      if (mode === "open-pipe") {
        const diagnostics = stderr
          .split("\n")
          .filter((line) => line.includes("native-stderr-survival"));
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]).toContain("WARN");
      } else {
        expect(stderr).not.toContain("native-stderr-survival");
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    }
  },
  15000,
);
