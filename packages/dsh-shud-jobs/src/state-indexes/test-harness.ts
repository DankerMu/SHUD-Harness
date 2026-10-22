import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { JobRecordIdSchema, RunIdSchema } from "@shud-harness/dsh-shud-core";
import { ShudJobRegistry, type IndexEntry } from "../index.ts";

export function publishedStore(ctx: Context) {
  const registry = ctx.jobs;
  if (!(registry instanceof ShudJobRegistry)) throw new Error("SHUD registry not published");
  return registry.indexes;
}

export function entry(runDir: string, suffix = "a1b2"): IndexEntry {
  return {
    run_id: RunIdSchema.parse(`RUN-20261022T031500-${suffix}`),
    job_id: JobRecordIdSchema.parse(`JOB-20261022T031500-${suffix}`),
    run_dir: runDir,
  };
}

export async function persisted(stateDir: string, name = "active.json"): Promise<unknown> {
  return JSON.parse(await readFile(join(stateDir, name), "utf8")) as unknown;
}

export function barrier() {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { waiting, release };
}
