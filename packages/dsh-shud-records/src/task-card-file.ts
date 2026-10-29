import { ensureDirectory, regularTarget } from "./workspace-paths.ts";
import { join } from "node:path";
import { createBrandedId, TaskCardSchema, type TaskCard } from "@shud-harness/dsh-shud-core";
import { writeJsonSync } from "./state-files.ts";

/** Allocation, validation and publication stay synchronous to exclude in-process interleaving. */
export function createTaskCard(cwd: string, fields: Omit<TaskCard, "task_id">): TaskCard {
  let card = TaskCardSchema.parse({ ...fields, task_id: createBrandedId("TASK") });
  const tasks = join(cwd, "tasks");
  ensureDirectory(tasks, "TaskCard");
  for (;;) {
    const directory = join(tasks, card.task_id);
    const created = ensureDirectory(directory, "TaskCard");
    const path = join(directory, "task.json");
    const target = regularTarget(path, "TaskCard");
    if (!created || target) {
      // A genuine directory is a collision, never permission to replace its contents.
      card = { ...card, task_id: createBrandedId("TASK") };
      continue;
    }
    writeJsonSync(path, card);
    return card;
  }
}
