import { describe, expect, test } from "vitest";
import * as core from "../index.ts";

const EXPECTED_CANONICAL_ROLES = [
  "coordinator",
  "repo_explorer",
  "worker",
  "coder",
  "reviewer",
] as const satisfies readonly core.CanonicalHarnessRole[];

// Normative mounted tool collections, independent of the production map.
const EXPECTED_TOOL_COLLECTIONS = {
  coordinator: {
    inherited: [
      "task_create",
      "report_generate",
      "report_validate",
      "report_submit",
      "report_decide",
      "shud_collect",
      "job_output",
      "job_list",
      "job_kill",
    ],
    local: ["subagent", "subagent_coder", "subagent_reviewer"],
  },
  repo_explorer: {
    inherited: ["read"],
    local: [],
  },
  worker: {
    inherited: ["shud_run", "shud_collect", "job_output", "job_list", "job_kill"],
    local: [],
  },
  coder: {
    inherited: ["bash", "read", "edit", "change_create", "change_submit", "shud_build"],
    local: [],
  },
  reviewer: {
    inherited: ["read", "verification_run", "shud_collect", "job_output", "job_list"],
    local: [],
  },
} as const satisfies core.RoleToolMap;

const EXPECTED_ROLE_TOOL_IDS = [
  "bash",
  "change_create",
  "change_submit",
  "edit",
  "job_kill",
  "job_list",
  "job_output",
  "read",
  "report_decide",
  "report_generate",
  "report_submit",
  "report_validate",
  "shud_build",
  "shud_collect",
  "shud_run",
  "subagent",
  "subagent_coder",
  "subagent_reviewer",
  "task_create",
  "verification_run",
] as const;

const WRITE_CLASS_TOOL_IDS = [
  "write",
  "edit",
  "patch.apply",
  "artifact.write",
  "sandbox.exec",
  "bash",
] as const;
const REPOSITORY_SOURCE_EDIT_TOOL_IDS = ["write", "edit", "patch.apply"] as const;

// Obsolete Zero-era names and the unmounted write tool remain forbidden for every role.
const REMOVED_TOOL_IDS = [
  "artifact.write",
  "git.inspect",
  "harness.job.collect",
  "harness.job.submit",
  "harness.memory.propose",
  "harness.report.generate",
  "patch.apply",
  "repo.glob",
  "repo.grep",
  "repo.search",
  "rshud.compute_metrics",
  "rshud.read_output",
  "sandbox.exec",
  "shud.build",
  "shud.run",
  "spawn_agent",
  "wait_agent",
  "validator.run",
  "write",
] as const;

