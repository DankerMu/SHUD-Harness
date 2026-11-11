import type { Context } from "@deepseek-ai/cordis";
import type { PreToolDecision } from "@deepseek-ai/dsh-tools";
import {
  isRoleToolIdAllowed,
  presetIdToRole,
  readCallerPresetId,
} from "@shud-harness/dsh-shud-core";
import { decideRawAccess, normalizeRawDirs } from "./decide.ts";

export const name = "shud-raw-guard";

function fieldsOf(execution: unknown) {
  if (
    !execution ||
    typeof execution !== "object" ||
    !("name" in execution) ||
    typeof execution.name !== "string"
  )
    return undefined;
  const agent = "agent" in execution ? execution.agent : undefined;
  const session =
    agent && typeof agent === "object" && "session" in agent ? agent.session : undefined;
  const header =
    session && typeof session === "object" && "header" in session ? session.header : undefined;
  const cwd = header && typeof header === "object" && "cwd" in header ? header.cwd : undefined;
  return {
    name: execution.name,
    arguments: "arguments" in execution ? execution.arguments : undefined,
    cwd: typeof cwd === "string" ? cwd : process.cwd(),
  };
}

export function apply(ctx: Context, config?: unknown): void {
  const options = normalizeRawDirs(config);
  const logger = ctx.logger(name);
  let deny = 0;
  let ask = 0;
  ctx.on("tools/pre-execute", (execution, next): Promise<PreToolDecision> => {
    const call = fieldsOf(execution);
    if (!call) return next();
    const decision = decideRawAccess(call, options);
    if (decision.kind === "next") return next();
    if (decision.kind === "deny") {
      logger.info(`deny ${call.name} ${decision.code}`);
      deny++;
      return Promise.resolve({ kind: "deny", reason: decision.reason! });
    }
    // ADR-0016: a known role's off-surface call goes to the policy-gate role deny, not a PI card.
    const role = presetIdToRole(readCallerPresetId(execution.agent));
    if (role !== "unknown" && !isRoleToolIdAllowed(role, call.name)) {
      logger.info(`next ${call.name} role-deferred`);
      return next();
    }
    logger.info(`ask ${call.name} ${decision.code}`);
    ask++;
    return Promise.resolve({
      kind: "ask",
      reason: decision.reason,
      displayReason: decision.displayReason,
    });
  });
  ctx.effect(() => () => {
    logger.info(`deny=${deny} ask=${ask}`);
  });
}
