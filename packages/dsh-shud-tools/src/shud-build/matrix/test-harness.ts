import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutionResult } from "@deepseek-ai/dsh-tools";
import {
  ChangeIdSchema,
  TaskIdSchema,
  type ChangeId,
  type TaskId,
} from "@shud-harness/dsh-shud-core";
import { ShudJobRegistry } from "@shud-harness/dsh-shud-jobs";
import { readWorkspaceRecord, rewriteChangeRequest } from "@shud-harness/dsh-shud-records";
import { expect } from "vitest";
import { git, taskArgs, valueOf, type ChangeHarness } from "../../change-create/test-harness.ts";
import { treeOrAbsent } from "../../task-linked/test-harness.ts";
import { createToolHarness } from "../../test-harness.ts";
import { invokeTool, seedBuildSource } from "../test-harness.ts";

export const PRIVATE = "PRIVATE_BUILD_MATRIX_537";
export const MAKEFILE =
  "CXX := cc\nSRC = $(wildcard src/*/*.cpp)\nshud:\n\tprintf '%s\\n' '#!/bin/sh' > shud\n\tcat $(SRC) >> shud\n\tchmod 755 shud\n";
export const BASE_FILES = {
  Makefile: MAKEFILE,
  "src/Model/f.cpp": 'printf "base-matrix\\n"\n',
  "docs/note.txt": "unchanged note\n",
};

export interface BuildFixture extends ChangeHarness {
  taskId: TaskId;
  cardPath: string;
  head: string;
  sundialsRoot: string;
  build(args?: Record<string, unknown>): Promise<ToolExecutionResult>;
  preserve<T>(operation: () => Promise<T>): Promise<T>;
  reloadJobs(sundialsRoot?: string): Promise<void>;
}

export async function buildFixture(
  options: {
    files?: Record<string, string>;
    configured?: boolean;
    outer?: boolean;
  } = {},
): Promise<BuildFixture> {
  const sundialsRoot = fs.mkdtempSync(join(tmpdir(), "build-matrix-sundials-"));
  try {
    const h = await createToolHarness({
      pumpPollMs: 60_000,
      ...(options.configured === false ? {} : { sundialsRoot }),
    });
    try {
      if (options.outer) git(h.cwd, "init", "-q", "--template=");
      const { source, head } = seedBuildSource(h.cwd, options.files ?? BASE_FILES);
      const created = valueOf(await invokeTool(h, "task_create", taskArgs));
      const taskId = TaskIdSchema.parse(created.task_id);
      const cardPath = join(h.cwd, "tasks", taskId, "task.json");
      let provider: { dispose(): Promise<void> } | undefined;
      let originalDisposed = false;
      return {
        ...h,
        source,
        head,
        taskId,
        cardPath,
        sundialsRoot,
        invoke: (name, args) => invokeTool(h, name, args),
        build: (args = {}) => invokeTool(h, "shud_build", { task_id: taskId, ...args }),
        async preserve(operation) {
          const sourceBefore = await treeOrAbsent(source);
          const cardBefore = await treeOrAbsent(cardPath);
          try {
            return await operation();
          } finally {
            expect(await treeOrAbsent(source)).toEqual(sourceBefore);
            expect(await treeOrAbsent(cardPath)).toEqual(cardBefore);
          }
        },
        async reloadJobs(root) {
          if (provider) await provider.dispose();
          if (!originalDisposed) {
            await h.disposeRegistry();
            originalDisposed = true;
          }
          provider = await h.apply(ShudJobRegistry, {
            ...h.config,
            pumpPollMs: 60_000,
            ...(root === undefined ? {} : { sundialsRoot: root }),
          });
        },
        async dispose() {
          try {
            if (provider) await provider.dispose();
          } finally {
            try {
              await h.dispose();
            } finally {
              fs.rmSync(sundialsRoot, { recursive: true, force: true });
            }
          }
        },
      };
    } catch (error) {
      await h.dispose();
      throw error;
    }
  } catch (error) {
    fs.rmSync(sundialsRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function candidate(h: BuildFixture, paths = ["src/Model/f.cpp"]): Promise<ChangeId> {
  for (const path of paths)
    fs.writeFileSync(join(h.source, path), 'printf "candidate-matrix\\n"\n');
  const changed = valueOf(await h.invoke("change_create", { task_id: h.taskId }));
  const id = ChangeIdSchema.parse(changed.change_id);
  const change = readWorkspaceRecord(h.cwd, "change", id, { readonly: true });
  rewriteChangeRequest(h.cwd, {
    ...change,
    status: "approved",
    approval_ref: "explicit-matrix-fixture-not-PI",
    approved_at: change.created_at,
  });
  return id;
}

export function noBuilds(h: BuildFixture) {
  const root = join(h.cwd, "builds");
  expect(fs.existsSync(root) ? fs.readdirSync(root) : []).toEqual([]);
}

export async function unchangedWorkspace<T>(h: BuildFixture, operation: () => Promise<T>) {
  const before = await treeOrAbsent(h.cwd);
  try {
    return await h.preserve(operation);
  } finally {
    expect(await treeOrAbsent(h.cwd)).toEqual(before);
  }
}
