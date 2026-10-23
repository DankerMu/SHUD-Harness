import { fork, spawnSync } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { JobHandle } from "@deepseek-ai/dsh-jobs";
import { RunJobSchema, type RunJob } from "@shud-harness/dsh-shud-core";
import * as jobs from "../index.ts";
import type { SubmitShudRequest } from "../index.ts";
import { createHarness } from "../test-harness.ts";
import { actualRegistry, registrationResource } from "../submit-shud/test-harness.ts";

const HOST_ARGUMENT = "--detached-shud-host";
const WAIT_MS = 5000;

export interface Invocation {
  pid: number;
  ppid: number;
  port: number | null;
  argv: string[];
  cwd: string;
}

export async function readInvocation(runDir: string): Promise<Invocation | null> {
  try {
    const value: unknown = JSON.parse(await readFile(join(runDir, "invocation.json"), "utf8"));
    if (
      typeof value !== "object" ||
      value === null ||
      !("pid" in value) ||
      typeof value.pid !== "number" ||
      !("ppid" in value) ||
      typeof value.ppid !== "number" ||
      !("port" in value) ||
      (value.port !== null && typeof value.port !== "number") ||
      !("cwd" in value) ||
      typeof value.cwd !== "string" ||
      !("argv" in value) ||
      !Array.isArray(value.argv) ||
      !value.argv.every((part: unknown) => typeof part === "string")
    ) {
      throw new Error("Invalid fake-SHUD invocation receipt");
    }
    return {
      pid: value.pid,
      ppid: value.ppid,
      port: value.port,
      cwd: value.cwd,
      argv: value.argv,
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

export function observedStart(pid: number): string {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" },
  });
  if (result.error || result.status !== 0 || result.stderr.trim()) {
    throw new Error(`Cannot independently inspect test process ${pid}`, { cause: result.error });
  }
  return new Date(`${result.stdout.trim()} UTC`).toISOString();
}

/** A separate inspector observes Z while the calling Node host is blocked and cannot reap. */
export function waitForUnreapedWrapper(runDir: string, requireExitCode = true): number {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `
    const fs = require("node:fs");
    const cp = require("node:child_process");
    const directory = process.argv[1];
    const requireExitCode = process.argv[2] === "true";
    const deadline = Date.now() + 5000;
    const pause = new Int32Array(new SharedArrayBuffer(4));
    for (;;) {
      if (Date.now() > deadline) throw new Error("No unreaped wrapper reached the Z barrier");
      if ((!requireExitCode || fs.existsSync(directory + "/exit_code")) && fs.existsSync(directory + "/wrapper.pid")) {
        const pid = Number(fs.readFileSync(directory + "/wrapper.pid", "utf8"));
        const observed = cp.spawnSync("ps", ["-p", String(pid), "-o", "pid=,pgid=,stat="], {
          encoding: "utf8", env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" },
        });
        const fields = observed.stdout.trim().split(/\\s+/);
        if (observed.status === 0 && !observed.stderr.trim() && fields.length === 3
          && Number(fields[0]) === pid && Number(fields[1]) === pid && fields[2].startsWith("Z")) {
          const group = cp.spawnSync("ps", ["-axo", "pid=,pgid=,stat="], {
            encoding: "utf8", env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" },
          });
          if (group.status !== 0 || group.stderr.trim() || !group.stdout.trim()) {
            throw new Error("Independent group inspection failed at the Z barrier");
          }
          const rows = group.stdout.trim().split("\\n").map(line => line.trim().split(/\\s+/));
          if (rows.some(row => row.length !== 3 || !/^\\d+$/.test(row[0]) || !/^\\d+$/.test(row[1]))) {
            throw new Error("Malformed native group snapshot at the Z barrier");
          }
          if (!rows.some(row => Number(row[1]) === pid && !row[2].startsWith("Z"))) {
            process.stdout.write(String(pid));
            break;
          }
        }
      }
      Atomics.wait(pause, 0, 0, 5);
    }
  `,
      runDir,
      String(requireExitCode),
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  if (result.error || result.status !== 0 || result.stderr.trim()) {
    throw new Error(`Independent wrapper Z barrier failed: ${result.stderr}`, {
      cause: result.error,
    });
  }
  const pid = Number(result.stdout.trim());
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Invalid wrapper pid from Z barrier");
  return pid;
}

export function activeGroup(pid: number): number[] {
  const result = spawnSync("ps", ["-axo", "pid=,pgid=,stat="], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" },
  });
  if (
    result.error ||
    result.signal ||
    result.status !== 0 ||
    result.stderr.trim() ||
    !result.stdout.trim()
  ) {
    throw new Error("Cannot independently inspect owned test process group", {
      cause: result.error,
    });
  }
  return result.stdout
    .trim()
    .split("\n")
    .flatMap((line) => {
      const fields = line.trim().split(/\s+/u);
      const [member, group, state] = fields;
      if (
        fields.length !== 3 ||
        !/^\d+$/u.test(member) ||
        !/^\d+$/u.test(group) ||
        !Number.isSafeInteger(Number(member)) ||
        !Number.isSafeInteger(Number(group))
      ) {
        throw new Error(`Invalid native process row while inspecting test group ${pid}: ${line}`);
      }
      return Number(group) === pid && !state.startsWith("Z") ? [Number(member)] : [];
    });
}

