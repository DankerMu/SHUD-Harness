import { fork, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ShudJobRegistry } from "../registry.ts";
import { createHarness } from "../test-harness.ts";

const CHILD_ARGUMENT = "--state-lock-registry-child";
const RESPONSE_TIMEOUT_MS = 5000;

type Reply = { event: string; pid: number; jobs?: unknown; error?: string; childPid?: number };

export interface RegistryChild {
  pid: number;
  apply(): Promise<Reply>;
  inspect(): Promise<Reply>;
  release(): Promise<Reply>;
  spawnUnrelated(): Promise<Reply>;
  interruptCompletion(): Promise<Reply>;
  kill(): Promise<void>;
  stop(): Promise<void>;
}

// Node 24 runs this TypeScript entry directly, like the repository's script entries.
// Deferred apply provides a real IPC barrier before initial/stale ownership races.
export async function createRegistryChild(
  config: { stateDir: string; shudBin: string },
  deferred = false,
): Promise<RegistryChild> {
  const child = fork(fileURLToPath(import.meta.url), [CHILD_ARGUMENT, JSON.stringify(config)], {
    execArgv: [],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-8192);
  });
  // Node 24 can omit "close" after manual IPC disconnection even after a clean exit.
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));

  function reply(event: string, command?: string): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        finish(new Error(`Registry child timed out waiting for ${event}: ${stderr}`));
      }, RESPONSE_TIMEOUT_MS);
      function finish(error?: Error, value?: Reply) {
        clearTimeout(timer);
        child.off("message", onMessage);
        child.off("error", onError);
        child.off("exit", onExit);
        if (error) reject(error);
        else if (value) resolve(value);
      }
      function onMessage(message: unknown) {
        if (typeof message !== "object" || message === null || !("event" in message)) return;
        if (message.event !== event && message.event !== "error") return;
        const value = message as Reply;
        if (value.event === "error") finish(new Error(`Registry child: ${value.error}`));
        else finish(undefined, value);
      }
      function onError(error: Error) {
        finish(error);
      }
      function onExit(code: number | null, signal: string | null) {
        finish(new Error(`Registry child exited before ${event} (${code}, ${signal}): ${stderr}`));
      }
      child.on("message", onMessage);
      child.once("error", onError);
      child.once("exit", onExit);
      if (command)
        child.send(command, (error) => {
          if (error) finish(error);
        });
    });
  }

  let stopping: Promise<void> | undefined;
  function stop() {
    return (stopping ??= stopChild());
  }

  async function stopChild() {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
    const deadline = new AbortController();
    const timeout = delay(RESPONSE_TIMEOUT_MS, undefined, { signal: deadline.signal }).then(() => {
      throw new Error(`Registry child did not exit during cleanup: ${stderr}`);
    });
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, RESPONSE_TIMEOUT_MS / 2);
    try {
      if (child.connected) child.disconnect();
      await Promise.race([exited, timeout]);
    } finally {
      clearTimeout(timer);
      deadline.abort();
    }
  }

  try {
    const prepared = await reply("prepared");
    if (!deferred) {
      const applied = await reply("applied", "apply");
      if (applied.error) throw new Error(applied.error);
    }
    return {
      pid: prepared.pid,
      apply: () => reply("applied", "apply"),
      inspect: () => reply("inspected", "inspect"),
      release: () => reply("released", "release"),
      spawnUnrelated: () => reply("spawned", "spawn"),
      interruptCompletion: () => reply("completion-persisted", "interrupt-completion"),
      async kill() {
        child.kill("SIGKILL");
        await stop();
      },
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function runRegistryChild() {
  const input: unknown = JSON.parse(process.argv[3]);
  if (
    typeof input !== "object" ||
    input === null ||
    !("stateDir" in input) ||
    typeof input.stateDir !== "string"
  ) {
    throw new Error("child requires stateDir");
  }
  const stateDir = input.stateDir;
  const h = await createHarness(dirname(stateDir));
  const unrelated: ChildProcess[] = [];
  let operations = Promise.resolve();
  process.on("message", (command: unknown) => {
    operations = operations.then(async () => {
      if (command === "apply") {
        try {
          await h.apply(ShudJobRegistry, input);
          process.send?.({ event: "applied", pid: process.pid });
        } catch (error) {
          process.send?.({ event: "applied", pid: process.pid, error: String(error) });
        }
      } else if (command === "inspect") {
        process.send?.({ event: "inspected", pid: process.pid, jobs: h.ctx.jobs.list() });
      } else if (command === "release") {
        await h.ctx.fiber.dispose();
        process.send?.({ event: "released", pid: process.pid });
      } else if (command === "interrupt-completion") {
        const registry = h.ctx.jobs;
        if (!(registry instanceof ShudJobRegistry)) throw new Error("SHUD registry not published");
        const first = registry.indexes.read().active[0];
        if (!first) throw new Error("interruption requires an active entry");
        const rename = fs.promises.rename;
        fs.promises.rename = async (source, target) => {
          if (target === join(stateDir, "active.json")) {
            const disconnected = once(process, "disconnect");
            process.send?.({ event: "completion-persisted", pid: process.pid });
            await disconnected;
          }
          await rename(source, target);
        };
        syncBuiltinESMExports();
        try {
          await registry.indexes.completeActive(first.run_id);
        } finally {
          fs.promises.rename = rename;
          syncBuiltinESMExports();
        }
      } else if (command === "spawn") {
        const child = spawn(
          process.execPath,
          ["-e", "setInterval(() => {}, 1000); process.send('ready')"],
          {
            stdio: ["ignore", "ignore", "ignore", "ipc"],
          },
        );
        unrelated.push(child);
        await once(child, "message");
        process.send?.({ event: "spawned", pid: process.pid, childPid: child.pid });
      }
    });
    operations = operations.catch((error: unknown) => {
      process.send?.({ event: "error", error: String(error), pid: process.pid });
    });
  });
  process.once("disconnect", () => {
    for (const child of unrelated) child.kill("SIGKILL");
    void operations
      .then(() => h.dispose())
      .catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
      });
  });
  process.send?.({ event: "prepared", pid: process.pid });
}

if (process.argv[2] === CHILD_ARGUMENT) await runRegistryChild();
