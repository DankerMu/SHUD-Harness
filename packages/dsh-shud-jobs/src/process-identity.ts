import * as childProcess from "node:child_process";

export function isStartStamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Z][a-z]{2} [A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/u.test(value) &&
    Number.isFinite(Date.parse(`${value} UTC`))
  );
}

function processOutput(pid: number, columns: string): string | null {
  const result = childProcess.spawnSync("ps", ["-p", String(pid), "-o", columns], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" },
  });
  if (result.error || result.signal || result.stderr.trim()) {
    throw new Error(`Cannot inspect process start identity for pid ${pid}: ps failed`, {
      cause: result.error ?? new Error(result.stderr || String(result.signal)),
    });
  }
  const stamp = result.stdout.trim();
  if (result.status === 0) return stamp;
  if (result.status === 1 && stamp === "") {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return null;
    }
  }
  throw new Error(
    `Cannot determine process start identity for pid ${pid}: ps status ${result.status}`,
  );
}

/** Raw OS identity for lock/startup comparisons, including zombies; lstart resolution is seconds. */
export function processStart(pid: number): string | null {
  const stamp = processOutput(pid, "lstart=");
  if (stamp === null || isStartStamp(stamp)) return stamp;
  throw new Error(`Cannot determine process start identity for pid ${pid}: ps status 0`);
}

/** One native snapshot couples identity and execution state without hiding zombie start identities. */
export function processExecutionState(pid: number): { stamp: string; state: string } | null {
  const output = processOutput(pid, "lstart=,stat=");
  if (output === null) return null;
  const match = /^(.*\S)\s+(\S+)$/u.exec(output);
  if (!match || !isStartStamp(match[1])) {
    throw new Error(`Cannot determine process execution state for pid ${pid}: malformed ps output`);
  }
  return { stamp: match[1], state: match[2] };
}

/** Cleanup proof only: a zombie cannot execute further file I/O, unlike a live descendant. */
export function groupCanPerformIo(pgid: number): boolean {
  const result = childProcess.spawnSync("ps", ["-axo", "pid=,pgid=,stat="], {
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
    throw new Error(`Cannot inspect owned process group ${pgid}`, {
      cause: result.error ?? new Error(result.stderr || `ps status ${result.status}`),
    });
  }
  let active = false;
  for (const line of result.stdout.trim().split("\n")) {
    const fields = line.trim().split(/\s+/u);
    const [pid, group, state] = fields;
    if (
      fields.length !== 3 ||
      !/^\d+$/u.test(pid) ||
      !/^\d+$/u.test(group) ||
      !Number.isSafeInteger(Number(pid)) ||
      !Number.isSafeInteger(Number(group))
    ) {
      throw new Error(`Cannot determine members of owned process group ${pgid}`);
    }
    // Native unknown states (for example Darwin "?s") can still perform I/O; only Z proves otherwise.
    if (Number(group) === pgid && !state.startsWith("Z")) active = true;
  }
  return active;
}
