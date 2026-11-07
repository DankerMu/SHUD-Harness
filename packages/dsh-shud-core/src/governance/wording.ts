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

export const CODE_CHANGE_SECTION5_WORDING =
  "本里程碑无指标 artifact；验证判定见 §3 VerificationCase 表。bitwise 一致只证明候选在 N=1 下与 serial baseline 输出一致，不构成并行正确性、性能或模型改进结论。" as const;

export const REPORT_LIMITATION_TEMPLATES = Object.freeze({
  coverage:
    "仅在 <project> 单流域、<end_days> 天窗口、相对 baseline 测试了 <KEY×m, …>；未覆盖其它参数、取值与窗口",
  parameter_range: "参数范围为 agent 建议值，未经 PI 确认",
  max_solver_dt:
    "max_solver_dt 在钉版 SHUD 中不可观测（PrintFinalStats 未被调用），各运行该项恒为 null，不作判定",
  numerical_health: "运行 <run_id> 的 <metric> 判定为 <verdict>，值或原因为 <value_or_reason>",
  metrics_unavailable: "运行 <run_id> 的指标不可用，原因为 <reason>",
  failed_cell:
    "参数集 <parameter_set_id> 的运行 <run_id> 失败（exit_code: <exit_code>，exit_class: <exit_class>），该 cell 不参与相对 baseline 的比较",
});

export function instantiateSensitivityCoverage(plan: {
  readonly project: string;
  readonly end_days: number;
  readonly parameter_sets: readonly {
    readonly baseline: boolean;
    readonly changes: Readonly<Record<string, number>>;
  }[];
}): string {
  const perturbations: string[] = [];
  for (const pset of plan.parameter_sets) {
    if (pset.baseline) continue;
    for (const key in pset.changes) {
      if (Object.hasOwn(pset.changes, key)) {
        perturbations.push(`${key}×${pset.changes[key]}`);
      }
    }
  }
  return REPORT_LIMITATION_TEMPLATES.coverage.replace(
    /<project>|<end_days>|<KEY×m, …>/g,
    (placeholder) => {
      if (placeholder === "<project>") return plan.project;
      if (placeholder === "<end_days>") return String(plan.end_days);
      return perturbations.join(", ");
    },
  );
}

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
