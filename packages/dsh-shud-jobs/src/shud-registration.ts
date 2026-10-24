import type { JobId, JobSpec } from "@deepseek-ai/dsh-jobs";
import { LocalJobRegistry } from "@deepseek-ai/dsh-jobs-local";
import type { RunJob } from "@shud-harness/dsh-shud-core";

declare module "@deepseek-ai/dsh-jobs" {
  interface JobKindMap {
    shud: "shud";
  }
}

export function registrationLabel(record: Pick<RunJob, "run_id" | "label">): string {
  return record.label === null ? record.run_id : `${record.run_id} ${record.label}`;
}

/** The caller supplies the constructor-captured raw instance, never a Cordis caller proxy. */
export function registerUnowned(registry: LocalJobRegistry, spec: Omit<JobSpec, "owner">): JobId {
  const detach = LocalJobRegistry.prototype.attachController.call(registry, "shud-jobs");
  try {
    return LocalJobRegistry.prototype.start.call(registry, spec);
  } finally {
    detach();
  }
}

/** Teardown may already have removed the entry; otherwise wait for the parent's final drain. */
export async function removeSettledRegistration(
  registry: LocalJobRegistry,
  id: JobId,
  waitMs: number,
): Promise<void> {
  while (registry.list().some((job) => job.id === id)) {
    const view = await registry.wait(id, waitMs);
    if (view.status !== "running" && view.status !== "stopping") {
      if (registry.list().some((job) => job.id === id)) registry.remove(id);
      break;
    }
  }
}