export async function terminateGroup(pid: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid)
    throw new Error("Refusing unsafe test process-group cleanup");
  if (activeGroup(pid).length > 0) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error)) throw error;
      if (error.code === "EPERM") {
        let remaining: number[];
        try {
          remaining = activeGroup(pid);
        } catch (inspection) {
          throw new AggregateError(
            [error, inspection],
            "Cannot prove test group quiescence after signal denial",
            { cause: inspection },
          );
        }
        if (remaining.length > 0) throw error;
      } else if (error.code !== "ESRCH") throw error;
    }
  }
  const deadline = Date.now() + WAIT_MS;
  while (activeGroup(pid).length > 0) {
    if (Date.now() >= deadline) throw new Error(`Owned test process group ${pid} did not quiesce`);
    await delay(10);
  }
}

export async function installFakeShud(
  path: string,
  code: number,
  mode: "immediate" | "held" | "descendant" = "immediate",
): Promise<void> {
  const driver = `${path}.cjs`;
  await writeFile(
    driver,
    `const fs = require('node:fs');
const net = require('node:net');
const descendant = process.argv[2] === '--descendant';
function publish(port) {
  fs.writeFileSync('invocation.json.tmp', JSON.stringify({ pid: process.pid, ppid: process.ppid, port, argv: process.argv.slice(descendant ? 3 : 2), cwd: process.cwd() }));
  fs.renameSync('invocation.json.tmp', 'invocation.json');
  fs.writeSync(1, 'fake stdout\\n');
  fs.writeSync(2, 'fake stderr\\n');
}
if (${JSON.stringify(mode)} === 'descendant' && !descendant) {
  const child = require('node:child_process').spawn(process.execPath, [__filename, '--descendant', ...process.argv.slice(2)], { stdio: ['ignore', 1, 2] });
  child.unref();
  process.exit(${code});
} else if (${JSON.stringify(mode)} !== 'immediate') {
  const server = net.createServer(socket => {
    socket.once('data', () => {
      socket.end('released');
      server.close(() => process.exit(${code}));
    });
  });
  server.listen(0, '127.0.0.1', () => publish(server.address().port));
} else {
  publish(null);
  process.exit(${code});
}
`,
  );
  const node = process.execPath.replaceAll("'", "'\\''");
  const program = driver.replaceAll("'", "'\\''");
  await writeFile(path, `#!/bin/sh\nexec '${node}' '${program}' "$@"\n`);
  await chmod(path, 0o700);
}

export async function releaseInvocation(invocation: Invocation): Promise<void> {
  if (invocation.port === null) throw new Error("Fake SHUD is not barrier-held");
  const socket = createConnection(invocation.port, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => socket.end("release\n"));
      socket.resume();
      socket.once("end", resolve);
      socket.once("error", reject);
      socket.setTimeout(WAIT_MS, () =>
        socket.destroy(new Error("Fake-SHUD release acknowledgement timed out")),
      );
    });
  } finally {
    socket.destroy();
  }
}

