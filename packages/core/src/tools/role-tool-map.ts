import type { HarnessRole } from "./policy-gate-core";

export const CANONICAL_HARNESS_ROLES = Object.freeze([
  "coordinator",
  "repo_explorer",
  "worker",
  "coder",
  "reviewer"
] as const satisfies readonly HarnessRole[]);

export type CanonicalHarnessRole = (typeof CANONICAL_HARNESS_ROLES)[number];

export const ROLE_TOOL_IDS = Object.freeze([
  "artifact.write",
  "bash",
  "edit",
  "git.inspect",
  "harness.job.collect",
  "harness.job.submit",
  "harness.report.generate",
  "memory",
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
] as const);

export type RoleToolId = (typeof ROLE_TOOL_IDS)[number];

export interface RoleToolProfile {
  readonly toolIds: readonly RoleToolId[];
  readonly permissionNotes: readonly string[];
}

export type RoleToolMap = {
  readonly [Role in HarnessRole]: RoleToolProfile;
};

export type RoleToolIdsSnapshot = {
  readonly [Role in HarnessRole]: readonly RoleToolId[];
};

export const ROLE_TOOL_MAP = Object.freeze({
  coordinator: defineRoleToolProfile(
    [
      "harness.job.collect",
      "harness.job.submit",
      "harness.report.generate",
      "memory",
      "read",
      "spawn_agent",
      "wait_agent"
    ],
    ["memory is draft/proposal-only.", "read is limited to scheduling context."]
  ),
  repo_explorer: defineRoleToolProfile(
    ["git.inspect", "read", "repo.glob", "repo.grep", "repo.search"],
    ["git.inspect, repo.search, repo.glob, and repo.grep are read-only diagnostics."]
  ),
  worker: defineRoleToolProfile(
    [
      "artifact.write",
      "memory",
      "read",
      "rshud.compute_metrics",
      "rshud.read_output",
      "sandbox.exec",
      "shud.build",
      "shud.run"
    ],
    [
      "artifact.write is limited to workspaces/artifacts/runs.",
      "memory is draft/proposal-only.",
      "sandbox.exec is sandbox bash, not repository source editing."
    ]
  ),
  coder: defineRoleToolProfile(
    ["bash", "edit", "memory", "patch.apply", "read", "write"],
    [
      "bash, write, edit, and patch.apply are limited to the task worktree.",
      "memory is draft/proposal-only."
    ]
  ),
  reviewer: defineRoleToolProfile(
    ["memory", "read", "validator.run"],
    ["validator.run is deterministic and read-only.", "memory is draft/proposal-only."]
  )
} satisfies RoleToolMap);

const CANONICAL_HARNESS_ROLE_SET: ReadonlySet<string> = new Set(CANONICAL_HARNESS_ROLES);
const ROLE_TOOL_ID_SETS: ReadonlyMap<HarnessRole, ReadonlySet<string>> = new Map(
  CANONICAL_HARNESS_ROLES.map((role) => [role, new Set(ROLE_TOOL_MAP[role].toolIds)])
);

export function isCanonicalHarnessRole(value: unknown): value is CanonicalHarnessRole {
  return typeof value === "string" && CANONICAL_HARNESS_ROLE_SET.has(value);
}

export function getRoleToolProfile(role: HarnessRole): RoleToolProfile {
  return ROLE_TOOL_MAP[role];
}

export function getRoleToolIds(role: HarnessRole): readonly RoleToolId[] {
  return ROLE_TOOL_MAP[role].toolIds;
}

export function createRoleToolIdsSnapshot(): RoleToolIdsSnapshot {
  return Object.freeze(
    Object.fromEntries(
      CANONICAL_HARNESS_ROLES.map((role) => [
        role,
        Object.freeze([...ROLE_TOOL_MAP[role].toolIds])
      ])
    ) as RoleToolIdsSnapshot
  );
}

export function isRoleToolIdAllowed(role: HarnessRole, toolId: string): boolean {
  return ROLE_TOOL_ID_SETS.get(role)?.has(toolId) ?? false;
}

export function isRoleToolIdSubset(role: HarnessRole, toolIds: readonly string[]): boolean {
  const allowedToolIds = ROLE_TOOL_ID_SETS.get(role);
  return allowedToolIds !== undefined && toolIds.every((toolId) => allowedToolIds.has(toolId));
}

function defineRoleToolProfile(
  toolIds: readonly RoleToolId[],
  permissionNotes: readonly string[]
): RoleToolProfile {
  return Object.freeze({
    toolIds: Object.freeze([...toolIds]),
    permissionNotes: Object.freeze([...permissionNotes])
  });
}
