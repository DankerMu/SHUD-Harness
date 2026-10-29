import type { TaskCard, TaskRuntimePhase, TaskStatus } from "@shud-harness/dsh-shud-core";

/** Facts established by the caller, not approval credentials or closure evidence. */
export type TaskEvent =
  | { type: "task_create" }
  | { type: "shud_run" }
  | { type: "reconcile" }
  | { type: "report_generate" }
  | { type: "report_submit" }
  | { type: "report_decide"; disposition: "revision_requested" | "rejected" };

/** Controlled diagnostics deliberately exclude card text and untrusted event payloads. */
export class TaskTransitionError extends Error {
  constructor(readonly reason: "invalid_event" | "invalid_transition") {
    super(`Task transition failed: ${reason}`);
    this.name = "TaskTransitionError";
  }
}

/**
 * Apply the M3 transition table without IO or input mutation. Creation starts from an
 * in-memory created card; no event produces a persisted transient/forbidden state.
 * Callers own successful submission, closure and allowed-once approval prerequisites,
 * link updates and persistence. Only status, runtime_phase and updated_at change here.
 * An explicit Date is used verbatim; otherwise the clock is read only after acceptance.
 */
export function transitionTask(card: TaskCard, event: TaskEvent, now?: Date): TaskCard {
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    throw new TaskTransitionError("invalid_event");
  }

  let status: TaskStatus | undefined;
  let runtime_phase: TaskRuntimePhase | null = null;
  switch (event.type) {
    case "task_create":
      if (card.status === "created") status = "planned";
      break;
    case "shud_run":
      if (card.status === "planned" || card.status === "running") status = "running";
      runtime_phase = "submitted_job";
      break;
    case "reconcile":
      if (card.status === "planned") status = "running";
      runtime_phase = "submitted_job";
      break;
    case "report_generate":
      if (card.status === "planned" || card.status === "running" || card.status === "reporting") {
        status = "reporting";
      }
      break;
    case "report_submit":
      if (card.status === "reporting") status = "done";
      break;
    case "report_decide":
      if (event.disposition !== "revision_requested" && event.disposition !== "rejected") {
        throw new TaskTransitionError("invalid_event");
      }
      if (card.status === "reporting") {
        status = event.disposition === "revision_requested" ? "planned" : "cancelled";
      }
      break;
    default:
      throw new TaskTransitionError("invalid_event");
  }

  if (status === undefined) throw new TaskTransitionError("invalid_transition");
  return { ...card, status, runtime_phase, updated_at: (now ?? new Date()).toISOString() };
}
