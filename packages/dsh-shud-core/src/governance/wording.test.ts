import { describe, expect, test } from "vitest";
import {
  FORBIDDEN_REPORT_PHRASES,
  GOVERNANCE_INVARIANTS,
  REPORT_SECRET_PATTERN,
  scanForbiddenPhrases,
} from "../index.ts";

const EXPECTED_FORBIDDEN_PHRASES = [
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
] as const;

describe("forbidden report phrases", () => {
  test("exports exactly the ten canonical phrases and four template invariants", () => {
    expect(FORBIDDEN_REPORT_PHRASES).toEqual(EXPECTED_FORBIDDEN_PHRASES);
    expect(GOVERNANCE_INVARIANTS).toEqual([
      "单流域/单事件指标提升不等于模型改进",
      "校准结果不等于结构验证",
      "不得宣称模型机制已验证",
      "不得宣称普遍改进",
    ]);
  });

  test.each(EXPECTED_FORBIDDEN_PHRASES.slice(0, 9))(
    "reports the literal substring %s within model-authored text",
    (phrase) => {
      expect(
        scanForbiddenPhrases({
          summary: `报告声称：${phrase}。`,
          observations: [],
          limitations: [],
          pi_questions: [],
        }),
      ).toEqual([{ field: "summary", phrase }]);
    },
  );

  test("reports overlapping summary phrases and a later observation in canonical order", () => {
    expect(
      scanForbiddenPhrases({
        summary: "无需 PI 审查即可接受该物理变更",
        observations: ["在该 basin/event/window 下该指标改善", "普遍改进"],
        limitations: [],
        pi_questions: [],
      }),
    ).toEqual([
      { field: "summary", phrase: "无需 PI 审查" },
      { field: "summary", phrase: "无需 PI 审查即可接受该物理变更" },
      { field: "observations", phrase: "普遍改进" },
    ]);
  });

  test("returns no hits for recommended wording in all model-authored fields", () => {
    expect(
      scanForbiddenPhrases({
        summary: "在该 basin/event/window 下该指标改善",
        observations: ["在该 basin/event/window 下该指标改善"],
        limitations: ["该解释需要 PI 结合水文背景判断"],
        pi_questions: ["该解释需要 PI 结合水文背景判断"],
      }),
    ).toEqual([]);
  });

  test("orders hits by field then canonical phrase rather than input order", () => {
    expect(
      scanForbiddenPhrases({
        pi_questions: ["该解释需要 PI 结合水文背景判断", "普遍改进"],
        limitations: ["当前证据不足以支持普遍结论", "普遍改进"],
        observations: ["在该 basin/event/window 下该指标改善", "普遍改进"],
        summary: "普遍改进，模型机制已验证",
      }),
    ).toEqual([
      { field: "summary", phrase: "模型机制已验证" },
      { field: "summary", phrase: "普遍改进" },
      { field: "observations", phrase: "普遍改进" },
      { field: "limitations", phrase: "普遍改进" },
      { field: "pi_questions", phrase: "普遍改进" },
    ]);
  });

  test("reports each field and phrase once despite repeated occurrences and entries", () => {
    expect(
      scanForbiddenPhrases({
        summary: "普遍改进，普遍改进",
        observations: ["普遍改进，普遍改进", "普遍改进"],
        limitations: ["普遍改进", "普遍改进"],
        pi_questions: ["普遍改进", "普遍改进"],
      }),
    ).toEqual([
      { field: "summary", phrase: "普遍改进" },
      { field: "observations", phrase: "普遍改进" },
      { field: "limitations", phrase: "普遍改进" },
      { field: "pi_questions", phrase: "普遍改进" },
    ]);
  });

  test("does not join separate array entries or fields into forbidden phrases", () => {
    expect(
      scanForbiddenPhrases({
        summary: "普遍",
        observations: ["改进", "普遍", "改进"],
        limitations: ["无需 PI", "审查", "普遍", "改进"],
        pi_questions: ["普遍", "改进"],
      }),
    ).toEqual([]);
  });

  test("accepts empty narrative fields and empty array entries", () => {
    expect(
      scanForbiddenPhrases({
        summary: "",
        observations: [],
        limitations: [],
        pi_questions: [],
      }),
    ).toEqual([]);
    expect(
      scanForbiddenPhrases({
        summary: "",
        observations: [],
        limitations: [""],
        pi_questions: [],
      }),
    ).toEqual([]);
  });

  test("uses case-sensitive literal matching without whitespace normalization", () => {
    expect(
      scanForbiddenPhrases({
        summary: "Verification 通过说明物理机制真实",
        observations: ["无需 pi 审查"],
        limitations: ["无需  PI 审查"],
        pi_questions: ["普遍 改进"],
      }),
    ).toEqual([]);
  });

  test("does not use template invariants as additional forbidden phrases", () => {
    expect(
      scanForbiddenPhrases({
        summary: "单流域/单事件指标提升不等于模型改进",
        observations: ["校准结果不等于结构验证"],
        limitations: [],
        pi_questions: [],
      }),
    ).toEqual([]);
  });

  test("does not whitelist model-authored text that equals a template invariant", () => {
    expect(
      scanForbiddenPhrases({
        summary: "",
        observations: [],
        limitations: ["不得宣称模型机制已验证", "不得宣称普遍改进"],
        pi_questions: [],
      }),
    ).toEqual([
      { field: "limitations", phrase: "模型机制已验证" },
      { field: "limitations", phrase: "普遍改进" },
    ]);
  });

  test("preserves readonly caller data and returns only field and phrase", () => {
    const fields = Object.freeze({
      summary: "报告上下文：普遍改进；结束。",
      observations: Object.freeze(["在该 basin/event/window 下该指标改善"]),
      limitations: Object.freeze(["当前证据不足以支持普遍结论"]),
      pi_questions: Object.freeze(["该解释需要 PI 结合水文背景判断"]),
    });

    expect(scanForbiddenPhrases(fields)).toEqual([{ field: "summary", phrase: "普遍改进" }]);
    expect(fields).toEqual({
      summary: "报告上下文：普遍改进；结束。",
      observations: ["在该 basin/event/window 下该指标改善"],
      limitations: ["当前证据不足以支持普遍结论"],
      pi_questions: ["该解释需要 PI 结合水文背景判断"],
    });
  });
});

