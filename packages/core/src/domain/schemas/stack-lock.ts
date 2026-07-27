import { z } from "zod";

const STACK_ID_PATTERN =
  /^STACK-[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/u;

const RepositoryRevisionSchema = z.strictObject({
  commit: z.string().min(1),
  branch: z.string().min(1)
});

const RPackagesLockSchema = z.strictObject({
  path: z.string().min(1),
  sha256: z.string().min(1)
});

export const StackLockSchema = z.strictObject({
  stack_id: z.string().regex(STACK_ID_PATTERN),
  repos: z.strictObject({
    SHUD: RepositoryRevisionSchema,
    rSHUD: RepositoryRevisionSchema,
    AutoSHUD: RepositoryRevisionSchema,
    zero: RepositoryRevisionSchema
  }),
  runtime: z.strictObject({
    os: z.string().min(1),
    r_version: z.string().min(1),
    r_packages_lock: RPackagesLockSchema.nullable(),
    python_version: z.string().min(1),
    sundials_version: z.string().min(1),
    gcc_version: z.string().min(1),
    gdal_version: z.string().min(1)
  }),
  harness: z.strictObject({
    version: z.string().min(1),
    cli_version: z.string().min(1),
    prompt_pack: z.string().min(1),
    skills_version: z.string().min(1)
  }),
  llm: z.strictObject({
    provider: z.string().min(1),
    model_id: z.string().min(1),
    base_url: z.string().min(1),
    params_digest: z.string().min(1),
    prompt_pack_digest: z.string().min(1)
  }),
  fingerprint: z.string().min(1),
  created_at: z.string().min(1)
});

export type StackLock = z.infer<typeof StackLockSchema>;
