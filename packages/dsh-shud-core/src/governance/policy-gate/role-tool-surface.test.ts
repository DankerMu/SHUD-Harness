import { describe, expect, test } from "vitest";
import * as core from "../../index.ts";

const { DEFAULT_SHUD_POLICY_GATE_CONTEXT } = core;

// OpenSpec agent-presets normative sets, independent of the production map.
const EXPECTED_TOOL_IDS = {
  coordinator: [
    "task_create",
    "report_generate",
    "report_validate",
    "report_submit",
    "report_decide",
    "shud_collect",
    "job_output",
    "job_list",
    "job_kill",
    "subagent",
    "subagent_coder",
    "subagent_reviewer",
  ],
  worker: ["shud_run", "shud_collect", "job_output", "job_list", "job_kill"],
  coder: ["bash", "read", "edit", "change_create", "change_submit", "shud_build"],
  reviewer: ["read", "verification_run", "shud_collect", "job_output", "job_list"],
} as const;
const LEGACY_TOOL_IDS = [
  "shud.run",
  "shud.build",
  "harness.job.submit",
  "harness.job.collect",
  "harness.report.generate",
  "spawn_agent",
  "wait_agent",
  "harness.memory.propose",
  "patch.apply",
  "validator.run",
  "git.inspect",
  "repo.glob",
  "repo.grep",
  "repo.search",
  "write",
] as const;
const TEST_TOOL_IDS = [
  ...new Set(Object.values(EXPECTED_TOOL_IDS).flat()),
  ...LEGACY_TOOL_IDS,
  "unknown_tool",
];

