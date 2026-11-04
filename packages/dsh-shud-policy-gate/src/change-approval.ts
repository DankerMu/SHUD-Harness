import { createHash } from "node:crypto";
import type { PreToolDecision } from "@deepseek-ai/dsh-tools";
import { ChangeIdSchema } from "@shud-harness/dsh-shud-core";
import type { ChangeId, ChangeRequest } from "@shud-harness/dsh-shud-core";
import { readChangePatch, readWorkspaceRecord } from "@shud-harness/dsh-shud-records";

export const CHANGE_APPROVAL_REASON_PREFIX = "PI approval required for change";
export const INVALID_CHANGE_ID_MARKER = "<invalid-change-id>";
export const CHANGE_APPROVAL_REASON_CODE = "change-approval";
export const CHANGE_PATCH_MISMATCH_REASON_CODE = "change-patch-mismatch";
export const CHANGE_PATCH_MISMATCH_REASON =
  "The patch changed after change_create; run change_create again before approval.";

type ChangeDecision = {
  decision: Extract<PreToolDecision, { kind: "ask" | "deny" }>;
  audit: string;
};

function requestedId(input: unknown): ChangeId | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  try {
    const parsed = ChangeIdSchema.safeParse(Reflect.get(input, "change_id"));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function ask(
  id: ChangeId | undefined,
  change?: ChangeRequest,
  patchUnavailable = false,
): ChangeDecision {
  const identifier = id ?? INVALID_CHANGE_ID_MARKER;
  const unavailableEn = "Unavailable (cannot read)";
  const unavailableZh = "无法读取";
  const path = id === undefined ? undefined : `patches/${id}.patch`;
  const categories = change?.floor_categories.join(", ");
  const files = change?.files_changed.join("\n");
  let en = `Change: ${identifier}\nSemantic level: ${change?.semantic_level ?? unavailableEn}\nSemantic floor: ${change?.semantic_floor ?? unavailableEn}\nFloor categories: ${categories ?? unavailableEn}\nRisk: ${change?.risk ?? unavailableEn}\nFiles changed:\n${files ?? unavailableEn}\nPatch: ${path ?? unavailableEn}\nDescription: ${change ? (change.description ?? "None") : unavailableEn}`;
  let zh = `变更：${identifier}\n语义级别：${change?.semantic_level ?? unavailableZh}\n语义下限：${change?.semantic_floor ?? unavailableZh}\n下限分类：${categories ?? unavailableZh}\n风险：${change?.risk ?? unavailableZh}\n变更文件：\n${files ?? unavailableZh}\n补丁：${path ?? unavailableZh}\n说明：${change ? (change.description ?? "无") : unavailableZh}`;
  if (patchUnavailable) {
    en += "\nPatch unavailable (cannot read)";
    zh += "\npatch 无法读取";
  }
  return {
    decision: {
      kind: "ask",
      reason: `${CHANGE_APPROVAL_REASON_PREFIX} ${identifier}`,
      displayReason: { en, zh },
    },
    audit: `${CHANGE_APPROVAL_REASON_CODE}${id === undefined ? "" : ` ${id}`}${change === undefined ? "" : ` ${change.semantic_level}`}`,
  };
}

/** Observe readonly evidence in fixed order; proposed/running eligibility belongs to the tool. */
export function changeApproval(
  input: unknown,
  cwd: string | undefined,
): ChangeDecision | undefined {
  const id = requestedId(input);
  if (id === undefined || !cwd) return ask(id);
  let change: ChangeRequest;
  try {
    change = readWorkspaceRecord(cwd, "change", id, { readonly: true });
  } catch {
    return ask(id);
  }
  let patch: Buffer;
  try {
    patch = readChangePatch(cwd, id, { readonly: true });
  } catch {
    return ask(id, change, true);
  }
  if (createHash("sha256").update(patch).digest("hex") !== change.patch_sha256) {
    return {
      decision: { kind: "deny", reason: CHANGE_PATCH_MISMATCH_REASON },
      audit: `${CHANGE_PATCH_MISMATCH_REASON_CODE} ${id}`,
    };
  }
  if (change.semantic_level === "pure_engineering" || change.semantic_level === "io_format") {
    return undefined;
  }
  return ask(id, change);
}
