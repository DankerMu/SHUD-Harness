import type { HarnessRole } from "./policy-gate/types.ts";

export const CANONICAL_HARNESS_ROLES = Object.freeze([
  "coordinator",
  "repo_explorer",
  "worker",
  "coder",
  "reviewer",
] as const satisfies readonly HarnessRole[]);

export type CanonicalHarnessRole = (typeof CANONICAL_HARNESS_ROLES)[number];

export const ROLE_TOOL_MAP = Object.freeze({
  coordinator: defineRoleToolProfile(
    [
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
    ["subagent"],
  ),
  // M4 contract: no M3 preset consumer or restrict validation.
  repo_explorer: defineRoleToolProfile(
    ["git.inspect", "read", "repo.glob", "repo.grep", "repo.search"],
    [],
  ),
  worker: defineRoleToolProfile(
    ["shud_run", "shud_collect", "job_output", "job_list", "job_kill"],
    [],
  ),
  // M4 contract: no M3 preset consumer or restrict validation.
  coder: defineRoleToolProfile(
    ["bash", "edit", "harness.memory.propose", "patch.apply", "read", "write"],
    [],
  ),
  // M4 contract: no M3 preset consumer or restrict validation.
  reviewer: defineRoleToolProfile(["harness.memory.propose", "read", "validator.run"], []),
});

type RoleToolEntry = (typeof ROLE_TOOL_MAP)[HarnessRole];
export type RoleToolId = RoleToolEntry["inherited"][number] | RoleToolEntry["local"][number];

export interface RoleToolProfile {
  readonly inherited: readonly RoleToolId[];
  readonly local: readonly RoleToolId[];
}

export type RoleToolMap = {
  readonly [Role in HarnessRole]: RoleToolProfile;
};

const CANONICAL_HARNESS_ROLE_SET: ReadonlySet<string> = new Set(CANONICAL_HARNESS_ROLES);
const ROLE_TOOL_ID_SETS = new Map<HarnessRole, ReadonlySet<string>>();
const allToolIds = new Set<RoleToolId>();
for (const role of CANONICAL_HARNESS_ROLES) {
  const entry = ROLE_TOOL_MAP[role];
  const roleToolIds = new Set<string>();
  for (const toolId of entry.inherited) {
    roleToolIds.add(toolId);
    allToolIds.add(toolId);
  }
  for (const toolId of entry.local) {
    roleToolIds.add(toolId);
    allToolIds.add(toolId);
  }
  ROLE_TOOL_ID_SETS.set(role, roleToolIds);
}

export const ROLE_TOOL_IDS: readonly RoleToolId[] = Object.freeze(Array.from(allToolIds).sort());

export function isCanonicalHarnessRole(value: unknown): value is CanonicalHarnessRole {
  return typeof value === "string" && CANONICAL_HARNESS_ROLE_SET.has(value);
}

export function getRoleToolIds(role: HarnessRole): RoleToolProfile {
  return ROLE_TOOL_MAP[role];
}

export function isRoleToolIdAllowed(role: HarnessRole, toolId: string): boolean {
  return ROLE_TOOL_ID_SETS.get(role)?.has(toolId) ?? false;
}

function defineRoleToolProfile<
  const Inherited extends readonly string[],
  const Local extends readonly string[],
>(inherited: Inherited, local: Local) {
  return Object.freeze({
    inherited: Object.freeze(inherited),
    local: Object.freeze(local),
  });
}
