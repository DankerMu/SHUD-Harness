import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import { RunJobSchema, type RunJob } from "../../packages/dsh-shud-core/src/schemas/run-job.ts";
import {
  RunRecordSchema,
  type RunRecord,
} from "../../packages/dsh-shud-core/src/schemas/run-record.ts";
import type { IndexSnapshot } from "../../packages/dsh-shud-jobs/src/state-indexes.ts";

export function requireFact(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export function object(value: unknown): Record<string, unknown> {
  requireFact(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Expected an object",
  );
  return value as Record<string, unknown>;
}
export function text(value: unknown): string {
  requireFact(typeof value === "string" && value.length > 0, "Expected nonempty text");
  return value;
}

export interface Identity {
  pid: number;
  stamp: string;
}
export interface CanonicalEvent {
  type: string;
  seq: number;
  time: number;
  data: unknown;
}
export interface CanonicalPrefix {
  asOfSeq: number;
  events: CanonicalEvent[];
}
export type RestartSignal = "SIGTERM" | "SIGKILL";
export interface ProcessSample {
  phase: "before" | "offline" | "restarted" | "completion";
  at: number;
  wrapper: Identity | null;
  solvers: Identity[];
}
export interface WrapperFile {
  text: string;
  ino: number;
  mtimeMs: number;
}
export interface RestartEvidence {
  signal: RestartSignal;
  workspace: string;
  sessionId: string;
  canonicalLog: string;
  original: RunJob;
  jobs: RunJob[];
  before: CanonicalPrefix;
  after: CanonicalPrefix;
  hosts: {
    before: Identity;
    after: Identity;
    locks: unknown[];
    stoppedAt: number;
    restartedAt: number;
  };
  samples: ProcessSample[];
  wrapperFiles: WrapperFile[];
  record: RunRecord;
  exitCode: number;
  artifacts: { path: string; size_bytes: number }[];
  indexes: IndexSnapshot;
  inputs: {
    before: Record<string, string>;
    sourceAfter: Record<string, string>;
    copyAfter: Record<string, string>;
  };
}
export interface RestartAssertions {
  stateProgression: true;
  canonicalRunRecord: true;
  noObservedDuplicate: true;
  deliveredWake: true;
  completedOnly: true;
}

interface ToolSubmission {
  job_id: string;
  run_id: string;
  dsh_job_id: string;
  run_dir: string;
}
export function submission(prefix: CanonicalPrefix, workspace: string): ToolSubmission | undefined {
  const calls = prefix.events.filter((event) => event.type === "tool/call");
  requireFact(calls.length <= 1, "First prompt invoked more than one tool");
  if (!calls.length) return undefined;
  const call = object(calls[0].data);
  requireFact(
    call.name === "shud_run" && typeof call.callId === "string" && call.callId.length > 0,
    "First prompt invoked a different or unidentified tool",
  );
  const args = object(JSON.parse(text(call.arguments)) as unknown);
  requireFact(
    text(args.input_dir) === join(workspace, "input/ccw") &&
      !("end_days" in args) &&
      (args.project === undefined || args.project === "ccw"),
    "shud_run did not use unchanged copied full ccw",
  );
  const results = prefix.events.filter(
    (event) =>
      event.type === "tool/result" && object(object(event.data).message).toolCallId === call.callId,
  );
  requireFact(results.length <= 1, "Duplicate canonical tool result");
  if (!results.length) return undefined;
  requireFact(results[0].seq > calls[0].seq, "Tool result precedes its call");
  const data = object(results[0].data);
  const message = object(data.message);
  requireFact(
    !data.error &&
      message.role === "tool" &&
      object(message.source).kind === "tool" &&
      object(message.source).callId === call.callId &&
      message.isError === false &&
      Array.isArray(message.content),
    "shud_run returned a tool error or mismatched message identity",
  );
  const rendered = message.content
    .map((part: unknown) => {
      const item = object(part);
      return item.type === "text" ? text(item.text) : "";
    })
    .join("");
  const match =
    /^SHUD running: job_id=([^,\n]+), run_id=([^,\n]+), dsh_job_id=([^,\n]+), run_dir=([^\n]+)\.\n/u.exec(
      rendered,
    );
  requireFact(match, "Missing canonical shud_run result identifiers");
  const [, job_id, run_id, dsh_job_id, run_dir] = match;
  requireFact(
    run_dir === join(workspace, "runs", run_id),
    "Tool result run directory escapes owned workspace",
  );
  return { job_id, run_id, dsh_job_id, run_dir };
}

export function extendPrefix(before: CanonicalPrefix, after: CanonicalPrefix): void {
  for (const prefix of [before, after]) {
    requireFact(
      Number.isSafeInteger(prefix.asOfSeq) &&
        prefix.asOfSeq >= -1 &&
        Array.isArray(prefix.events) &&
        prefix.events.length === prefix.asOfSeq + 1 &&
        prefix.events.every(
          (event, i) =>
            event.seq === i && typeof event.type === "string" && Number.isFinite(event.time),
        ),
      "Canonical prefix is not a complete dense cut",
    );
  }
  requireFact(
    after.asOfSeq >= before.asOfSeq &&
      before.events.every((event, i) => JSON.stringify(event) === JSON.stringify(after.events[i])),
    "Observed canonical prefix changed or regressed",
  );
}

/** Pure replay seam: the live cases and parent evidence negatives use this same oracle. */
export function assertRestartEvidence(evidence: RestartEvidence): RestartAssertions {
  requireFact(
    evidence.signal === "SIGTERM" || evidence.signal === "SIGKILL",
    "Missing restart signal",
  );
  const original = RunJobSchema.parse(evidence.original);
  requireFact(
    original.status === "running" &&
      original.exit_code === null &&
      original.pid &&
      original.pid_started_at,
    "Missing original running RunJob",
  );
  requireFact(
    original.owner_session === evidence.sessionId &&
      original.input_dir === join(evidence.workspace, "input/ccw") &&
      original.end_days === null &&
      original.project === "ccw",
    "Original owner or input identity mismatch",
  );
  extendPrefix(evidence.before, evidence.after);
  const tool = submission(evidence.before, evidence.workspace);
  requireFact(
    tool &&
      tool.run_id === original.run_id &&
      tool.job_id === original.job_id &&
      tool.run_dir === original.run_dir &&
      tool.dsh_job_id === original.dsh_job_id,
    "Missing or wrong canonical shud_run result",
  );
  const ranks: Record<RunJob["status"], number> = {
    created: 0,
    submitted: 1,
    running: 2,
    succeeded: 3,
    failed: 3,
    cancelled: 3,
    collected: 4,
  };
  requireFact(
    Array.isArray(evidence.jobs) && evidence.jobs.length >= 2,
    "Missing RunJob progression",
  );
  let previous = original;
  let terminal: string | undefined;
  for (const value of evidence.jobs) {
    const job = RunJobSchema.parse(value);
    for (const field of [
      "run_id",
      "job_id",
      "run_dir",
      "input_dir",
      "owner_session",
      "pid",
      "pid_started_at",
      "end_days",
      "project",
    ] as const) {
      requireFact(job[field] === original[field], `RunJob ${field} identity changed`);
    }
    requireFact(
      JSON.stringify(job.command) === JSON.stringify(original.command) &&
        ranks[job.status] >= ranks[previous.status],
      "RunJob state regressed or command changed",
    );
    if (ranks[job.status] === 3) {
      requireFact(
        terminal === undefined || terminal === job.status,
        "RunJob terminal branch changed",
      );
      terminal = job.status;
    }
    requireFact(
      previous.exit_code === null || job.exit_code === previous.exit_code,
      "RunJob exit evidence changed",
    );
    requireFact(
      previous.dsh_job_ids.every((id, i) => job.dsh_job_ids[i] === id),
      "Registration history regressed",
    );
    previous = job;
  }
  requireFact(
    previous.status === "collected" &&
      previous.dsh_job_id &&
      previous.dsh_job_id !== original.dsh_job_id &&
      previous.dsh_job_ids.includes(text(original.dsh_job_id)) &&
      previous.dsh_job_ids.includes(previous.dsh_job_id),
    "Restart did not retain history and create current registration",
  );
  const record = RunRecordSchema.parse(evidence.record);
  requireFact(
    record.run_id === original.run_id &&
      record.job_id === original.job_id &&
      JSON.stringify(record.command) === JSON.stringify(original.command) &&
      typeof record.exit_code === "number" &&
      record.exit_code === evidence.exitCode &&
      previous.exit_code === record.exit_code &&
      record.artifacts.files.length > 0,
    "Missing or wrong canonical RunRecord/exit/artifacts",
  );
  requireFact(
    record.artifacts.shud_output === join(original.run_dir, "output/ccw.out") &&
      Array.isArray(evidence.artifacts) &&
      JSON.stringify(evidence.artifacts) === JSON.stringify(record.artifacts.files) &&
      evidence.artifacts.some((file) => file.size_bytes > 0),
    "RunRecord artifacts were not confirmed on disk",
  );
  requireFact(
    evidence.hosts.before.pid > 0 &&
      evidence.hosts.after.pid > 0 &&
      evidence.hosts.before.stamp &&
      evidence.hosts.after.stamp &&
      (evidence.hosts.before.pid !== evidence.hosts.after.pid ||
        evidence.hosts.before.stamp !== evidence.hosts.after.stamp) &&
      evidence.hosts.stoppedAt <= evidence.hosts.restartedAt,
    "Missing distinct host generations",
  );
  requireFact(evidence.hosts.locks.length === 2, "Missing host lock evidence");
  for (const [i, identity] of [evidence.hosts.before, evidence.hosts.after].entries()) {
    const lock = object(evidence.hosts.locks[i]);
    requireFact(
      lock.pid === identity.pid && lock.pid_started_at === identity.stamp,
      "Host identity differs from registry lock",
    );
  }
  requireFact(
    Array.isArray(evidence.samples) && evidence.samples.length >= 4,
    "Missing process observations",
  );
  const first = evidence.samples[0];
  requireFact(
    first.phase === "before" &&
      first.wrapper?.pid === original.pid &&
      new Date(`${first.wrapper.stamp} UTC`).toISOString() === original.pid_started_at &&
      first.solvers.length === 1,
    "Missing original execution identity",
  );
  for (const phase of ["offline", "restarted", "completion"])
    requireFact(
      evidence.samples.some((sample) => sample.phase === phase),
      `Missing ${phase} process observation`,
    );
  requireFact(
    first.at <= evidence.hosts.stoppedAt &&
      evidence.samples
        .filter((sample) => sample.phase === "offline")
        .every(
          (sample) =>
            sample.at >= evidence.hosts.stoppedAt && sample.at <= evidence.hosts.restartedAt,
        ) &&
      evidence.samples
        .filter((sample) => sample.phase === "restarted")
        .every((sample) => sample.at >= evidence.hosts.restartedAt),
    "Process samples are not bound to host restart times",
  );
  let observedAt = 0;
  for (const sample of evidence.samples) {
    requireFact(
      Number.isFinite(sample.at) &&
        sample.at >= observedAt &&
        Array.isArray(sample.solvers) &&
        sample.solvers.length <= 1,
      "Duplicate execution or malformed sampling order",
    );
    observedAt = sample.at;
    requireFact(
      sample.solvers.every(
        (solver) => solver.pid === first.solvers[0].pid && solver.stamp === first.solvers[0].stamp,
      ),
      "Original solver identity changed",
    );
    requireFact(
      !sample.wrapper || JSON.stringify(sample.wrapper) === JSON.stringify(first.wrapper),
      "Original wrapper identity changed",
    );
    if (sample.phase !== "completion")
      requireFact(
        sample.wrapper && sample.solvers.length === 1,
        "Original execution did not survive restart",
      );
  }
  requireFact(
    evidence.wrapperFiles.length >= 3 &&
      evidence.wrapperFiles.every(
        (file) =>
          file.text.trim() === String(original.pid) &&
          JSON.stringify(file) === JSON.stringify(evidence.wrapperFiles[0]),
      ),
    "Wrapper generation was replaced",
  );
  const wake = evidence.after.events.filter((event) => {
    if (event.type !== "user/message" || event.seq <= evidence.before.asOfSeq) return false;
    const message = object(event.data);
    return (
      message.role === "user" &&
      object(message.source).kind === "shud-jobs" &&
      Array.isArray(message.content) &&
      message.content.some((part: unknown) => {
        const item = object(part);
        return (
          item.type === "text" &&
          typeof item.text === "string" &&
          item.text.startsWith(`SHUD run ${original.run_id}:`)
        );
      })
    );
  });
  requireFact(
    previous.notify.status === "delivered" &&
      previous.notify.at &&
      Date.parse(previous.notify.at) >= evidence.hosts.restartedAt &&
      wake.length > 0,
    "Missing delivered canonical owner wake after restart",
  );
  const laterCalls = evidence.after.events.filter(
    (event) => event.type === "tool/call" && event.seq > evidence.before.asOfSeq,
  );
  requireFact(
    !laterCalls.some((event) =>
      ["shud_run", "shud_collect"].includes(text(object(event.data).name)),
    ),
    "Replacement run or manual collection contaminated acceptance",
  );
  requireFact(
    Array.isArray(evidence.indexes.active) &&
      Array.isArray(evidence.indexes.completed) &&
      evidence.indexes.active.length === 0 &&
      evidence.indexes.completed.length === 1,
    "Run is not uniquely completed-only",
  );
  const entry = object(evidence.indexes.completed[0]);
  requireFact(
    Object.keys(entry).length === 3 &&
      entry.run_id === original.run_id &&
      entry.job_id === original.job_id &&
      entry.run_dir === original.run_dir,
    "Completed entry identity mismatch",
  );
  requireFact(
    Object.keys(evidence.inputs.before).length > 0 &&
      evidence.inputs.before["ccw.cfg.para"] &&
      JSON.stringify(evidence.inputs.before) === JSON.stringify(evidence.inputs.sourceAfter) &&
      JSON.stringify(evidence.inputs.before) === JSON.stringify(evidence.inputs.copyAfter),
    "Source or workspace input inventory changed",
  );
  return {
    stateProgression: true,
    canonicalRunRecord: true,
    noObservedDuplicate: true,
    deliveredWake: true,
    completedOnly: true,
  };
}

export interface ChildOutput {
  drain(): Promise<void>;
  cleanup(action: () => Promise<void>): Promise<void>;
  run(action: () => Promise<void>, finalizer: () => Promise<void>): Promise<void>;
}

/** Track close from spawn: exit alone does not prove that piped output has drained. */
export function ownChildOutput(
  child: ChildProcess,
  label: string,
  workspace: string,
  timeout: number,
): ChildOutput {
  let closed = false;
  const closure = new Promise<void>((resolve) => {
    child.once("close", () => {
      closed = true;
      resolve();
    });
  });
  async function drain(): Promise<void> {
    if (closed) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        closure,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Subprocess output drain deadline")), timeout);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async function cleanup(action: () => Promise<void>, failure?: unknown): Promise<void> {
    try {
      await action();
      await drain();
    } catch (error) {
      // Release only our handles, never the unverified process or its exit classification.
      child.unref();
      for (const stream of child.stdio) stream?.destroy();
      throw new AggregateError(
        failure === undefined ? [error] : [failure, error],
        `Unsafe to clean up ${label} PID ${child.pid ?? "unavailable"}: birth identity, ownership, exit or output drain unproved; retained workspace: ${workspace}`,
        { cause: error },
      );
    }
  }
  async function run(action: () => Promise<void>, finalizer: () => Promise<void>): Promise<void> {
    let failure: unknown;
    try {
      await action();
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      await cleanup(finalizer, failure);
    }
  }
  return { drain, cleanup, run };
}