describe("SHUD role tool surface public contract", () => {
  test("denies worker report_generate as role-tool-surface authority", () => {
    const decision = core.evaluatePolicyGate(
      { role: "worker", toolId: "report_generate", input: {} },
      DEFAULT_SHUD_POLICY_GATE_CONTEXT,
    );

    expect(decision).toMatchObject({
      decision: "deny",
      ruleId: "role-tool-surface",
      guardClass: "authority",
    });
  });

  test("returns worker inherited tools and an empty local collection", () => {
    expect(core.getRoleToolIds("worker")).toEqual({
      inherited: ["shud_run", "shud_collect", "job_output", "job_list", "job_kill"],
      local: [],
    });
  });

  test("rejects classifying role-tool-surface authority as capability", () => {
    expect(() =>
      core.assertPolicyGateContextGuardClasses({
        rules: [
          {
            ruleId: "role-tool-surface",
            description: "Attempts to downgrade role tool surface authority.",
            guardClass: "capability",
            evaluate: () => ({ decision: "allow" }),
          },
        ],
      }),
    ).toThrow(
      "Policy gate guard_class lint failed: role-tool-surface: known authority rule cannot be classified as capability",
    );
  });

  test("allows worker shud_run through the SHUD context", () => {
    expect(
      core.evaluatePolicyGate(
        { role: "worker", toolId: "shud_run", input: {} },
        DEFAULT_SHUD_POLICY_GATE_CONTEXT,
      ),
    ).toEqual({ decision: "allow" });
  });

  for (const role of ["coordinator", "worker", "coder", "reviewer"] as const) {
    const expectedAllowed = new Set<string>(EXPECTED_TOOL_IDS[role]);
    test.each(TEST_TOOL_IDS)(`${role} decides %s against the normative tool surface`, (toolId) => {
      const decision = core.evaluatePolicyGate(
        { role, toolId, input: null },
        DEFAULT_SHUD_POLICY_GATE_CONTEXT,
      );
      if (expectedAllowed.has(toolId)) {
        expect(decision).toEqual({ decision: "allow" });
      } else {
        expect(decision).toMatchObject({
          decision: "deny",
          ruleId: "role-tool-surface",
          guardClass: "authority",
        });
        if (decision.decision === "deny") {
          expect(decision.reason).toContain(role);
          expect(decision.reason).toContain(toolId);
          expect(core.PolicyGateRemediationSchema.safeParse(decision.remediation).success).toBe(
            true,
          );
          expect(decision.remediation.next_action).toBe("adjust_scope");
        }
      }
    });
  }

  test.each([
    ["worker", "report_generate"],
    ["worker", "subagent"],
    ["coordinator", "shud_run"],
    ["coordinator", "read"],
    ["worker", "read"],
  ] as const)("denies sensitive off-role call %s/%s", (role, toolId) => {
    expect(
      core.evaluatePolicyGate({ role, toolId, input: {} }, DEFAULT_SHUD_POLICY_GATE_CONTEXT),
    ).toMatchObject({ decision: "deny", ruleId: "role-tool-surface", guardClass: "authority" });
  });

  test("uses the canonical inherited job and local subagent partition for decisions", () => {
    for (const role of ["coordinator", "worker"] as const) {
      const entry = core.ROLE_TOOL_MAP[role];
      for (const toolId of ["job_output", "job_list", "job_kill"]) {
        expect(entry.inherited).toContain(toolId);
        expect(entry.local).not.toContain(toolId);
      }
      expect(entry.inherited).not.toContain("subagent");
      expect(entry.local).toEqual(
        role === "coordinator" ? ["subagent", "subagent_coder", "subagent_reviewer"] : [],
      );
      for (const toolId of [...entry.inherited, ...entry.local]) {
        expect(core.isRoleToolIdAllowed(role, toolId)).toBe(true);
        expect(
          core.evaluatePolicyGate({ role, toolId, input: null }, DEFAULT_SHUD_POLICY_GATE_CONTEXT),
        ).toEqual({ decision: "allow" });
      }
    }
  });

  test.each(["unknown", "repo_explorer"] as const)(
    "does not restrict non-policy role %s",
    (role) => {
      for (const toolId of TEST_TOOL_IDS) {
        expect(
          core.evaluatePolicyGate({ role, toolId, input: null }, DEFAULT_SHUD_POLICY_GATE_CONTEXT),
        ).toEqual({ decision: "allow" });
      }
    },
  );

  test.each([
    ["worker", "report_generate", "deny"],
    ["worker", "shud_run", "allow"],
    ["coordinator", "shud_run", "deny"],
    ["coordinator", "subagent", "allow"],
    ["unknown", "unknown_tool", "allow"],
    ["repo_explorer", "unknown_tool", "allow"],
    ["coder", "unknown_tool", "deny"],
    ["coder", "shud_build", "allow"],
    ["coder", "shud_run", "deny"],
    ["reviewer", "unknown_tool", "deny"],
    ["reviewer", "verification_run", "allow"],
    ["reviewer", "shud_build", "deny"],
  ] as const)("does not access input or workDir for %s/%s", (role, toolId, expected) => {
    let inputReads = 0;
    let workDirReads = 0;
    const call: core.PolicyGateToolCall = {
      role,
      toolId,
      get input(): unknown {
        inputReads += 1;
        throw new Error("input must not be read");
      },
      get workDir(): string {
        workDirReads += 1;
        throw new Error("workDir must not be read");
      },
    };

    expect(core.evaluatePolicyGate(call, DEFAULT_SHUD_POLICY_GATE_CONTEXT).decision).toBe(expected);
    expect(inputReads).toBe(0);
    expect(workDirReads).toBe(0);
  });

  test.each([
    ["coordinator", "task_create", "allow"],
    ["coordinator", "shud_run", "deny"],
    ["worker", "shud_run", "allow"],
    ["worker", "report_generate", "deny"],
    ["coder", "change_create", "allow"],
    ["coder", "shud_run", "deny"],
    ["reviewer", "verification_run", "allow"],
    ["reviewer", "shud_build", "deny"],
  ] as const)("does not inspect a revoked input proxy for %s/%s", (role, toolId, expected) => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(
      core.evaluatePolicyGate({ role, toolId, input: proxy }, DEFAULT_SHUD_POLICY_GATE_CONTEXT)
        .decision,
    ).toBe(expected);
  });

  test.each([
    { input: null },
    { input: ["secret-input"] },
    { input: { payload: "secret-input" } },
    { input: "secret-input" },
  ])("keeps denial independent of input $input and workDir", ({ input }) => {
    for (const [role, toolId] of [
      ["coordinator", "shud_run"],
      ["worker", "report_generate"],
      ["coder", "shud_run"],
      ["reviewer", "shud_build"],
    ] as const) {
      const decision = core.evaluatePolicyGate(
        { role, toolId, input, workDir: "/secret-work-dir" },
        DEFAULT_SHUD_POLICY_GATE_CONTEXT,
      );
      expect(decision).toMatchObject({
        decision: "deny",
        ruleId: "role-tool-surface",
        guardClass: "authority",
      });
      if (decision.decision === "deny") {
        expect(decision.reason).toBe(`Role ${role} cannot call tool ${toolId}.`);
        expect(core.PolicyGateRemediationSchema.safeParse(decision.remediation).success).toBe(true);
      }
      expect(JSON.stringify(decision)).not.toContain("secret-input");
      expect(JSON.stringify(decision)).not.toContain("/secret-work-dir");
    }
  });

  test("exports one SHUD authority rule and singleton default context", () => {
    expect(core.ROLE_TOOL_SURFACE_RULE_ID).toBe("role-tool-surface");
    expect(DEFAULT_SHUD_POLICY_GATE_CONTEXT).toBe(core.DEFAULT_SHUD_POLICY_GATE_CONTEXT);
    expect(DEFAULT_SHUD_POLICY_GATE_CONTEXT.rules).toEqual([core.ROLE_TOOL_SURFACE_RULE]);
    expect(DEFAULT_SHUD_POLICY_GATE_CONTEXT.rules[0]).toBe(core.ROLE_TOOL_SURFACE_RULE);
    expect(core.ROLE_TOOL_SURFACE_RULE).toMatchObject({
      ruleId: "role-tool-surface",
      guardClass: "authority",
    });
  });

  test("reserves exactly the raw-data, parameter-schema and role authority ids", () => {
    expect(core.RESERVED_AUTHORITY_POLICY_RULE_IDS).toEqual([
      "raw-data-write",
      "tool-parameter-schema-validation",
      "role-tool-surface",
    ]);
    expect(core.isReservedAuthorityPolicyRuleId("role-tool-surface")).toBe(true);
    expect(core.isReservedAuthorityPolicyRuleId("role-tool-surface-extra")).toBe(false);
  });

  test("leaves the generic evaluator default empty rather than applying SHUD policy", () => {
    const call: core.PolicyGateToolCall = {
      role: "worker",
      toolId: "report_generate",
      input: {},
    };
    expect(core.EMPTY_POLICY_GATE_CONTEXT.rules).toEqual([]);
    expect(core.evaluatePolicyGate(call)).toEqual({ decision: "allow" });
    expect(core.evaluatePolicyGate(call, core.EMPTY_POLICY_GATE_CONTEXT)).toEqual({
      decision: "allow",
    });
    expect(core.evaluatePolicyGate(call, DEFAULT_SHUD_POLICY_GATE_CONTEXT).decision).toBe("deny");
  });

  test.each([
    ["coder", "shud_run"],
    ["reviewer", "shud_build"],
  ] as const)("denies off-role M4 call %s/%s as authority", (role, toolId) => {
    expect(
      core.evaluatePolicyGate({ role, toolId, input: {} }, DEFAULT_SHUD_POLICY_GATE_CONTEXT),
    ).toMatchObject({ decision: "deny", ruleId: "role-tool-surface", guardClass: "authority" });
  });
});
