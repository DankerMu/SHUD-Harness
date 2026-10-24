import type { Context } from "@deepseek-ai/cordis";
import { ShudJobRegistry } from "@shud-harness/dsh-shud-jobs";
import { createShudRunTool } from "./shud-run.ts";

export const name = "shud-tools";
export const inject = ["tools", "jobs"];

export function apply(ctx: Context): void {
  if (!(ctx.jobs instanceof ShudJobRegistry)) {
    throw new Error("shud-tools requires the SHUD job registry");
  }
  ctx.tools.register(createShudRunTool(ctx.jobs));
}
