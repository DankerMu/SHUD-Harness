import { z } from "zod";
import { riskForLevel, SEMANTIC_LEVEL_ORDER } from "../governance/semantic-level-floor.ts";
import { compareRepositoryPaths } from "../stack-lock/compare-paths.ts";
import { isRelativePosixPath } from "./relative-posix-path.ts";
import { ChangeIdSchema, TaskIdSchema } from "./run-identifiers.ts";

const SemanticLevelSchema = z.enum(SEMANTIC_LEVEL_ORDER);

export const ChangeRequestSchema = z
  .strictObject({
    change_id: ChangeIdSchema,
    task_id: TaskIdSchema,
    source_path: z.literal("repos/SHUD"),
    base_commit: z.string().regex(/^[0-9a-f]{40}$/u),
    files_changed: z
      .array(
        z.string().min(1).refine(isRelativePosixPath, {
          message: "Expected a relative POSIX repository path without parent traversal or NUL",
        }),
      )
      .min(1)
      .refine(
        (paths) =>
          paths.every(
            (path, index) =>
              index === 0 || compareRepositoryPaths(paths[index - 1] ?? "", path) < 0,
          ),
        { message: "Changed paths must be unique and sorted by Unicode code point" },
      ),
    semantic_level: SemanticLevelSchema,
    semantic_floor: SemanticLevelSchema,
    floor_categories: z.array(SemanticLevelSchema).min(1),
    risk: z.enum(["low", "medium", "high"]),
    patch_path: z.string().min(1),
    patch_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    status: z.enum(["proposed", "approved"]),
    approval_ref: z.string().min(1).nullable(),
    approved_at: z.iso.datetime().nullable(),
    description: z.string().nullable(),
    created_by: z.string().min(1),
    created_at: z.iso.datetime(),
    updated_at: z.iso.datetime(),
  })
  .superRefine((record, context) => {
    if (
      SEMANTIC_LEVEL_ORDER.indexOf(record.semantic_level) <
      SEMANTIC_LEVEL_ORDER.indexOf(record.semantic_floor)
    ) {
      context.addIssue({
        code: "custom",
        path: ["semantic_level"],
        message: "Declared semantic level must not be below the semantic floor",
      });
    }
    let previousRank = -1;
    let categoriesOrdered = true;
    for (const category of record.floor_categories) {
      const rank = SEMANTIC_LEVEL_ORDER.indexOf(category);
      if (rank <= previousRank) {
        categoriesOrdered = false;
        break;
      }
      previousRank = rank;
    }
    if (!categoriesOrdered || record.floor_categories.at(-1) !== record.semantic_floor) {
      context.addIssue({
        code: "custom",
        path: ["floor_categories"],
        message: "Floor categories must be unique, ordered by semantic level and end at the floor",
      });
    }
    if (record.risk !== riskForLevel(record.semantic_level)) {
      context.addIssue({
        code: "custom",
        path: ["risk"],
        message: "Risk must match the declared semantic level",
      });
    }
    const approved = record.status === "approved";
    if (approved !== (record.approval_ref !== null)) {
      context.addIssue({
        code: "custom",
        path: ["approval_ref"],
        message: "Approval reference must be non-null exactly when the change is approved",
      });
    }
    if (approved !== (record.approved_at !== null)) {
      context.addIssue({
        code: "custom",
        path: ["approved_at"],
        message: "Approval time must be non-null exactly when the change is approved",
      });
    }
    if (record.patch_path !== `patches/${record.change_id}.patch`) {
      context.addIssue({
        code: "custom",
        path: ["patch_path"],
        message: "Patch path must be patches/<change_id>.patch",
      });
    }
  });

export type ChangeRequest = z.infer<typeof ChangeRequestSchema>;
