import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import * as io from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { RunJobSchema, type RunJob } from "@shud-harness/dsh-shud-core";
import { ShudJobRegistry, type SubmitShudRequest } from "../index.ts";
import { readInvocation } from "../detached-shud/test-harness.ts";
import { settlingProducer } from "../poll-shud/test-harness.ts";
import { actualRegistry } from "../submit-shud/test-harness.ts";
import { createHarness, installScriptFixture } from "../test-harness.ts";

const HOST_ARGUMENT = "--wake-crash-host";
const WAIT_MS = 5000;
type CrashScenario = "flush-window" | "running" | "terminal-window" | "projection-window";
interface CrashHostInput {
  config: { stateDir: string; shudBin: string; pumpPollMs: number };
  request: SubmitShudRequest;
  directory: string;
  phase: "submit" | "recover";
  scenario: CrashScenario;
  record?: RunJob;
}
interface HostExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}
export interface WakeCrashHost {
  pid: number;
  kill(): Promise<HostExit>;
  stop(): Promise<void>;
  file(name: string): Promise<string>;
  exited(): Promise<HostExit>;
}

export async function installCrashSolver(path: string): Promise<void> {
  const driver = `${path}.cjs`;
  await io.writeFile(
    driver,
    `const fs = require('node:fs');
const server = require('node:net').createServer(socket => {
  socket.once('data', () => {
    socket.end('released');
    server.close(() => process.exit(0));
  });
});
server.listen(0, '127.0.0.1', () => {
  fs.appendFileSync('invocations', 'invoked\\n');
  fs.writeFileSync('invocation.json.tmp', JSON.stringify({
    pid: process.pid, ppid: process.ppid, port: server.address().port,
    argv: process.argv.slice(2), cwd: process.cwd()
  }));
  fs.renameSync('invocation.json.tmp', 'invocation.json');
  fs.mkdirSync('output/tiny.out', { recursive: true });
  fs.writeFileSync('output/tiny.out/flow.dat', 'flow\\n');
  fs.writeSync(1, 'crash fixture stdout\\n');
});
`,
  );
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await installScriptFixture(
    path,
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(driver)} "$@"\n`,
  );
}

export function createWakeCrashHost(input: CrashHostInput): WakeCrashHost {
  const child: ChildProcess = fork(
    fileURLToPath(import.meta.url),
    [HOST_ARGUMENT, JSON.stringify(input)],
    {
      execArgv: [],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  if (child.pid === undefined) throw new Error("Crash fixture host has no native process id");
  const pid = child.pid;
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-8192);
  });
  let failure: Error | undefined;
  const exit = new Promise<HostExit>((resolve) => {
    child.once("error", (error) => {
      failure = error;
      resolve({ code: null, signal: null });
    });
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  async function exited(): Promise<HostExit> {
    const controller = new AbortController();
    try {
      return await Promise.race([
        exit,
        delay(WAIT_MS, undefined, { signal: controller.signal }).then(() => {
          throw new Error(`Crash fixture host did not exit: ${stderr}`, { cause: failure });
        }),
      ]);
    } finally {
      controller.abort();
    }
  }
  let stopping: Promise<void> | undefined;
  return {
    pid,
    exited,
    async kill() {
      child.kill("SIGKILL");
      return exited();
    },
    stop() {
      return (stopping ??= (async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        if (child.connected) child.disconnect();
        const killer = setTimeout(() => child.kill("SIGKILL"), WAIT_MS / 2);
        try {
          await exited();
        } finally {
          clearTimeout(killer);
        }
      })());
    },
    async file(name) {
      const deadline = performance.now() + WAIT_MS;
      const path = join(input.directory, name);
      for (;;) {
        try {
          return await io.readFile(path, "utf8");
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
        if (failure || child.exitCode !== null || child.signalCode !== null)
          throw new Error(`Crash fixture host exited before ${name}: ${stderr}`, {
            cause: failure,
          });
        if (performance.now() >= deadline)
          throw new Error(`Crash fixture host did not publish ${name}: ${stderr}`);
        await delay(10);
      }
    },
  };
}

function publish(directory: string, name: string, value: unknown): void {
  const path = join(directory, name);
  fs.writeFileSync(`${path}.pending`, JSON.stringify(value));
  fs.renameSync(`${path}.pending`, path);
}

async function runCrashHost(input: CrashHostInput): Promise<void> {
  const h = await createHarness(dirname(input.config.stateDir));
  let cleanupProducer: (() => Promise<void>) | undefined;
  const disconnected = new Promise<void>((resolve) => process.once("disconnect", resolve));
  const originalRename = fs.renameSync;
  try {
    const owner = h.ctx.agents.get(h.ownerId);
    if (!owner) throw new Error("Crash fixture owner is missing");
    const followup = owner.followup.bind(owner);
    const eventsPath = join(input.directory, "wake-events.jsonl");
    owner.followup = (message) => {
      followup(message);
      fs.appendFileSync(eventsPath, `${JSON.stringify({ host: process.pid, message })}\n`);
    };
    const flush = h.ctx.sessions.flush.bind(h.ctx.sessions);
    h.ctx.sessions.flush = async (session) => {
      const acknowledged = await flush(session);
      const fd = fs.openSync(eventsPath, "r");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      publish(input.directory, `session-events-${process.pid}.json`, h.sessionEvents);
      publish(input.directory, `flush-${process.pid}.json`, { host: process.pid, acknowledged });
      return acknowledged;
    };
    if (input.phase === "submit" && input.scenario === "flush-window") {
      fs.renameSync = (source, target) => {
        if (String(target).endsWith("/run-job.json")) {
          const candidate = RunJobSchema.parse(JSON.parse(fs.readFileSync(source, "utf8")));
          if (candidate.notify.status === "delivered") {
            if (!fs.existsSync(join(input.directory, `flush-${process.pid}.json`)))
              throw new Error("Delivered marker reached before a flush acknowledgement");
            publish(input.directory, "pre-marker.json", { host: process.pid });
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
          }
        }
        originalRename(source, target);
      };
      syncBuiltinESMExports();
    }
    if (
      input.phase === "submit" &&
      (input.scenario === "terminal-window" || input.scenario === "projection-window")
    ) {
      fs.renameSync = (source, target) => {
        if (String(target).endsWith("/run-job.json")) {
          const candidate = RunJobSchema.parse(JSON.parse(fs.readFileSync(source, "utf8")));
          if (input.scenario === "terminal-window" && candidate.status === "succeeded") {
            originalRename(source, target);
            publish(input.directory, "terminal-published.json", { host: process.pid, candidate });
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
            return;
          }
          if (input.scenario === "projection-window" && candidate.status === "collected") {
            if (!fs.existsSync(join(candidate.run_dir, "run-record.json")))
              throw new Error("Collected projection reached before RunRecord commit");
            publish(input.directory, "projection-blocked.json", { host: process.pid });
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
          }
        }
        originalRename(source, target);
      };
      syncBuiltinESMExports();
    }
    await h.apply(ShudJobRegistry, input.config);
    const registry = actualRegistry(h.ctx);
    if (input.phase === "submit") {
      const producer = settlingProducer();
      cleanupProducer = () => producer.cleanup();
      const record = await registry.submitShud(input.request, producer.start);
      const deadline = performance.now() + WAIT_MS;
      while (!(await readInvocation(record.run_dir))) {
        if (performance.now() >= deadline)
          throw new Error("Crash fixture native invocation was not published");
        await delay(10);
      }
      publish(input.directory, `session-events-${process.pid}.json`, h.sessionEvents);
      publish(input.directory, "submitted.json", record);
      await disconnected;
    } else {
      if (!input.record)
        throw new Error("Recovery host requires the original durable run identity");
      const path = join(input.record.run_dir, "run-job.json");
      const read = () => RunJobSchema.parse(JSON.parse(fs.readFileSync(path, "utf8")));
      publish(input.directory, "recovered.json", read());
      const deadline = performance.now() + WAIT_MS;
      for (;;) {
        await registry.pollOnce();
        const current = read();
        if (
          current.notify.status === "delivered" &&
          !registry.indexes.read().active.some((entry) => entry.run_id === current.run_id)
        ) {
          publish(input.directory, "finished.json", current);
          break;
        }
        if (performance.now() >= deadline)
          throw new Error("Fresh host did not finish wake delivery");
        await delay(10);
      }
    }
  } finally {
    fs.renameSync = originalRename;
    syncBuiltinESMExports();
    try {
      await cleanupProducer?.();
    } finally {
      await h.dispose();
      if (process.connected) process.disconnect();
    }
  }
}

if (process.argv[2] === HOST_ARGUMENT) {
  const input = JSON.parse(process.argv[3]) as CrashHostInput;
  await runCrashHost(input).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  });
}
