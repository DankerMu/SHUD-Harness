import { describe, expect, test } from "bun:test";
import {
  CANONICAL_HARNESS_ROLES,
  ROLE_TOOL_IDS,
  ROLE_TOOL_MAP,
  createRoleToolIdsSnapshot,
  getRoleToolIds,
  isRoleToolIdAllowed,
  isRoleToolIdSubset,
  type CanonicalHarnessRole,
  type RoleToolIdsSnapshot
} from "./role-tool-map";

const EXPECTED_CANONICAL_ROLES = [
  "coordinator",
  "repo_explorer",
  "worker",
  "coder",
  "reviewer"
] as const satisfies readonly CanonicalHarnessRole[];

const EXPECTED_ROLE_TOOL_IDS = [
  "artifact.write",
  "bash",
  "edit",
  "git.inspect",
  "harness.job.collect",
  "harness.job.submit",
  "harness.memory.propose",
  "harness.report.generate",
  "patch.apply",
  "read",
  "repo.glob",
  "repo.grep",
  "repo.search",
  "rshud.compute_metrics",
  "rshud.read_output",
  "sandbox.exec",
  "shud.build",
  "shud.run",
  "spawn_agent",
  "validator.run",
  "wait_agent",
  "write"
] as const;

const EXPECTED_TOOL_IDS = {
  coordinator: [
    "harness.job.collect",
    "harness.job.submit",
    "harness.memory.propose",
    "harness.report.generate",
    "read",
    "spawn_agent",
    "wait_agent"
  ],
  repo_explorer: ["git.inspect", "read", "repo.glob", "repo.grep", "repo.search"],
  worker: [
    "artifact.write",
    "harness.memory.propose",
    "read",
    "rshud.compute_metrics",
    "rshud.read_output",
    "sandbox.exec",
    "shud.build",
    "shud.run"
  ],
  coder: ["bash", "edit", "harness.memory.propose", "patch.apply", "read", "write"],
  reviewer: ["harness.memory.propose", "read", "validator.run"]
} as const satisfies RoleToolIdsSnapshot;

const WRITE_CLASS_TOOL_IDS = [
  "write",
  "edit",
  "patch.apply",
  "artifact.write",
  "sandbox.exec",
  "bash"
] as const;

const REPOSITORY_SOURCE_EDIT_TOOL_IDS = ["write", "edit", "patch.apply"] as const;
const SPAWN_TOOL_IDS = ["spawn_agent", "wait_agent"] as const;

describe("canonical role to tool id map", () => {
  test("matches the OpenSpec exact sorted toolIds snapshot oracle", () => {
    expect(createRoleToolIdsSnapshot()).toEqual(EXPECTED_TOOL_IDS);
  });

  test("contains exactly the five canonical roles with no extra or missing roles", () => {
    expect(CANONICAL_HARNESS_ROLES).toEqual(EXPECTED_CANONICAL_ROLES);
    expect(Object.keys(ROLE_TOOL_MAP).sort()).toEqual([...EXPECTED_CANONICAL_ROLES].sort());
  });

  test("keeps the RoleToolId union aligned with the exact comparable ids", () => {
    expect(ROLE_TOOL_IDS).toEqual(EXPECTED_ROLE_TOOL_IDS);
    expect(ROLE_TOOL_IDS).not.toContain("memory");
  });

  test("keeps comparable snapshots limited to sorted toolIds", () => {
    const snapshot = createRoleToolIdsSnapshot();

    for (const role of EXPECTED_CANONICAL_ROLES) {
      expect(snapshot[role]).toEqual([...EXPECTED_TOOL_IDS[role]]);
      expect(snapshot[role]).toEqual([...snapshot[role]].sort());
      expect(Object.prototype.hasOwnProperty.call(snapshot[role], "permissionNotes")).toBe(false);
      expect(ROLE_TOOL_MAP[role].permissionNotes.length).toBeGreaterThan(0);
    }
  });

  test("keeps repo_explorer and reviewer free of write-class tool ids", () => {
    expect(intersect(getRoleToolIds("repo_explorer"), WRITE_CLASS_TOOL_IDS)).toEqual([]);
    expect(intersect(getRoleToolIds("reviewer"), WRITE_CLASS_TOOL_IDS)).toEqual([]);
  });

  test("keeps spawn and wait tools exclusive to coordinator", () => {
    expect(rolesContainingAny(SPAWN_TOOL_IDS)).toEqual(["coordinator"]);
  });

  test("keeps coordinator free of bash and repository source edit tools", () => {
    expect(intersect(getRoleToolIds("coordinator"), ["bash", ...REPOSITORY_SOURCE_EDIT_TOOL_IDS]))
      .toEqual([]);
  });

  test("keeps worker free of repository source edit tools", () => {
    expect(intersect(getRoleToolIds("worker"), REPOSITORY_SOURCE_EDIT_TOOL_IDS)).toEqual([]);
  });

  test("keeps coder as the only role with write, edit, or patch.apply", () => {
    expect(getRoleToolIds("coder")).toEqual(expect.arrayContaining(REPOSITORY_SOURCE_EDIT_TOOL_IDS));
    expect(rolesContainingAny(REPOSITORY_SOURCE_EDIT_TOOL_IDS)).toEqual(["coder"]);
  });

  test("checks subset semantics against toolIds only", () => {
    expect(isRoleToolIdSubset("coordinator", EXPECTED_TOOL_IDS.coordinator)).toBe(true);
    expect(isRoleToolIdAllowed("worker", "artifact.write")).toBe(true);
    expect(isRoleToolIdSubset("reviewer", ["validator.run", "harness.memory.propose"]))
      .toBe(true);
    expect(isRoleToolIdSubset("reviewer", ["memory"])).toBe(false);
    expect(isRoleToolIdSubset("reviewer", ["harness.memory.propose is draft/proposal-only."]))
      .toBe(false);
  });

  test("keeps proposal memory adapter explicit and excludes raw Zero memory", () => {
    expect(rolesContainingAny(["harness.memory.propose"])).toEqual([
      "coordinator",
      "worker",
      "coder",
      "reviewer"
    ]);
    expect(isRoleToolIdAllowed("reviewer", "harness.memory.propose")).toBe(true);
    expect(isRoleToolIdAllowed("reviewer", "memory")).toBe(false);
    expect(isRoleToolIdSubset("repo_explorer", ["harness.memory.propose"])).toBe(false);
  });
});

function rolesContainingAny(toolIds: readonly string[]): CanonicalHarnessRole[] {
  return EXPECTED_CANONICAL_ROLES.filter(
    (role) => intersect(getRoleToolIds(role), toolIds).length > 0
  );
}

function intersect(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value));
}
