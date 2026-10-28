import { lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createBrandedId, TaskCardSchema, type TaskCard } from "@shud-harness/dsh-shud-core";
import { writeJsonSync } from "@shud-harness/dsh-shud-jobs";

/** Return whether this call created the directory; never reuse a link or special file. */
function ensureDirectory(path: string): boolean {
  const existing = lstatSync(path, { throwIfNoEntry: false });
  const created = existing ? false : mkdirSync(path, { recursive: true }) !== undefined;
  if (!(existing ?? lstatSync(path)).isDirectory()) {
    throw new Error(`TaskCard path is not a real directory: ${path}`);
  }
  return created;
}

/** Allocation, validation and publication stay synchronous to exclude in-process interleaving. */
export function createTaskCard(cwd: string, fields: Omit<TaskCard, "task_id">): TaskCard {
  let card = TaskCardSchema.parse({ ...fields, task_id: createBrandedId("TASK") });
  const tasks = join(cwd, "tasks");
  ensureDirectory(tasks);
  for (;;) {
    const directory = join(tasks, card.task_id);
    const created = ensureDirectory(directory);
    const path = join(directory, "task.json");
    const target = lstatSync(path, { throwIfNoEntry: false });
    if (target && !target.isFile()) {
      throw new Error(`TaskCard target is not a regular file: ${path}`);
    }
    if (!created || target) {
      // A genuine directory is a collision, never permission to replace its contents.
      card = { ...card, task_id: createBrandedId("TASK") };
      continue;
    }
    writeJsonSync(path, card);
    return card;
  }
}