describe("canonical role to tool collections", () => {
  test("matches the exact normative mounted collections", () => {
    expect(core.ROLE_TOOL_MAP).toEqual(EXPECTED_TOOL_COLLECTIONS);
    for (const role of EXPECTED_CANONICAL_ROLES) {
      expect(core.getRoleToolIds(role)).toEqual(EXPECTED_TOOL_COLLECTIONS[role]);
    }
  });

  test("contains exactly the five canonical roles with no extra or missing roles", () => {
    expect(core.CANONICAL_HARNESS_ROLES).toEqual(EXPECTED_CANONICAL_ROLES);
    expect(Object.keys(core.ROLE_TOOL_MAP).sort()).toEqual([...EXPECTED_CANONICAL_ROLES].sort());
    for (const role of EXPECTED_CANONICAL_ROLES) {
      expect(core.isCanonicalHarnessRole(role)).toBe(true);
    }
    for (const value of ["unknown", "standard", "toString", "", null, undefined, 1, {}]) {
      expect(core.isCanonicalHarnessRole(value)).toBe(false);
    }
  });

  test("exposes the exact runtime tool id inventory", () => {
    expect(core.ROLE_TOOL_IDS).toEqual(EXPECTED_ROLE_TOOL_IDS);
    expect(core.ROLE_TOOL_IDS).not.toContain("memory");
  });

  test("prevents consumers from widening published tool capabilities", () => {
    const probe = "consumer_added_tool";
    expect(Reflect.set(core.ROLE_TOOL_IDS, String(core.ROLE_TOOL_IDS.length), probe)).toBe(false);
    for (const role of EXPECTED_CANONICAL_ROLES) {
      const entry = core.getRoleToolIds(role);
      expect(Reflect.set(entry.inherited, String(entry.inherited.length), probe)).toBe(false);
      expect(Reflect.set(entry.local, String(entry.local.length), probe)).toBe(false);
      expect(Reflect.set(entry, "inherited", [probe])).toBe(false);
      expect(Reflect.set(entry, "local", [probe])).toBe(false);
      expect(Reflect.set(core.ROLE_TOOL_MAP, role, { inherited: [probe], local: [] })).toBe(false);
      expect(core.getRoleToolIds(role)).toEqual(EXPECTED_TOOL_COLLECTIONS[role]);
      expect(core.ROLE_TOOL_MAP[role]).toEqual(EXPECTED_TOOL_COLLECTIONS[role]);
      expect(core.isRoleToolIdAllowed(role, probe)).toBe(false);
      const expected = EXPECTED_TOOL_COLLECTIONS[role];
      for (const toolId of [...expected.inherited, ...expected.local]) {
        expect(core.isRoleToolIdAllowed(role, toolId)).toBe(true);
      }
      if (role === "coordinator" || role === "worker") {
        expect(
          core.evaluatePolicyGate(
            { role, toolId: expected.inherited[0], input: null },
            core.DEFAULT_SHUD_POLICY_GATE_CONTEXT,
          ),
        ).toEqual({ decision: "allow" });
        expect(
          core.evaluatePolicyGate(
            { role, toolId: probe, input: null },
            core.DEFAULT_SHUD_POLICY_GATE_CONTEXT,
          ),
        ).toMatchObject({ decision: "deny", ruleId: "role-tool-surface" });
      }
    }
    expect(core.ROLE_TOOL_IDS).toEqual(EXPECTED_ROLE_TOOL_IDS);
  });

  test("checks inherited and local membership against the independent collections", () => {
    for (const role of EXPECTED_CANONICAL_ROLES) {
      const expected = EXPECTED_TOOL_COLLECTIONS[role];
      const allowed = new Set<string>([...expected.inherited, ...expected.local]);
      for (const toolId of [...EXPECTED_ROLE_TOOL_IDS, "unknown_tool", "memory"]) {
        expect(core.isRoleToolIdAllowed(role, toolId), `${role}/${toolId}`).toBe(
          allowed.has(toolId),
        );
      }
    }
  });

  test("rejects obsolete tool names and write for every role", () => {
    for (const toolId of REMOVED_TOOL_IDS) {
      expect(core.ROLE_TOOL_IDS).not.toContain(toolId);
      for (const role of EXPECTED_CANONICAL_ROLES) {
        expect(core.isRoleToolIdAllowed(role, toolId)).toBe(false);
      }
    }
  });

  test("keeps repo_explorer and reviewer free of write-class tools", () => {
    for (const role of ["repo_explorer", "reviewer"] as const) {
      for (const toolId of WRITE_CLASS_TOOL_IDS) {
        expect(core.isRoleToolIdAllowed(role, toolId)).toBe(false);
      }
    }
  });

  test("keeps subagent exclusive to coordinator", () => {
    expect(rolesContainingAny(["subagent"])).toEqual(["coordinator"]);
  });

  test("keeps coordinator free of bash and repository source edit tools", () => {
    for (const toolId of ["bash", ...REPOSITORY_SOURCE_EDIT_TOOL_IDS]) {
      expect(core.isRoleToolIdAllowed("coordinator", toolId)).toBe(false);
    }
  });

  test("keeps worker free of repository source edit tools", () => {
    for (const toolId of REPOSITORY_SOURCE_EDIT_TOOL_IDS) {
      expect(core.isRoleToolIdAllowed("worker", toolId)).toBe(false);
    }
  });

  test("keeps coder as the only role with repository source edit access", () => {
    expect(core.isRoleToolIdAllowed("coder", "edit")).toBe(true);
    expect(core.isRoleToolIdAllowed("coder", "write")).toBe(false);
    expect(core.isRoleToolIdAllowed("coder", "patch.apply")).toBe(false);
    expect(rolesContainingAny(REPOSITORY_SOURCE_EDIT_TOOL_IDS)).toEqual(["coder"]);
  });

  test("excludes both proposal and raw harness memory from every role", () => {
    expect(rolesContainingAny(["harness.memory.propose", "memory"])).toEqual([]);
  });
});

function rolesContainingAny(toolIds: readonly string[]): core.CanonicalHarnessRole[] {
  return EXPECTED_CANONICAL_ROLES.filter((role) =>
    toolIds.some((toolId) => core.isRoleToolIdAllowed(role, toolId)),
  );
}
