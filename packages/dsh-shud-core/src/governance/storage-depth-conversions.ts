import { z } from "zod";

// Full normalized source paths and positive decimal lines; the end assertion rejects newlines.
const SourceRefSchema = z
  .string()
  .regex(
    /^SHUD\/src\/(?:(?!\.{1,2}\/)[A-Za-z0-9_.-]+\/)*(?!\.{1,2}:)[A-Za-z0-9_.-]+:[1-9][0-9]*(?![\s\S])/,
    "Expected a normalized SHUD/src/<path>:<positive decimal line> reference",
  );
const SourceRefsSchema = z.array(SourceRefSchema).min(1);
const EntrySchema = z.strictObject({
  scale: z.number().finite().positive(),
  veg_frac_weighted: z.boolean(),
  shud_source_refs: SourceRefsSchema,
});
const GroupSchema = z.strictObject({ output: EntrySchema, ic: EntrySchema });
const VegFracSourceSchema = z.strictObject({
  file: z.string().min(1),
  column: z.string().min(1),
  calib_key: z.string().min(1),
  shud_source_refs: SourceRefsSchema,
});

export const StorageDepthConversionsSchema = z
  .strictObject({
    snow: GroupSchema,
    ic: GroupSchema,
    veg_frac_source: VegFracSourceSchema.optional(),
  })
  .superRefine((conversions, context) => {
    const needsSource =
      conversions.snow.output.veg_frac_weighted ||
      conversions.snow.ic.veg_frac_weighted ||
      conversions.ic.output.veg_frac_weighted ||
      conversions.ic.ic.veg_frac_weighted;
    const hasSource = Object.hasOwn(conversions, "veg_frac_source");
    if (needsSource && (!hasSource || conversions.veg_frac_source === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["veg_frac_source"],
        message: "A vegetation-weighted conversion requires veg_frac_source",
      });
    } else if (!needsSource && hasSource) {
      context.addIssue({
        code: "custom",
        path: ["veg_frac_source"],
        message: "veg_frac_source is forbidden when all conversions are unweighted",
      });
    }
  });

// O1 audit at SHUD 3aec65755926c478e13ca7d4fea80715e4e90345.
// Flags request an additional consumer factor, not whether SHUD already applied vegetation.
export const STORAGE_DEPTH_CONVERSIONS = Object.freeze({
  snow: Object.freeze({
    output: Object.freeze({
      scale: 1,
      veg_frac_weighted: false,
      shud_source_refs: Object.freeze([
        "SHUD/src/ModelData/MD_ET.cpp:44",
        "SHUD/src/ModelData/MD_ET.cpp:110",
        "SHUD/src/ModelData/MD_ET.cpp:137",
        "SHUD/src/ModelData/MD_ET.cpp:141",
        "SHUD/src/ModelData/MD_ET.cpp:159",
        "SHUD/src/ModelData/MD_initialize.cpp:248",
        "SHUD/src/classes/Model_Control.cpp:354",
        "SHUD/src/classes/Model_Control.cpp:363",
        "SHUD/src/classes/Model_Control.cpp:410",
        "SHUD/src/classes/Model_Control.cpp:440",
        "SHUD/src/classes/Model_Control.cpp:445",
      ] as const),
    }),
    ic: Object.freeze({
      scale: 1,
      veg_frac_weighted: false,
      shud_source_refs: Object.freeze([
        "SHUD/src/ModelData/MD_initialize.cpp:75",
        "SHUD/src/ModelData/MD_update.cpp:237",
        "SHUD/src/ModelData/MD_update.cpp:239",
      ] as const),
    }),
  }),
  ic: Object.freeze({
    output: Object.freeze({
      scale: 1,
      veg_frac_weighted: false,
      shud_source_refs: Object.freeze([
        "SHUD/src/ModelData/MD_ET.cpp:44",
        "SHUD/src/ModelData/MD_ET.cpp:145",
        "SHUD/src/ModelData/MD_ET.cpp:146",
        "SHUD/src/ModelData/MD_ET.cpp:155",
        "SHUD/src/ModelData/MD_ET.cpp:158",
        "SHUD/src/ModelData/MD_initialize.cpp:246",
        "SHUD/src/classes/Model_Control.cpp:354",
        "SHUD/src/classes/Model_Control.cpp:363",
        "SHUD/src/classes/Model_Control.cpp:410",
        "SHUD/src/classes/Model_Control.cpp:440",
        "SHUD/src/classes/Model_Control.cpp:445",
      ] as const),
    }),
    ic: Object.freeze({
      scale: 1,
      veg_frac_weighted: false,
      shud_source_refs: Object.freeze([
        "SHUD/src/ModelData/MD_initialize.cpp:74",
        "SHUD/src/ModelData/MD_update.cpp:237",
        "SHUD/src/ModelData/MD_update.cpp:239",
      ] as const),
    }),
  }),
});
