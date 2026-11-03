import { createHash } from "node:crypto";
import {
  ChangeRequestSchema,
  deriveSemanticFloor,
  riskForLevel,
  SEMANTIC_LEVEL_ORDER,
  type ChangeRequest,
  type SemanticLevel,
} from "@shud-harness/dsh-shud-core";

/**
 * Derive a proposed candidate without IO, allocation of an id, or an ambient clock.
 * The caller supplies canonical observed paths, exact patch bytes, identity and time;
 * it owns TaskCard/base checks and subsequent candidate/patch publication.
 * A declaration may raise the floor, never lower it. Only a raised declaration is explained.
 */
export function deriveChangeRequest(
  input: Pick<
    ChangeRequest,
    "change_id" | "task_id" | "base_commit" | "created_by" | "created_at"
  > & {
    files_changed: readonly string[];
    semantic_level?: SemanticLevel;
    description?: string | null;
    patch: Uint8Array;
  },
): {
  record: ChangeRequest;
  level_adjustment: { declared: SemanticLevel; effective: SemanticLevel } | null;
} {
  const fields = ChangeRequestSchema.shape;
  const change_id = fields.change_id.parse(input.change_id);
  const task_id = fields.task_id.parse(input.task_id);
  const base_commit = fields.base_commit.parse(input.base_commit);
  const files_changed = fields.files_changed.parse(input.files_changed);
  const created_by = fields.created_by.parse(input.created_by);
  const created_at = fields.created_at.parse(input.created_at);
  const description = fields.description.parse(
    input.description === undefined ? null : input.description,
  );
  const declared =
    input.semantic_level === undefined
      ? undefined
      : fields.semantic_level.parse(input.semantic_level);
  if (!(input.patch instanceof Uint8Array)) {
    throw new Error("ChangeRequest patch must be Uint8Array bytes");
  }

  const { floor, categories } = deriveSemanticFloor(files_changed);
  const raised =
    declared !== undefined &&
    SEMANTIC_LEVEL_ORDER.indexOf(declared) < SEMANTIC_LEVEL_ORDER.indexOf(floor);
  const effective = declared === undefined || raised ? floor : declared;
  const record = ChangeRequestSchema.parse({
    change_id,
    task_id,
    source_path: "repos/SHUD",
    base_commit,
    files_changed,
    semantic_level: effective,
    semantic_floor: floor,
    floor_categories: categories,
    risk: riskForLevel(effective),
    patch_path: `patches/${change_id}.patch`,
    patch_sha256: createHash("sha256").update(input.patch).digest("hex"),
    status: "proposed",
    approval_ref: null,
    approved_at: null,
    description,
    created_by,
    created_at,
    updated_at: created_at,
  });
  return {
    record,
    level_adjustment: raised && declared !== undefined ? { declared, effective } : null,
  };
}
