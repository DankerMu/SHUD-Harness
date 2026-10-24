import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { ShudProcessIdentity } from "./detached-shud.ts";
import { processExecutionState, type ProcessExecutionObservation } from "./process-identity.ts";

export interface ProcessBirthObservation extends ShudProcessIdentity {
  state: string;
  birthLatestMs: number;
}

export interface LinuxBirthSample {
  startTicks: number;
  clockTicksPerSecond: number;
  uptimeBeforeCentiseconds: number;
  uptimeAfterCentiseconds: number;
  wallBeforeMs: number;
  wallAfterMs: number;
}

export interface BirthObservationBounds {
  latestAtBeginMs: number;
  latestAtEndMs: number;
}

const SECOND_MS = 1000;
const CENTISECOND_MS = 10;
let clockTicksPerSecond: number | undefined;

/** Bounds on the latest-birth estimate, varying only the measured sampling bracket/skew. */
export function linuxBirthBounds(sample: LinuxBirthSample): BirthObservationBounds {
  const { startTicks, clockTicksPerSecond: hz, wallBeforeMs, wallAfterMs } = sample;
  const before = sample.uptimeBeforeCentiseconds;
  const after = sample.uptimeAfterCentiseconds;
  if (
    !Number.isSafeInteger(startTicks) ||
    startTicks < 0 ||
    !Number.isSafeInteger(hz) ||
    hz <= 0 ||
    !Number.isSafeInteger(before) ||
    before < 0 ||
    !Number.isSafeInteger(after) ||
    after < before ||
    !Number.isSafeInteger(wallBeforeMs) ||
    wallBeforeMs < 0 ||
    !Number.isSafeInteger(wallAfterMs) ||
    wallAfterMs < wallBeforeMs ||
    !Number.isSafeInteger((startTicks + 1) * SECOND_MS) ||
    !Number.isSafeInteger((after + 1) * CENTISECOND_MS) ||
    !Number.isSafeInteger(wallAfterMs + 1)
  ) {
    throw new Error("Invalid native process birth clock sample");
  }
  // uptime truncates centiseconds; a process cannot start beyond its upper quantization edge.
  if (startTicks / hz >= (after + 1) / 100)
    throw new Error("Inconsistent native process birth age");
  const tickUpperMs = ((startTicks + 1) * SECOND_MS) / hz;
  const latestAtBeginMs = Math.floor(wallBeforeMs - after * CENTISECOND_MS + tickUpperMs);
  // Date.now also truncates: its upper millisecond edge belongs in the conservative upper bound.
  const latestAtEndMs = Math.ceil(wallAfterMs + 1 - before * CENTISECOND_MS + tickUpperMs);
  if (
    !Number.isSafeInteger(latestAtBeginMs) ||
    latestAtBeginMs < 0 ||
    !Number.isSafeInteger(latestAtEndMs) ||
    latestAtEndMs < latestAtBeginMs ||
    latestAtEndMs - latestAtBeginMs >= SECOND_MS
  ) {
    throw new Error("Uncertain native process birth clock bracket");
  }
  return { latestAtBeginMs, latestAtEndMs };
}

export function selectBirthLatest(
  bounds: BirthObservationBounds,
  submissionSecondMs: number,
): number {
  if (
    !Number.isSafeInteger(submissionSecondMs) ||
    submissionSecondMs % SECOND_MS !== 0 ||
    !Number.isSafeInteger(bounds.latestAtBeginMs) ||
    !Number.isSafeInteger(bounds.latestAtEndMs) ||
    bounds.latestAtBeginMs > bounds.latestAtEndMs
  ) {
    throw new Error("Invalid process birth comparison bounds");
  }
  if (bounds.latestAtBeginMs < submissionSecondMs && bounds.latestAtEndMs >= submissionSecondMs)
    throw new Error("Uncertain process birth at the submission-second boundary");
  return bounds.latestAtEndMs;
}

function linuxClockTicks(): number {
  if (clockTicksPerSecond !== undefined) return clockTicksPerSecond;
  const result = spawnSync("getconf", ["CLK_TCK"], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" },
  });
  const token = result.stdout?.trim() ?? "";
  const hz = Number(token);
  if (
    result.error ||
    result.signal ||
    result.status !== 0 ||
    result.stderr?.trim() ||
    !/^\d+$/u.test(token) ||
    !Number.isSafeInteger(hz) ||
    hz <= 0
  ) {
    throw new Error("Cannot determine native process birth clock ticks");
  }
  clockTicksPerSecond = hz;
  return hz;
}