export function detachedProducer(onCancel?: () => void) {
  const registration = registrationResource();
  const owned: Array<{ abort(): Promise<void> }> = [];
  const groups = new Set<number>();
  const starts: Array<Promise<{ pid: number; pid_started_at: string }>> = [];
  return {
    registration,
    starts,
    start: (record: RunJob, handle: JobHandle, pumpPollMs: number) => {
      const hooks = registration.open(record, handle);
      const lifecycle = {
        done: hooks.done,
        cancel(reason?: string) {
          onCancel?.();
          hooks.cancel(reason);
        },
      };
      try {
        const execution = jobs.startDetachedShud(record, lifecycle, pumpPollMs);
        owned.push(execution);
        const start = execution.started.then(
          (identity: { pid: number; pid_started_at: string }) => {
            groups.add(identity.pid);
            return identity;
          },
        );
        starts.push(start);
        void start.catch(() => undefined);
        return execution;
      } catch (error) {
        registration.finish();
        throw error;
      }
    },
    async cleanup() {
      // Independently kill known owned groups even if the implementation's abort is defective.
      await Promise.allSettled(starts);
      for (const pid of groups) await terminateGroup(pid);
      const failures: unknown[] = [];
      for (const execution of owned) {
        try {
          await execution.abort();
        } catch (error) {
          failures.push(error);
        }
      }
      registration.finish();
      if (failures.length)
        throw new AggregateError(failures, "Detached test execution cleanup failed");
    },
  };
}

/** After independent group quiescence, attempt every remaining fixture release and retain failures. */
export async function cleanupResources(
  actions: readonly (() => Promise<unknown>)[],
): Promise<void> {
  const failures: unknown[] = [];
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "Detached fixture cleanup failed");
}

export interface WrapperHost {
  pid: number;
  record: RunJob;
  kill(): Promise<void>;
  stop(): Promise<void>;
}

export async function createWrapperHost(
  config: { stateDir: string; shudBin: string },
  request: SubmitShudRequest,
): Promise<WrapperHost> {
  const child = fork(
    fileURLToPath(import.meta.url),
    [HOST_ARGUMENT, JSON.stringify({ config, request })],
    {
      execArgv: [],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-8192);
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  let stopping: Promise<void> | undefined;
  function stop() {
    return (stopping ??= stopChild());
  }
  async function stopChild() {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
    const controller = new AbortController();
    const timeout = delay(WAIT_MS, undefined, { signal: controller.signal }).then(() => {
      throw new Error(`Wrapper host did not exit: ${stderr}`);
    });
    const killer = setTimeout(() => child.kill("SIGKILL"), WAIT_MS / 2);
    try {
      if (child.connected) child.disconnect();
      await Promise.race([exited, timeout]);
    } finally {
      clearTimeout(killer);
      controller.abort();
    }
  }
  try {
    const record = await new Promise<RunJob>((resolve, reject) => {
      const timeout = setTimeout(
        () => finish(new Error(`Wrapper host startup timed out: ${stderr}`)),
        WAIT_MS,
      );
      function finish(error?: Error, value?: RunJob) {
        clearTimeout(timeout);
        child.off("error", onError);
        child.off("exit", onExit);
        child.off("message", onMessage);
        if (error) reject(error);
        else if (value) resolve(value);
      }
      function onError(error: Error) {
        finish(error);
      }
      function onExit(code: number | null) {
        finish(new Error(`Wrapper host exited before running (${code}): ${stderr}`));
      }
      function onMessage(value: unknown) {
        if (typeof value !== "object" || value === null) return;
        if ("error" in value) {
          finish(new Error(String(value.error)));
          return;
        }
        if ("record" in value) {
          try {
            finish(undefined, RunJobSchema.parse(value.record));
          } catch (error) {
            finish(
              error instanceof Error ? error : new Error("Invalid host record", { cause: error }),
            );
          }
        }
      }
      child.once("error", onError);
      child.once("exit", onExit);
      child.on("message", onMessage);
    });
    if (child.pid === undefined) throw new Error("Wrapper host has no process id");
    return {
      pid: child.pid,
      record,
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

async function runWrapperHost() {
  const payload = JSON.parse(process.argv[3]) as {
    config: { stateDir: string; shudBin: string };
    request: SubmitShudRequest;
  };
  const h = await createHarness(dirname(payload.config.stateDir));
  const execution = detachedProducer();
  let submission: Promise<unknown> | undefined;
  process.once("disconnect", () => {
    void (async () => {
      await submission?.catch(() => undefined);
      await execution.cleanup();
      await h.dispose();
    })().catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
  });
  try {
    await h.apply(jobs.ShudJobRegistry, payload.config);
    submission = actualRegistry(h.ctx).submitShud(payload.request, execution.start);
    const record = await submission;
    process.send?.({ record });
  } catch (error) {
    process.send?.({ error: String(error) });
    process.disconnect();
  }
}

if (process.argv[2] === HOST_ARGUMENT) await runWrapperHost();
