import { describe, expect, test } from "vitest";
import {
  FORBIDDEN_REPORT_PHRASES,
  instantiateSensitivityCoverage,
  REPORT_LIMITATION_TEMPLATES,
  scanForbiddenPhrases,
} from "../index.ts";

const EXPECTED_TEMPLATES = [
  [
    "coverage",
    "仅在 <project> 单流域、<end_days> 天窗口、相对 baseline 测试了 <KEY×m, …>；未覆盖其它参数、取值与窗口",
  ],
  ["parameter_range", "参数范围为 agent 建议值，未经 PI 确认"],
  [
    "max_solver_dt",
    "max_solver_dt 在钉版 SHUD 中不可观测（PrintFinalStats 未被调用），各运行该项恒为 null，不作判定",
  ],
  ["numerical_health", "运行 <run_id> 的 <metric> 判定为 <verdict>，值或原因为 <value_or_reason>"],
  ["metrics_unavailable", "运行 <run_id> 的指标不可用，原因为 <reason>"],
  [
    "failed_cell",
    "参数集 <parameter_set_id> 的运行 <run_id> 失败（exit_code: <exit_code>，exit_class: <exit_class>），该 cell 不参与相对 baseline 的比较",
  ],
] as const;

describe("deterministic report limitations", () => {
  test.each(EXPECTED_TEMPLATES)("exports canonical %s wording", (key, wording) => {
    expect(REPORT_LIMITATION_TEMPLATES[key]).toBe(wording);
  });

  test("keeps exactly six immutable templates", () => {
    expect(Object.keys(REPORT_LIMITATION_TEMPLATES)).toEqual([
      "coverage",
      "parameter_range",
      "max_solver_dt",
      "numerical_health",
      "metrics_unavailable",
      "failed_cell",
    ]);
    expect(Object.isFrozen(REPORT_LIMITATION_TEMPLATES)).toBe(true);
    expect(Reflect.set(REPORT_LIMITATION_TEMPLATES, "parameter_range", "replacement")).toBe(false);
    expect(REPORT_LIMITATION_TEMPLATES.parameter_range).toBe(
      "参数范围为 agent 建议值，未经 PI 确认",
    );
  });

  test.each(EXPECTED_TEMPLATES)("accepts %s without changing forbidden-phrase rules", (key) => {
    const wording = REPORT_LIMITATION_TEMPLATES[key];
    expect(FORBIDDEN_REPORT_PHRASES).not.toContain(wording);
    expect(
      scanForbiddenPhrases({
        summary: "",
        observations: [],
        limitations: [wording],
        pi_questions: [],
      }),
    ).toEqual([]);
    expect(
      scanForbiddenPhrases({
        summary: "",
        observations: [],
        limitations: [`${wording}普遍改进`],
        pi_questions: [],
      }),
    ).toEqual([{ field: "limitations", phrase: "普遍改进" }]);
  });
});

describe("instantiateSensitivityCoverage", () => {
  test("states the exact ccw ninety-day four-pset coverage", () => {
    expect(
      instantiateSensitivityCoverage({
        project: "ccw",
        end_days: 90,
        parameter_sets: [
          { baseline: true, changes: {} },
          { baseline: false, changes: { GEOL_KSATH: 0.5 } },
          { baseline: false, changes: { GEOL_KSATH: 2 } },
          { baseline: false, changes: { LC_ROUGH: 2 } },
        ],
      }),
    ).toBe(
      "仅在 ccw 单流域、90 天窗口、相对 baseline 测试了 GEOL_KSATH×0.5, GEOL_KSATH×2, LC_ROUGH×2；未覆盖其它参数、取值与窗口",
    );
  });

  test("preserves caller pset order and round-trip numbers without mutating frozen input", () => {
    const plan = Object.freeze({
      project: "keliya",
      end_days: 30,
      parameter_sets: Object.freeze([
        Object.freeze({
          baseline: false,
          changes: Object.freeze({ RIV_ROUGH: 1.2345678901234567 }),
        }),
        Object.freeze({ baseline: true, changes: Object.freeze({}) }),
        Object.freeze({
          baseline: false,
          changes: Object.freeze({ GEOL_KSATV: 0.5000000000000001 }),
        }),
        Object.freeze({ baseline: false, changes: Object.freeze({ LC_ROUGH: 2 }) }),
      ]),
    });
    const expected =
      "仅在 keliya 单流域、30 天窗口、相对 baseline 测试了 RIV_ROUGH×1.2345678901234567, GEOL_KSATV×0.5000000000000001, LC_ROUGH×2；未覆盖其它参数、取值与窗口";

    expect(instantiateSensitivityCoverage(plan)).toBe(expected);
    expect(instantiateSensitivityCoverage(plan)).toBe(expected);
    expect(plan).toEqual({
      project: "keliya",
      end_days: 30,
      parameter_sets: [
        { baseline: false, changes: { RIV_ROUGH: 1.2345678901234567 } },
        { baseline: true, changes: {} },
        { baseline: false, changes: { GEOL_KSATV: 0.5000000000000001 } },
        { baseline: false, changes: { LC_ROUGH: 2 } },
      ],
    });
  });
});
