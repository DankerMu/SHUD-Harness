import * as io from "node:fs/promises";
import { join } from "node:path";
import type { JobOutcome } from "@deepseek-ai/dsh-jobs";
import { RunJobSchema, type RunId, type RunJob } from "@shud-harness/dsh-shud-core";
import type { ShudLifecycle } from "./detached-shud.ts";
import { processExecutionState } from "./process-identity.ts";
import { writeJson } from "./state-files.ts";
import type { IndexEntry, StateIndexStore } from "./state-indexes.ts";

export interface CompletionReceipt {
  lifecycle: ShudLifecycle;
  /** Retain the precise diagnostic across completion retries, without rewriting durable evidence. */
  outcome?: JobOutcome;
}

type ExitEvidence = { code: number; error?: never } | { error: Error; code?: never };

async function readExit(runDir: string): Promise<ExitEvidence | undefined> {
  const path = join(runDir, "exit_code");
  let text: string;
  try {
    text = await io.readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    return { error: new Error(`Unreadable exit_code at ${path}`, { cause: error }) };
  }
  const token = text.trim();
  const code = Number(token);
  if (!/^[+-]?\d+$/u.test(token) || !Number.isSafeInteger(code)) {
    return { error: new Error(`Invalid exit_code integer at ${path}`) };
  }
  return { code };
}

function terminalOutcome(record: RunJob): JobOutcome {
  if (record.status === "succeeded")
    return { status: "completed", detail: `SHUD exited with code ${record.exit_code}` };
  if (record.status === "cancelled")
    return { status: "killed", detail: "SHUD cancelled without an exit code" };
  return {
    status: "failed",
    detail:
      record.exit_code === null
        ? "SHUD failed without a recorded exit code"
        : `SHUD exited with code ${record.exit_code}`,
  };
}

/** One cadence and one per-run exclusion map serve timer ticks and public manual ticks alike. */
export class ShudPoll {
  private readonly steps = new Map<RunId, Promise<void>>();
  private accepting = true;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly indexes: StateIndexStore;
  private readonly receipts: Map<RunId, CompletionReceipt>;
  private readonly inSubmission: (id: RunId) => boolean;
  private readonly pumpPollMs: number;
  private readonly report: (error: Error) => void;

  constructor(
    indexes: StateIndexStore,
    receipts: Map<RunId, CompletionReceipt>,
    inSubmission: (id: RunId) => boolean,
    pumpPollMs: number,
    report: (error: Error) => void,
  ) {
    this.indexes = indexes;
    this.receipts = receipts;
    this.inSubmission = inSubmission;
    this.pumpPollMs = pumpPollMs;
    this.report = report;
  }

  start(): void {
    if (!this.accepting || this.timer) return;
    this.timer = setInterval(() => this.dispatch(), this.pumpPollMs);
    this.timer.unref();
  }

  pollOnce(): Promise<void> {
    if (!this.accepting) return Promise.reject(new Error("SHUD poll admission is closed"));
    const operations: Promise<void>[] = [];
    this.dispatch(operations);
    return Promise.all(operations).then(() => undefined);
  }

  /** Timers do not accumulate waiters behind slow entries; manual ticks join accepted work. */
  private dispatch(joined?: Promise<void>[]): void {
    if (!this.accepting) return;
    for (const entry of this.indexes.read().active) {
      if (this.inSubmission(entry.run_id)) continue;
      let operation = this.steps.get(entry.run_id);
      if (!operation) {
        operation = this.runStep(entry);
        this.steps.set(entry.run_id, operation);
      }
      joined?.push(operation);
    }
  }

  private async runStep(entry: IndexEntry): Promise<void> {
    try {
      await this.step(entry);
    } catch (error) {
      this.report(
        new Error(`Cannot poll SHUD run ${entry.run_id} at ${entry.run_dir}`, { cause: error }),
      );
    } finally {
      this.steps.delete(entry.run_id);
    }
  }

  private async step(entry: IndexEntry): Promise<void> {
    const path = join(entry.run_dir, "run-job.json");
    const record = RunJobSchema.parse(JSON.parse(await io.readFile(path, "utf8")));
    if (
      record.run_id !== entry.run_id ||
      record.job_id !== entry.job_id ||
      record.run_dir !== entry.run_dir
    ) {
      throw new Error(
        `RunJob identity/path does not match its active index entry: ${entry.run_id}`,
      );
    }
    if (
      record.notify.status !== "pending" ||
      record.status === "collected" ||
      record.status === "created" ||
      record.status === "submitted"
    )
      return;
    const receipt = this.receipts.get(record.run_id);
    if (record.status !== "running") {
      if (receipt) await this.complete(record, receipt);
      return;
    }

    let evidence = await readExit(record.run_dir);
    if (!evidence) {
      if (record.pid === null || record.pid_started_at === null) {
        throw new Error(`Running record lacks process identity: ${record.run_id}`);
      }
      const observed = processExecutionState(record.pid);
      if (
        observed &&
        !observed.state.startsWith("Z") &&
        Date.parse(`${observed.stamp} UTC`) === Date.parse(record.pid_started_at)
      )
        return;
      // Publication can race the death/identity observation. Exit evidence still wins over cancellation.
      evidence = await readExit(record.run_dir);
    }

    let status: "succeeded" | "failed" | "cancelled";
    let code: number | null = null;
    let outcome: JobOutcome;
    if (evidence && evidence.code !== undefined) {
      code = evidence.code;
      status = code === 0 ? "succeeded" : "failed";
      outcome = {
        status: code === 0 ? "completed" : "failed",
        detail: `SHUD exited with code ${code}`,
      };
    } else if (evidence?.error) {
      status = "failed";
      outcome = { status: "failed", detail: evidence.error.message };
      this.report(evidence.error);
    } else if (record.cancel_requested_at !== null) {
      status = "cancelled";
      outcome = { status: "killed", detail: "SHUD cancelled without an exit code" };
    } else {
      status = "failed";
      outcome = {
        status: "failed",
        detail: "SHUD lost: wrapper no longer executing and exit_code is absent",
      };
    }
    const terminal = RunJobSchema.parse({
      ...record,
      status,
      exit_code: code,
      finished_at: new Date().toISOString(),
    });
    await writeJson(path, terminal);
    if (receipt) {
      receipt.outcome = outcome;
      await this.complete(terminal, receipt);
    }
  }

  private async complete(record: RunJob, receipt: CompletionReceipt): Promise<void> {
    await receipt.lifecycle.settle(receipt.outcome ?? terminalOutcome(record));
    await receipt.lifecycle.done;
    this.receipts.delete(record.run_id);
  }

  stopAdmission(): void {
    this.accepting = false;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  drain(): Promise<void> {
    return Promise.allSettled(this.steps.values()).then(() => undefined);
  }
}
