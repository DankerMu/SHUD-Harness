import { MAX_COLLECT_ATTEMPTS, type RunJob } from "@shud-harness/dsh-shud-core";
import type { ShudProcessIdentity } from "./detached-shud.ts";
import type { ExitEvidence } from "./shud-exit.ts";
import type { ProcessBirthObservation } from "./process-birth.ts";

export interface ReconcileProcess extends ShudProcessIdentity {
  state: string;
}

type PendingReconcileSnapshot =
  | { status: "created" }
  | {
      status: "submitted";
      submitted_at: string | null;
      exit: ExitEvidence | undefined;
      wrapper: ProcessBirthObservation | null;
    }
  | {
      status: "running";
      identity: ShudProcessIdentity;
      cancel_requested_at: string | null;
      exit: ExitEvidence | undefined;
      process: ReconcileProcess | null;
    }
  | {
      status: "succeeded" | "failed" | "cancelled";
      collection: { committed: boolean; attempts: number };
    }
  | { status: "collected" };

export type ReconcileSnapshot =
  | (PendingReconcileSnapshot & { notify: "pending" })
  | { status: RunJob["status"]; notify: "delivered" | "unreachable" };

export type ReconcileDecision =
  | { row: "R1" | "R4" | "R7"; action: "settle-lost" }
  | { row: "R2" | "R6"; action: "settle-exit"; evidence: ExitEvidence }
  | { row: "R3"; action: "promote"; identity: ShudProcessIdentity }
  | { row: "R5"; action: "monitor" }
  | { row: "R7"; action: "settle-cancelled" }
  | { row: "R8"; action: "cancel-group" }
  | { row: "R9"; action: "collect" }
  | { row: "R10"; action: "retain-terminal" }
  | { row: "R11"; action: "retain-collected" }
  | { row: "R12"; action: "complete-index" };

/** All observations are supplied by the shell, including exit evidence after a non-live probe. */
export function reconcileEntry(snapshot: ReconcileSnapshot): ReconcileDecision {
  if (snapshot.notify !== "pending") return { row: "R12", action: "complete-index" };
  if (snapshot.status === "collected") return { row: "R11", action: "retain-collected" };
  if (snapshot.status === "created") return { row: "R1", action: "settle-lost" };
  if (snapshot.status === "running") {
    if (snapshot.exit) return { row: "R6", action: "settle-exit", evidence: snapshot.exit };
    const observed = snapshot.process;
    const live =
      observed !== null &&
      !observed.state.startsWith("Z") &&
      observed.pid === snapshot.identity.pid &&
      Date.parse(observed.pid_started_at) === Date.parse(snapshot.identity.pid_started_at);
    if (!live) {
      return {
        row: "R7",
        action: snapshot.cancel_requested_at === null ? "settle-lost" : "settle-cancelled",
      };
    }
    return snapshot.cancel_requested_at === null
      ? { row: "R5", action: "monitor" }
      : { row: "R8", action: "cancel-group" };
  }
  if (snapshot.status === "submitted") {
    if (snapshot.exit) return { row: "R2", action: "settle-exit", evidence: snapshot.exit };
    if (snapshot.submitted_at === null || !Number.isFinite(Date.parse(snapshot.submitted_at)))
      throw new Error(
        "Submitted recovery requires a valid submitted_at for identity classification",
      );
    const wrapper = snapshot.wrapper;
    if (wrapper && !wrapper.state.startsWith("Z")) {
      if (!Number.isSafeInteger(wrapper.birthLatestMs) || wrapper.birthLatestMs < 0)
        throw new Error("Invalid comparable process birth bound");
      if (wrapper.birthLatestMs >= Math.floor(Date.parse(snapshot.submitted_at) / 1000) * 1000) {
        return {
          row: "R3",
          action: "promote",
          identity: { pid: wrapper.pid, pid_started_at: wrapper.pid_started_at },
        };
      }
    }
    return { row: "R4", action: "settle-lost" };
  }
  return !snapshot.collection.committed && snapshot.collection.attempts >= MAX_COLLECT_ATTEMPTS
    ? { row: "R10", action: "retain-terminal" }
    : { row: "R9", action: "collect" };
}
