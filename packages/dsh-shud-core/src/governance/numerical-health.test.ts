import { describe, expect, test } from "vitest";
import { classifyNumericalHealth, NUMERICAL_HEALTH_THRESHOLDS } from "../index.ts";

describe("classifyNumericalHealth", () => {
  test.each([
    ["water_balance_residual", 0.01, "pass"],
    ["water_balance_residual", 0.0100001, "warn"],
    ["water_balance_residual", 0.05, "warn"],
    ["water_balance_residual", 0.0500001, "fail"],
    ["water_balance_residual", null, "not_available"],
    ["cvode_failures", 0, "pass"],
    ["cvode_failures", 1, "fail"],
    ["cvode_failures", null, "not_available"],
    ["negative_state_count", 0, "pass"],
    ["negative_state_count", 1, "warn"],
    ["negative_state_count", 10, "warn"],
    ["negative_state_count", 11, "fail"],
    ["negative_state_count", null, "not_available"],
  ] as const)("classifies %s value %s as %s", (metric, value, verdict) => {
    expect(classifyNumericalHealth(metric, value)).toBe(verdict);
  });

  test.each([0, null])("rejects max_solver_dt with value %s before classification", (value) => {
    expect(() => {
      // @ts-expect-error Structurally unobservable max_solver_dt has no verdict.
      classifyNumericalHealth("max_solver_dt", value);
    }).toThrow("Unsupported numerical health metric");
  });

  test.each(["toString", "__proto__", "unknown"])(
    "rejects unsupported runtime key %s",
    (metric) => {
      expect(() => {
        // @ts-expect-error Untyped callers cannot extend the closed metric set.
        classifyNumericalHealth(metric, null);
      }).toThrow("Unsupported numerical health metric");
    },
  );

  test("keeps thresholds immutable at both registration and metric levels", () => {
    expect(Object.isFrozen(NUMERICAL_HEALTH_THRESHOLDS)).toBe(true);
    expect(Reflect.set(NUMERICAL_HEALTH_THRESHOLDS, "max_solver_dt", {})).toBe(false);
    for (const thresholds of Object.values(NUMERICAL_HEALTH_THRESHOLDS)) {
      expect(Object.isFrozen(thresholds)).toBe(true);
      expect(Reflect.set(thresholds, "pass_max", 100)).toBe(false);
      expect(Reflect.set(thresholds, "warn_max", 100)).toBe(false);
    }
    expect(classifyNumericalHealth("water_balance_residual", 0.0100001)).toBe("warn");
    expect(classifyNumericalHealth("cvode_failures", 1)).toBe("fail");
    expect(classifyNumericalHealth("negative_state_count", 11)).toBe("fail");
  });
});
