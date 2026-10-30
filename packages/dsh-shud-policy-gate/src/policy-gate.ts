import type { Context } from "@deepseek-ai/cordis";
import type { PreToolDecision } from "@deepseek-ai/dsh-tools";
import {
  DEFAULT_SHUD_POLICY_GATE_CONTEXT,
  evaluatePolicyGate,
  presetIdToRole,
  readCallerPresetId,
} from "@shud-harness/dsh-shud-core";
import type { PolicyGateDecision } from "@shud-harness/dsh-shud-core";
import { reportApproval } from "./report-approval.ts";

export const name = "shud-policy-gate";
export const POLICY_EVALUATION_FAILURE_REASON = "Tool denied because policy evaluation failed.";

/** Host-owned approval follows this listener; a permitted ordinary call continues the waterfall. */
export function apply(ctx: Context): void {
  const logger = ctx.logger(name);
  let deny = 0;
  let ask = 0;
  ctx.on("tools/pre-execute", (execution, next): Promise<PreToolDecision> => {
    const role = presetIdToRole(readCallerPresetId(execution.agent));
    const input = execution.arguments;
    const sessionCwd = execution.agent?.session?.header?.cwd;
    const cwd = typeof sessionCwd === "string" ? sessionCwd : undefined;
    let decision: PolicyGateDecision;
    try {
      const workdir: unknown =
        input && typeof input === "object" ? Reflect.get(input, "workdir") : undefined;
      decision = evaluatePolicyGate(
        {
          toolId: execution.name,
          role,
          input,
          workDir: typeof workdir === "string" ? workdir : cwd,
        },
        DEFAULT_SHUD_POLICY_GATE_CONTEXT,
      );
    } catch {
      deny++;
      logger.info(`deny ${execution.name} policy-evaluation-failed`);
      return Promise.resolve({ kind: "deny", reason: POLICY_EVALUATION_FAILURE_REASON });
    }
    if (decision.decision === "deny") {
      deny++;
      logger.info(`deny ${execution.name} ${decision.ruleId}`);
      return Promise.resolve({ kind: "deny", reason: decision.reason });
    }
    if (execution.name === "report_submit" || execution.name === "report_decide") {
      const approval = reportApproval(execution.name, input, cwd);
      ask++;
      logger.info(`ask ${execution.name} report-approval`);
      return Promise.resolve(approval);
    }
    return next();
  });
  ctx.effect(() => () => {
    logger.info(`deny=${deny} ask=${ask}`);
  });
}
