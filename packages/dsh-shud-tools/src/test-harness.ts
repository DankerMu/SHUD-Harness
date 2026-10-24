import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolCallId } from "@deepseek-ai/dsh-llm";
import type { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { ShudJobRegistry } from "@shud-harness/dsh-shud-jobs";
import { createHarness } from "../../dsh-shud-jobs/src/test-harness.ts";
import { writeInputTree } from "../../dsh-shud-jobs/src/submit-shud/test-harness.ts";
import {
  installFakeShud,
  terminateGroup,
} from "../../dsh-shud-jobs/src/detached-shud/test-harness.ts";
import {
  readRecord,
  waitForOwnershipRelease,
} from "../../dsh-shud-jobs/src/poll-shud/test-harness.ts";
import * as shudTools from "./index.ts";

interface ToolHarnessOptions {
  mode?: "held" | "immediate" | "resistant";
  code?: number;
  pumpPollMs?: number;
}

export async function createToolHarness(options: ToolHarnessOptions = {}) {
  const h = await createHarness(undefined, "absent");
  try {
    const inputDir = join(h.root, "input", "tiny");
    const originals = await writeInputTree(inputDir);
    await installFakeShud(h.shudBin, options.code ?? 0, options.mode ?? "held");
    const providers: Array<Parameters<SystemPrompt["tools"]>[0]> = [];
    await h.ctx.plugin((services: Context) => {
      // Only the public native-mode prompt-provider registration seam is doubled.
      services.provide("systemPrompt", {
        tools(provider: Parameters<SystemPrompt["tools"]>[0]) {
          providers.push(provider);
          return () => providers.splice(providers.indexOf(provider), 1);
        },
      });
    });
    const registryFiber = await h.apply(ShudJobRegistry, {
      ...h.config,
      pumpPollMs: options.pumpPollMs ?? 10,
    });
    let registryDisposed = false;
    await h.apply(ToolRuntime, { mode: "native" });
    await h.apply(shudTools, {});
    let tools: ToolRuntime | undefined;
    let jobs: ShudJobRegistry | undefined;
    await h.ctx.plugin({
      inject: ["tools", "jobs"],
      apply(consumer: Context) {
        tools = consumer.tools;
        if (!(consumer.jobs instanceof ShudJobRegistry)) {
          throw new Error("SHUD registry did not activate");
        }
        jobs = consumer.jobs;
      },
    });
    if (!tools || !jobs || providers.length !== 1) {
      throw new Error("Native ToolRuntime and SHUD registry did not activate");
    }
    const registry = jobs;
    const runtime = tools;
    const agent = h.ctx.agents.get(h.ownerId);
    if (!agent) throw new Error("Calling session agent is unavailable");
    // Extend the existing public Agent/Session boundary double, not a host implementation.
    Object.assign(agent, { options: { model: "fallback-test-model" } });
    Object.assign(agent.session, {
      requestHeader: () => ({ config: { model: "configured-test-model" } }),
    });
    return {
      ...h,
      inputDir,
      originals,
      registry,
      agent,
      runtime,
      async disposeRegistry() {
        await registryFiber.dispose();
        await waitForOwnershipRelease(h.stateDir);
        registryDisposed = true;
      },
      async call(arguments_: unknown, caller: Agent | null = agent) {
        return runtime.execute({
          callId: "shud-run-consumer-tracer" as ToolCallId,
          name: "shud_run",
          arguments: arguments_,
          ...(caller === null ? {} : { agent: caller }),
          signal: new AbortController().signal,
        });
      },
      async dispose() {
        // Terminate only groups recorded by this isolated registry, including failures after submit.
        // Teardown itself deliberately leaves unmarked SHUD processes alive.
        try {
          for (const entry of registry.indexes.read().active) {
            const record = await readRecord(entry.run_dir);
            if (record.pid !== null) await terminateGroup(record.pid);
          }
          if (!registryDisposed) await registry.pollOnce();
        } finally {
          await h.dispose();
        }
      },
    };
  } catch (error) {
    await h.dispose();
    throw error;
  }
}
