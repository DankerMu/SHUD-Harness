import type { Context } from "@deepseek-ai/cordis";
import { ShudJobRegistry } from "@shud-harness/dsh-shud-jobs";
import { createShudRunTool } from "./shud-run.ts";
import { createShudCollectTool } from "./shud-collect.ts";
import { createTaskCreateTool } from "./task-create.ts";
import { createReportGenerateTool } from "./report-generate.ts";
import { createReportValidateTool } from "./report-validate.ts";
import { createReportSubmitTool, createReportDecideTool } from "./report-decision.ts";

export const name = "shud-tools";
export const inject = ["tools", "jobs"];

export function apply(ctx: Context): void {
  if (!(ctx.jobs instanceof ShudJobRegistry)) {
    throw new Error("shud-tools requires the SHUD job registry");
  }
  ctx.tools.register(createShudRunTool(ctx.jobs));
  ctx.tools.register(createShudCollectTool(ctx.jobs));
  ctx.tools.register(createTaskCreateTool());
  ctx.tools.register(createReportGenerateTool(ctx.jobs));
  ctx.tools.register(createReportValidateTool());
  ctx.tools.register(createReportSubmitTool());
  ctx.tools.register(createReportDecideTool());
}
