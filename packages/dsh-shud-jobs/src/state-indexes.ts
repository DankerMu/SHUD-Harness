import { isAbsolute, join } from "node:path";
import {
  JobRecordIdSchema,
  RunIdSchema,
  type JobRecordId,
  type RunId,
} from "@shud-harness/dsh-shud-core";
import { readJson, writeJson, writeJsonSync } from "./state-files.ts";
import { StateLock } from "./state-lock.ts";

export interface IndexEntry {
  readonly run_id: RunId;
  readonly job_id: JobRecordId;
  readonly run_dir: string;
}

export interface IndexSnapshot {
  active: readonly IndexEntry[];
  completed: readonly IndexEntry[];
}

function parseEntry(value: unknown): IndexEntry {
  if (
    typeof value !== "object" ||
    value === null ||
    Object.keys(value).length !== 3 ||
    !("run_id" in value) ||
    !("job_id" in value) ||
    !("run_dir" in value) ||
    typeof value.run_dir !== "string" ||
    !isAbsolute(value.run_dir)
  ) {
    throw new Error("Expected an index entry with run_id, job_id and an absolute run_dir");
  }
  return Object.freeze({
    run_id: RunIdSchema.parse(value.run_id),
    job_id: JobRecordIdSchema.parse(value.job_id),
    run_dir: value.run_dir,
  });
}

function parseIndex(value: unknown, path: string): IndexEntry[] {
  if (value === undefined) return [];
  try {
    if (!Array.isArray(value)) throw new Error("Expected an index array");
    const entries = value.map((item: unknown) => parseEntry(item));
    const runs = new Set<RunId>();
    const jobs = new Set<JobRecordId>();
    for (const entry of entries) {
      if (runs.has(entry.run_id) || jobs.has(entry.job_id)) throw new Error("Duplicate index id");
      runs.add(entry.run_id);
      jobs.add(entry.job_id);
    }
    return entries;
  } catch (error) {
    throw new Error(`Invalid index ${path}`, { cause: error });
  }
}

function assertConsistent(active: readonly IndexEntry[], completed: readonly IndexEntry[]) {
  const runs = new Map(completed.map((entry) => [entry.run_id, entry]));
  const jobs = new Map(completed.map((entry) => [entry.job_id, entry]));
  for (const entry of active) {
    for (const prior of [runs.get(entry.run_id), jobs.get(entry.job_id)]) {
      if (
        prior &&
        (prior.run_id !== entry.run_id ||
          prior.job_id !== entry.job_id ||
          prior.run_dir !== entry.run_dir)
      ) {
        throw new Error(
          `Conflicting active/completed index entry ${entry.run_id} / ${entry.job_id}`,
        );
      }
    }
  }
}

/** One registry's durable indexes and exclusive lifetime ownership of their state directory. */
export class StateIndexStore {
  private readonly lock: StateLock;
  private readonly activePath: string;
  private readonly completedPath: string;
  private active: IndexEntry[];
  private completed: IndexEntry[];
  private queue = Promise.resolve();
  private accepting = true;
  private pending = 0;
  private closing: Promise<void> | undefined;

  constructor(stateDir: string) {
    this.activePath = join(stateDir, "active.json");
    this.completedPath = join(stateDir, "completed.json");
    this.lock = new StateLock(stateDir);
    try {
      const active = readJson(this.activePath);
      const completed = readJson(this.completedPath);
      this.active = parseIndex(active, this.activePath);
      this.completed = parseIndex(completed, this.completedPath);
      assertConsistent(this.active, this.completed);
      // Validate both files before replacing either missing index.
      if (active === undefined) writeJsonSync(this.activePath, this.active);
      if (completed === undefined) writeJsonSync(this.completedPath, this.completed);
    } catch (error) {
      this.lock.release();
      throw error;
    }
  }

  read(): IndexSnapshot {
    return { active: [...this.active], completed: [...this.completed] };
  }

  lookup(id: RunId | JobRecordId): IndexEntry | undefined {
    if (typeof id === "string" && id.startsWith("RUN-")) RunIdSchema.parse(id);
    else JobRecordIdSchema.parse(id);
    return (
      this.active.find((entry) => entry.run_id === id || entry.job_id === id) ??
      this.completed.find((entry) => entry.run_id === id || entry.job_id === id)
    );
  }

  addActive(entry: IndexEntry): Promise<void> {
    return this.enqueue(async () => {
      const parsed = parseEntry(entry);
      if (this.lookup(parsed.run_id) || this.lookup(parsed.job_id)) {
        throw new Error(`Index id already exists: ${parsed.run_id} / ${parsed.job_id}`);
      }
      const next = [...this.active, parsed];
      await writeJson(this.activePath, next);
      this.active = next;
    });
  }

  removeActive(runId: RunId): Promise<void> {
    return this.enqueue(async () => {
      RunIdSchema.parse(runId);
      const next = this.active.filter((entry) => entry.run_id !== runId);
      if (next.length === this.active.length) return;
      await writeJson(this.activePath, next);
      this.active = next;
    });
  }

  completeActive(runId: RunId): Promise<void> {
    return this.enqueue(async () => {
      RunIdSchema.parse(runId);
      const entry = this.active.find((item) => item.run_id === runId);
      if (!entry) {
        if (this.completed.some((item) => item.run_id === runId)) return;
        throw new Error(`Unknown active run ${runId}`);
      }
      if (!this.completed.some((item) => item.run_id === runId)) {
        const completed = [...this.completed, entry];
        await writeJson(this.completedPath, completed);
        this.completed = completed;
      }
      const active = this.active.filter((item) => item.run_id !== runId);
      await writeJson(this.activePath, active);
      this.active = active;
    });
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    if (!this.accepting) return Promise.reject(new Error("State index store is closed"));
    this.pending += 1;
    const result = this.queue.then(operation);
    this.queue = result.then(
      () => {
        this.pending -= 1;
      },
      () => {
        this.pending -= 1;
      },
    );
    return result;
  }

  /** Closes admission synchronously; every caller awaits the same drain and release. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.accepting = false;
    if (this.pending === 0) {
      try {
        this.lock.release();
        this.closing = Promise.resolve();
      } catch (error) {
        this.closing = Promise.reject(
          error instanceof Error
            ? error
            : new Error("State index store release failed", { cause: error }),
        );
      }
    } else {
      this.closing = this.queue.then(() => this.lock.release());
    }
    return this.closing;
  }
}
