import { isAbsolute } from "node:path";
import { z } from "zod";
import { compareRepositoryPaths } from "../stack-lock/compare-paths.ts";
import { isRelativePosixPath } from "./relative-posix-path.ts";
import { BuildIdSchema, ChangeIdSchema, TaskIdSchema } from "./run-identifiers.ts";

const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/u);

export const BuildRecordSchema = z
  .strictObject({
    build_id: BuildIdSchema,
    task_id: TaskIdSchema,
    change_id: ChangeIdSchema.nullable(),
    patch_sha256: DigestSchema.nullable(),
    source_path: z.literal("repos/SHUD"),
    source_commit: z.string().regex(/^[0-9a-f]{40}$/u),
    source_branch: z.string().min(1),
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
        { message: "Dirty paths must be unique and sorted by Unicode code point" },
      ),
    make_argv: z.array(z.string().min(1)).min(1),
    sundials_dir: z.string().min(1).refine(isAbsolute, {
      message: "SUNDIALS directory must be an absolute path",
    }),
    rhs_openmp: z.boolean(),
    compiler: z.string().min(1),
    exit_code: z.literal(0),
    duration_seconds: z.number().nonnegative(),
    binary_path: z.string().min(1),
    binary_sha256: DigestSchema,
    stdout_path: z.string().min(1),
    stderr_path: z.string().min(1),
    created_at: z.iso.datetime(),
  })
  .superRefine((record, context) => {
    const candidate = record.change_id !== null;
    if (candidate !== (record.patch_sha256 !== null)) {
      context.addIssue({
        code: "custom",
        path: ["patch_sha256"],
        message: "Patch digest must be non-null exactly when the build has a change id",
      });
    }
    if (candidate !== record.dirty_paths.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["dirty_paths"],
        message:
          "Base builds require empty dirty paths; candidate builds require nonempty dirty paths",
      });
    }
    if (record.binary_path !== `builds/${record.build_id}/shud`) {
      context.addIssue({
        code: "custom",
        path: ["binary_path"],
        message: "Binary path must be builds/<build_id>/shud",
      });
    }
    if (record.stdout_path !== `builds/${record.build_id}/make.stdout.log`) {
      context.addIssue({
        code: "custom",
        path: ["stdout_path"],
        message: "Stdout path must be builds/<build_id>/make.stdout.log",
      });
    }
    if (record.stderr_path !== `builds/${record.build_id}/make.stderr.log`) {
      context.addIssue({
        code: "custom",
        path: ["stderr_path"],
        message: "Stderr path must be builds/<build_id>/make.stderr.log",
      });
    }
  });

export type BuildRecord = z.infer<typeof BuildRecordSchema>;
