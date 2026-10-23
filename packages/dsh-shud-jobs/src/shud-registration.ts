import type { JobId, JobSpec } from "@deepseek-ai/dsh-jobs";
import { LocalJobRegistry } from "@deepseek-ai/dsh-jobs-local";

declare module "@deepseek-ai/dsh-jobs" {
  interface JobKindMap {
    shud: "shud";
  }
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
