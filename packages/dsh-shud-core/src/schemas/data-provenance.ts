import { z } from "zod";

const DATA_ID_PATTERN =
  /^DATA-[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/u;

const DataSourceSchema = z.strictObject({
  path: z.string().min(1),
  sha256: z.string().min(1)
});

const ObservationSourceSchema = z.strictObject({
  variable: z.string().min(1),
  station: z.string().min(1),
  path: z.string().min(1),
  sha256: z.string().min(1)
});

const DataPreprocessSchema = z.strictObject({
  script: z.string().min(1),
  params: z.record(z.string(), z.unknown()),
  output_sha256: z.string().min(1)
});

export const DataProvenanceSchema = z.strictObject({
  data_id: z.string().regex(DATA_ID_PATTERN),
  basin: z.string().min(1),
  event_window: z.strictObject({
    start: z.string().min(1),
    end: z.string().min(1)
  }),
  sources: z.strictObject({
    terrain: DataSourceSchema,
    mesh: DataSourceSchema,
    forcing: DataSourceSchema,
    observations: z.array(ObservationSourceSchema)
  }),
  preprocess: DataPreprocessSchema.optional(),
  uncertainty_notes: z.string().min(1).optional()
});

export type DataProvenance = z.infer<typeof DataProvenanceSchema>;
