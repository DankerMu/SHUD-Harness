import { z } from "zod";
import { ArtifactSchema } from "./artifact";

const MANIFEST_ID_PATTERN =
  /^MANIFEST-[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/u;

export const ArtifactManifestSchema = z.strictObject({
  manifest_id: z.string().regex(MANIFEST_ID_PATTERN),
  task_id: z.string().min(1),
  run_id: z.string().min(1).optional(),
  report_id: z.string().min(1).optional(),
  superseded_by: z.string().regex(MANIFEST_ID_PATTERN).optional(),
  artifacts: z.array(ArtifactSchema),
  generated_at: z.string().min(1),
  generator: z.string().min(1),
  manifest_sha256: z.string().min(1).optional()
});

export type ArtifactManifestInput = z.input<typeof ArtifactManifestSchema>;
export type ArtifactManifest = ArtifactManifestInput;
export type StoredArtifactManifest = z.output<typeof ArtifactManifestSchema>;
