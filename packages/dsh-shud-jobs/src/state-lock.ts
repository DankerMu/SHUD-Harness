import * as childProcess from "node:child_process";
import { closeSync, openSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJsonSync } from "./state-files.ts";
import { isStartStamp, processStart } from "./process-identity.ts";

interface Owner {
  pid: number;
  pid_started_at: string;
}

function parseOwner(value: unknown, path: string): Owner {
  if (
    typeof value !== "object" ||
    value === null ||
    Object.keys(value).length !== 2 ||
    !("pid" in value) ||
    !("pid_started_at" in value) ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    !isStartStamp(value.pid_started_at)
  ) {
    throw new Error(`Invalid owner metadata in ${path}`);
  }
  return { pid: value.pid, pid_started_at: value.pid_started_at };
}

/** Owns an open-file-description lock; its coordination inode must never be removed. */
export class StateLock {
  private fd: number | undefined;
  private readonly metadata: string;

  constructor(stateDir: string) {
    this.metadata = join(stateDir, "lock");
    const platform = process.platform;
    if (platform !== "darwin" && platform !== "linux") {
      throw new Error(`Cannot lock stateDir ${stateDir}: unsupported platform ${platform}`);
    }
    const fd = openSync(join(stateDir, ".lock-guard"), "a", 0o600);
    try {
      const command = platform === "darwin" ? "/usr/bin/lockf" : "/usr/bin/flock";
      const args = platform === "darwin" ? ["-s", "-t", "0", "3"] : ["-n", "3"];
      const result = childProcess.spawnSync(command, args, {
        stdio: ["ignore", "ignore", "pipe", fd],
        encoding: "utf8",
      });
      if (!result.error && !result.signal && result.status === (platform === "darwin" ? 75 : 1)) {
        const recorded = readJson(this.metadata);
        const detail =
          recorded === undefined
            ? "ownership publication contention (holder metadata not yet available)"
            : `held by pid ${parseOwner(recorded, this.metadata).pid}`;
        throw new Error(`Cannot acquire stateDir ${stateDir}: ${detail}`);
      }
      if (result.error || result.signal || result.status !== 0) {
        throw new Error(`Cannot lock stateDir ${stateDir}: ${command} failed`, {
          cause: result.error ?? new Error(result.stderr || String(result.status)),
        });
      }
      const previous = readJson(this.metadata);
      if (previous !== undefined) {
        const owner = parseOwner(previous, this.metadata);
        if (processStart(owner.pid) === owner.pid_started_at) {
          throw new Error(`Cannot acquire stateDir ${stateDir}: held by pid ${owner.pid}`);
        }
      }
      const started = processStart(process.pid);
      if (started === null)
        throw new Error(`Cannot inspect current process for stateDir ${stateDir}`);
      writeJsonSync(this.metadata, { pid: process.pid, pid_started_at: started });
      this.fd = fd;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  release(): void {
    const fd = this.fd;
    if (fd === undefined) return;
    this.fd = undefined;
    try {
      unlinkSync(this.metadata);
    } finally {
      closeSync(fd);
    }
  }
}
