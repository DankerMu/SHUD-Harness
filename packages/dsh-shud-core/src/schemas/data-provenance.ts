import { isAbsolute } from "node:path";
import { z } from "zod";
import { ArtifactSchema } from "./artifact.ts";
import { isRelativePosixPath } from "./relative-posix-path.ts";
import { DataIdSchema } from "./run-identifiers.ts";

const DataSourceSchema = z.strictObject({
  path: z.string().min(1).refine(isRelativePosixPath, {
    message: "Expected a relative POSIX input path without parent traversal or NUL",
  }),
  sha256: ArtifactSchema.shape.sha256.unwrap(),
  size_bytes: ArtifactSchema.shape.size_bytes.unwrap(),
});

export const DataProvenanceSchema = z.strictObject({
  data_id: DataIdSchema,
  basin: z.string().min(1),
  event_window: z.strictObject({
    start: z.string().min(1).nullable(),
    end: z.string().min(1).nullable(),
  }),
  sources: z.strictObject({
    input_root: z.string().min(1).refine(isAbsolute, "Expected an absolute input directory"),
    files: z.array(DataSourceSchema),
  }),
  preprocess: z.literal(null),
  uncertainty_notes: z.literal(null),
});

export type DataProvenance = z.infer<typeof DataProvenanceSchema>;
