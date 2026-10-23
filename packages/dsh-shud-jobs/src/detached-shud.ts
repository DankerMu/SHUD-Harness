import * as childProcess from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { JobHooks } from "@deepseek-ai/dsh-jobs";
import type { RunJob } from "@shud-harness/dsh-shud-core";
import { groupCanPerformIo, processStart } from "./process-identity.ts";

export interface ShudProcessIdentity {
  pid: number;
  pid_started_at: string;
}

export interface ShudExecution {
  hooks: JobHooks;
  started: Promise<ShudProcessIdentity>;
  /** Rollback only: terminate this owned execution group and prove it can no longer perform I/O. */
  abort(): Promise<void>;
}

const WRAPPER = String.raw`printf '%s\n' "$$" > wrapper.pid.tmp || exit 1
[ ! -d wrapper.pid ] || exit 1
/bin/mv -f wrapper.pid.tmp wrapper.pid || exit 1
"$@"
code=$?
printf '%s\n' "$code" > exit_code.tmp || exit 1
[ ! -d exit_code ] || exit 1
/bin/mv -f exit_code.tmp exit_code || exit 1
exit "$code"
`;

/** Starts only execution. Supplied hooks own registration settlement; exit_code owns model outcome. */
export function startDetachedShud(
  prepared: RunJob,
  hooks: JobHooks,
  pumpPollMs: number,
): ShudExecution {
  let resolveStarted!: (identity: ShudProcessIdentity) => void;
  let rejectStarted!: (error: Error) => void;
  const started = new Promise<ShudProcessIdentity>((resolve, reject) => {
    resolveStarted = resolve;
    rejectStarted = reject;
  });
  let resolveReaped!: () => void;
  const reaped = new Promise<void>((resolve) => {
    resolveReaped = resolve;
  });
  let child: childProcess.ChildProcess | undefined;
  let stdout: number | undefined;
  let stderr: number | undefined;
  let identity: ShudProcessIdentity | undefined;
  const failures: unknown[] = [];
  try {
    if (!Number.isFinite(pumpPollMs) || pumpPollMs <= 0) {
      throw new Error("Detached execution requires the resolved parent pumpPollMs");
    }
    stdout = openSync(
      join(prepared.run_dir, "stdout.log"),
      constants.O_WRONLY | constants.O_APPEND,
    );
    stderr = openSync(
      join(prepared.run_dir, "stderr.log"),
      constants.O_WRONLY | constants.O_APPEND,
    );
    child = childProcess.spawn("/bin/sh", ["-c", WRAPPER, "shud-wrapper", ...prepared.command], {
      cwd: prepared.run_dir,
      detached: true,
      stdio: ["ignore", stdout, stderr],
    });
    const launched = child;
    launched.once("error", (error: Error) => {
      rejectStarted(error);
      // A failed spawn has no process to reap and need not emit exit.
      if (launched.pid === undefined) resolveReaped();
    });
    launched.once("exit", () => resolveReaped());
    launched.unref();
    if (launched.pid !== undefined) {
      // No await before inspection: already-exited, unreaped children still have their OS stamp.
      const stamp = processStart(launched.pid);
      if (stamp === null) throw new Error(`Cannot inspect newly spawned wrapper ${launched.pid}`);
      identity = { pid: launched.pid, pid_started_at: new Date(`${stamp} UTC`).toISOString() };
    }
  } catch (error) {
    failures.push(error);
  } finally {
    if (stdout !== undefined) {
      try {
        closeSync(stdout);
      } catch (error) {
        failures.push(error);
      }
    }
    if (stderr !== undefined) {
      try {
        closeSync(stderr);
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length > 0) {
    const failure =
      failures.length === 1
        ? failures[0]
        : new AggregateError(failures, "Detached wrapper startup and descriptor cleanup failed", {
            cause: failures[0],
          });
    rejectStarted(
      failure instanceof Error
        ? failure
        : new Error("Detached wrapper startup failed", { cause: failure }),
    );
  } else if (identity) resolveStarted(identity);

  let aborting: Promise<void> | undefined;
  function abort(): Promise<void> {
    return (aborting ??= abortOwnedGroup());
  }
  async function abortOwnedGroup(): Promise<void> {
    if (!child) return;
    const ownedChild = child;
    // Keep local reaping alive even for a standalone caller whose only remaining handle was unref'ed.
    ownedChild.ref();
    try {
      const pid = ownedChild.pid;
      if (pid !== undefined && groupCanPerformIo(pid)) {
        // A reaped child cannot still occupy its pid. Never signal a replacement leader.
        // This detects observable reuse, not a replacement generation whose leader has also exited.
        if (
          (ownedChild.exitCode !== null || ownedChild.signalCode !== null) &&
          processStart(pid) !== null
        ) {
          throw new Error(`Cannot prove ownership of reused process group ${pid}`);
        }
        // The target comes only from this local transaction's spawn, never persisted metadata.
        try {
          process.kill(-pid, "SIGKILL");
        } catch (error) {
          if (!(error instanceof Error && "code" in error)) throw error;
          if (error.code === "EPERM") {
            let active: boolean;
            try {
              active = groupCanPerformIo(pid);
            } catch (inspection) {
              throw new AggregateError(
                [error, inspection],
                `Cannot prove quiescence after signal denial for group ${pid}`,
                {
                  cause: inspection,
                },
              );
            }
            if (active) throw error;
          } else if (error.code !== "ESRCH") throw error;
        }
      }
      await reaped;
      if (pid !== undefined) {
        while (groupCanPerformIo(pid)) await delay(pumpPollMs);
      }
    } finally {
      ownedChild.unref();
    }
  }
  return { hooks, started, abort };
}