function readProcState(pid: number): { startTicks: number; state: string } | null {
  let text: string;
  try {
    text = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw new Error("Cannot read native process birth state", { cause: error });
  }
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  const prefix = text.slice(0, open).trim();
  const fields = text
    .slice(close + 1)
    .trim()
    .split(/\s+/u);
  const ticks = fields[19]; // Fields after comm begin at 3; starttime is field 22.
  if (
    open <= 0 ||
    close <= open ||
    !/^\d+$/u.test(prefix) ||
    Number(prefix) !== pid ||
    fields.length < 20 ||
    !/^[RSDZTtWXxKPI]$/u.test(fields[0]) ||
    !/^\d+$/u.test(ticks)
  ) {
    throw new Error("Invalid native process birth state");
  }
  const startTicks = Number(ticks);
  if (!Number.isSafeInteger(startTicks) || startTicks < 0)
    throw new Error("Invalid native process birth start ticks");
  return { startTicks, state: fields[0] };
}

function readUptimeCentiseconds(): number {
  let text: string;
  try {
    text = readFileSync("/proc/uptime", "utf8");
  } catch {
    throw new Error("Cannot read native process birth uptime");
  }
  const fields = text.trim().split(/\s+/u);
  if (fields.length !== 2 || fields.some((field) => !/^\d+\.\d{2}$/u.test(field)))
    throw new Error("Invalid native process birth uptime");
  const values = fields.map((field) => Number(field.replace(".", "")));
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0))
    throw new Error("Invalid native process birth uptime");
  return values[0];
}

/** Linux's lstart epoch remains identity only; kernel age supplies realtime freshness separately. */
export function linuxProcessBirth(
  pid: number,
  submissionSecondMs: number,
): ProcessBirthObservation | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid process birth pid");
  let before: ProcessExecutionObservation | null;
  try {
    before = processExecutionState(pid);
  } catch {
    throw new Error("Cannot inspect native process birth identity");
  }
  if (!before || before.state.startsWith("Z")) return null;
  const hz = linuxClockTicks();
  const wallBeforeMs = Date.now();
  const first = readProcState(pid);
  if (!first || first.state === "Z" || first.state === "X" || first.state === "x") return null;
  const uptimeBeforeCentiseconds = readUptimeCentiseconds();
  const last = readProcState(pid);
  if (!last || last.state === "Z" || last.state === "X" || last.state === "x") return null;
  const uptimeAfterCentiseconds = readUptimeCentiseconds();
  const wallAfterMs = Date.now();
  let after: ProcessExecutionObservation | null;
  try {
    after = processExecutionState(pid);
  } catch {
    throw new Error("Cannot recheck native process birth identity");
  }
  if (!after || after.state.startsWith("Z")) return null;
  if (first.startTicks !== last.startTicks || before.stamp !== after.stamp)
    throw new Error("Native process birth identity changed during observation");
  const bounds = linuxBirthBounds({
    startTicks: first.startTicks,
    clockTicksPerSecond: hz,
    uptimeBeforeCentiseconds,
    uptimeAfterCentiseconds,
    wallBeforeMs,
    wallAfterMs,
  });
  return {
    pid,
    pid_started_at: new Date(`${after.stamp} UTC`).toISOString(),
    state: after.state,
    birthLatestMs: selectBirthLatest(bounds, submissionSecondMs),
  };
}

export function processBirthObservation(
  pid: number,
  submissionSecondMs: number,
): ProcessBirthObservation | null {
  if (process.platform === "linux") return linuxProcessBirth(pid, submissionSecondMs);
  if (process.platform !== "darwin") throw new Error("Unsupported native process birth platform");
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid process birth pid");
  let observed: ProcessExecutionObservation | null;
  try {
    observed = processExecutionState(pid);
  } catch {
    throw new Error("Cannot inspect native process birth identity");
  }
  if (!observed || observed.state.startsWith("Z")) return null;
  const stamp = new Date(`${observed.stamp} UTC`).toISOString();
  return { pid, pid_started_at: stamp, state: observed.state, birthLatestMs: Date.parse(stamp) };
}
