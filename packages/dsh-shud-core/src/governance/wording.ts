export const FORBIDDEN_REPORT_PHRASES = Object.freeze([
  "模型机制已验证",
  "普遍改进",
  "校准证明结构正确",
  "该参数就是真实物理原因",
  "无需 PI 审查",
  "校准证明模型结构正确",
  "verification 通过说明物理机制真实",
  "该公式已经被模型结果证明",
  "参数搜索确认了理论假设",
  "无需 PI 审查即可接受该物理变更",
] as const);

// Template-owned sentences, not additional scan phrases or model-text exemptions.
export const GOVERNANCE_INVARIANTS = Object.freeze([
  "单流域/单事件指标提升不等于模型改进",
  "校准结果不等于结构验证",
  "不得宣称模型机制已验证",
  "不得宣称普遍改进",
] as const);

export const REPORT_SECRET_PATTERN = /\bsk-[A-Za-z0-9_-]{8,}/;

export interface ReportWordingFields {
  readonly summary: string;
  readonly observations: readonly string[];
  readonly limitations: readonly string[];
  readonly pi_questions: readonly string[];
}

export interface ForbiddenPhraseHit {
  readonly field: keyof ReportWordingFields;
  readonly phrase: (typeof FORBIDDEN_REPORT_PHRASES)[number];
}

const REPORT_WORDING_FIELDS = [
  "summary",
  "observations",
  "limitations",
  "pi_questions",
] as const satisfies readonly (keyof ReportWordingFields)[];

function containsPhrase(value: string | readonly string[], phrase: string): boolean {
  if (typeof value === "string") return value.includes(phrase);
  for (const entry of value) {
    if (entry.includes(phrase)) return true;
  }
  return false;
}

// Enumerated literal lint only: no hits does not establish semantic compliance.
export function scanForbiddenPhrases(fields: ReportWordingFields): ForbiddenPhraseHit[] {
  const hits: ForbiddenPhraseHit[] = [];
  for (const field of REPORT_WORDING_FIELDS) {
    for (const phrase of FORBIDDEN_REPORT_PHRASES) {
      if (containsPhrase(fields[field], phrase)) {
        hits.push({ field, phrase });
      }
    }
  }
  return hits;
}