describe("report secret shape", () => {
  const prefix = "sk-";

  test("exports the exact stateless secret pattern", () => {
    expect(REPORT_SECRET_PATTERN.source).toBe(String.raw`\bsk-[A-Za-z0-9_-]{8,}`);
    expect(REPORT_SECRET_PATTERN.flags).toBe("");
  });

  test.each([
    { label: "seven suffix characters", text: `${prefix}abcdefg`, expected: false },
    { label: "eight suffix characters", text: `${prefix}abcdefgh`, expected: true },
    { label: "more than eight suffix characters", text: `${prefix}abcdefghi`, expected: true },
    { label: "all allowed character classes", text: `${prefix}Aa0_-bC9`, expected: true },
    { label: "leading whitespace boundary", text: ` ${prefix}abcdefgh`, expected: true },
    { label: "leading punctuation boundary", text: `(${prefix}abcdefgh)`, expected: true },
    { label: "leading letter has no boundary", text: `x${prefix}abcdefgh`, expected: false },
    { label: "leading digit has no boundary", text: `1${prefix}abcdefgh`, expected: false },
    { label: "leading underscore has no boundary", text: `_${prefix}abcdefgh`, expected: false },
    { label: "uppercase prefix", text: "SK-abcdefgh", expected: false },
    { label: "punctuation interrupts short suffix", text: `${prefix}abcdefg!h`, expected: false },
    { label: "whitespace interrupts short suffix", text: `${prefix}abcdefg h`, expected: false },
    { label: "non-ASCII suffix character", text: `${prefix}abcdefg中`, expected: false },
    { label: "punctuation after complete suffix", text: `${prefix}abcdefgh!`, expected: true },
    { label: "ordinary report text", text: "该结果支持进一步检查", expected: false },
  ])("$label", ({ text, expected }) => {
    expect(REPORT_SECRET_PATTERN.test(text)).toBe(expected);
  });

  test("remains repeat-safe across positive and negative checks", () => {
    const candidate = `${prefix}Aa0_-bC9`;

    expect(REPORT_SECRET_PATTERN.test(candidate)).toBe(true);
    expect(REPORT_SECRET_PATTERN.test(candidate)).toBe(true);
    expect(REPORT_SECRET_PATTERN.test("在该 basin/event/window 下")).toBe(false);
    expect(REPORT_SECRET_PATTERN.test(candidate)).toBe(true);
    expect(REPORT_SECRET_PATTERN.lastIndex).toBe(0);
  });
});
