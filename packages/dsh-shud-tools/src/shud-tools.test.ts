import type { Context } from "@deepseek-ai/cordis";
import { LocalJobRegistry } from "@deepseek-ai/dsh-jobs-local";
import type { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { expect, test } from "vitest";
import { createHarness } from "../../dsh-shud-jobs/src/test-harness.ts";
import { apply } from "./index.ts";

test("ordinary host jobs cannot silently substitute for the SHUD registry", async () => {
  const h = await createHarness(undefined, "absent");
  try {
    const providers: Array<Parameters<SystemPrompt["tools"]>[0]> = [];
    await h.ctx.plugin((services: Context) => {
      services.provide("systemPrompt", {
        tools(provider: Parameters<SystemPrompt["tools"]>[0]) {
          providers.push(provider);
          return () => providers.splice(providers.indexOf(provider), 1);
        },
      });
    });
    await h.apply(LocalJobRegistry, {});
    await h.apply(ToolRuntime, { mode: "native" });
    let inspected = false;
    await h.ctx.plugin({
      inject: ["tools", "jobs"],
      apply(consumer: Context) {
        expect(() => apply(consumer)).toThrow("shud-tools requires the SHUD job registry");
        expect(consumer.tools.schemas()).toEqual([]);
        expect(consumer.jobs.list()).toEqual([]);
        inspected = true;
      },
    });
    expect(inspected).toBe(true);
    expect(providers).toHaveLength(1);
  } finally {
    await h.dispose();
  }
});
