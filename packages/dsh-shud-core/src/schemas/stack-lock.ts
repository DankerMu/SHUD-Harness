import { z } from "zod";
import { compareRepositoryPaths } from "../stack-lock/compare-paths.ts";
import { isRelativePosixPath } from "./relative-posix-path.ts";
import { StackIdSchema } from "./run-identifiers.ts";

const RepositoryRevisionSchema = z
  .strictObject({
    commit: z.string().min(1),
    branch: z.string().min(1),
    dirty: z.boolean(),
    dirty_paths: z
      .array(
        z.string().min(1).refine(isRelativePosixPath, {
          message: "Expected a relative POSIX repository path without parent traversal or NUL",
        }),
      )
      .refine(
        (paths) =>
          paths.every(
            (path, index) =>
              index === 0 || compareRepositoryPaths(paths[index - 1] ?? "", path) < 0,
          ),
        { message: "Repository paths must be unique and sorted by Unicode code point" },
      ),
    dirty_paths_truncated: z.boolean(),
  })
  .refine(
    (revision) =>
      revision.dirty_paths_truncated
        ? revision.dirty
        : revision.dirty === revision.dirty_paths.length > 0,
    {
      path: ["dirty"],
      message: "Dirty must match listed paths, or be true when the path list is truncated",
    },
  );

export type RepositoryRevision = z.infer<typeof RepositoryRevisionSchema>;

export const StackLockSchema = z.strictObject({
  stack_id: StackIdSchema,
  repos: z.strictObject({
    SHUD: RepositoryRevisionSchema,
    rSHUD: RepositoryRevisionSchema,
    AutoSHUD: RepositoryRevisionSchema,
  }),
  runtime: z.strictObject({
    os: z.string().min(1),
    sundials_version: z.string().min(1).nullable(),
    host_version: z.string().min(1),
  }),
  harness: z.strictObject({
    version: z.string().min(1),
  }),
  llm: z.strictObject({
    base_url: z.string().min(1),
    request_alias: z.string().min(1),
    response_model: z.string().min(1),
  }),
  fingerprint: z.string().min(1),
  created_at: z.string().min(1),
});

export type StackLock = z.infer<typeof StackLockSchema>;
