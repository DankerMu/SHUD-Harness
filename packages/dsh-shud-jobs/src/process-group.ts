import type { ShudProcessIdentity } from "./detached-shud.ts";
import { groupCanPerformIo, processExecutionState } from "./process-identity.ts";

export interface ShudProcessGroup {
  isGroupActive(): boolean;
  signalGroup(signal: "SIGTERM" | "SIGKILL"): void;
}

/** Each owner supplies its own proof; signal failure is harmless only after proven quiescence. */
export function signalOwnedProcessGroup(
  pid: number,
  signal: "SIGTERM" | "SIGKILL",
  isGroupActive: () => boolean,
): void {
  if (!isGroupActive()) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error)) throw error;
    if (error.code === "EPERM" || error.code === "ESRCH") {
      let active: boolean;
      try {
        active = isGroupActive();
      } catch (inspection) {
        throw new AggregateError(
          [error, inspection],
          `Cannot prove quiescence after signal failure for group ${pid}`,
          { cause: inspection },
        );
      }
      if (!active) return;
    }
    throw error;
  }
}

/** Establish restart ownership while the recorded leader is live, then retain its group identity. */
export function recoverProcessGroup(identity: ShudProcessIdentity): ShudProcessGroup {
  const { pid, pid_started_at: startedAt } = identity;
  const observed = processExecutionState(pid);
  if (
    !observed ||
    observed.state.startsWith("Z") ||
    Date.parse(`${observed.stamp} UTC`) !== Date.parse(startedAt)
  ) {
    throw new Error(`Cannot establish ownership of recovered process group ${pid}`);
  }
  let leaderMissing = false;
  function isGroupActive(): boolean {
    if (!groupCanPerformIo(pid)) return false;
    const leader = processExecutionState(pid);
    if (leader) {
      if (leaderMissing || Date.parse(`${leader.stamp} UTC`) !== Date.parse(startedAt)) {
        throw new Error(`Cannot prove ownership of reused process group ${pid}`);
      }
    } else leaderMissing = true;
    return true;
  }
  return {
    isGroupActive,
    signalGroup: (signal) => signalOwnedProcessGroup(pid, signal, isGroupActive),
  };
}
