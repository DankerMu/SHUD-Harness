import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { readRecord } from "../../dsh-shud-jobs/src/poll-shud/test-harness.ts";
import { createToolHarness } from "./test-harness.ts";

test.each([
  {
    name: "request header wins",
    header: "header-model",
    option: "option-model",
    expected: "header-model",
  },
  {
    name: "agent option fallback",
    header: undefined,
    option: "option-model",
    expected: "option-model",
  },
])("captures configured provenance: $name", async ({ header, option, expected }) => {
  const h = await createToolHarness();
  try {
    Object.assign(h.agent, { options: { model: option } });
    Object.assign(h.agent.session, {
      requestHeader: () => (header === undefined ? undefined : { config: { model: header } }),
      deriveMessages: () => [
        { role: "assistant", source: { model: "assistant-route-not-response" } },
      ],
    });
    const result = await h.call({ input_dir: h.inputDir });
    expect(result.isError).toBe(false);
    const entry = h.registry.indexes.read().active[0];
    if (!entry) throw new Error("Successful submission has no index entry");
    expect(await readRecord(entry.run_dir)).toMatchObject({
      owner_session: h.ownerId,
      llm: { response_model: expected, response_model_source: "configured" },
    });
  } finally {
    await h.dispose();
  }
});

test.each([
  "no agent",
  "missing cwd",
  "empty cwd",
  "missing id",
  "missing model",
  "source model only",
])("%s fails without creating a run", async (missing) => {
  const h = await createToolHarness();
  try {
    if (missing === "missing cwd") Reflect.deleteProperty(h.agent.session.header, "cwd");
    if (missing === "empty cwd") Object.assign(h.agent.session.header, { cwd: "" });
    if (missing === "missing id") Reflect.deleteProperty(h.agent.session, "id");
    if (missing === "missing model" || missing === "source model only") {
      Object.assign(h.agent, { options: {} });
      Object.assign(h.agent.session, { requestHeader: () => undefined });
    }
    if (missing === "source model only") {
      Object.assign(h.agent.session, {
        deriveMessages: () => [{ role: "assistant", source: { model: "route-only-model" } }],
      });
    }
    const result = await h.call({ input_dir: h.inputDir }, missing === "no agent" ? null : h.agent);
    expect(result.isError).toBe(true);
    if (!result.isError) throw new Error("Missing caller authority unexpectedly submitted a run");
    expect(result.error.message).toMatch(/session|configured model/iu);
    expect(h.registry.list()).toEqual([]);
    expect(h.registry.indexes.read()).toEqual({ active: [], completed: [] });
    await expect(readdir(join(h.cwd, "runs"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await h.dispose();
  }
});
