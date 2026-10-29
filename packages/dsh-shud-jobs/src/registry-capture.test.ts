import { readdir } from "node:fs/promises";
import { inspect } from "node:util";
import { expect, test } from "vitest";
import { LocalJobRegistry } from "@deepseek-ai/dsh-jobs-local";
import { ShudJobRegistry } from "./index.ts";
import { createHarness } from "./test-harness.ts";

const fields = [
  "stackRepos.SHUD",
  "stackRepos.rSHUD",
  "stackRepos.AutoSHUD",
  "hostVersion",
  "llm.base_url",
  "llm.request_alias",
];
const invalid = [undefined, "", null, 42, [], { payload: "PRIVATE_CONFIG_VALUE" }];

function replace(config: object, field: string, value: unknown) {
  const result: Record<string, unknown> = structuredClone(config);
  const [parent, child] = field.split(".");
  if (child) {
    const nested = result[parent] as Record<string, unknown>;
    if (value === undefined) delete nested[child];
    else nested[child] = value;
  } else if (value === undefined) delete result[parent];
  else result[parent] = value;
  return result;
}

for (const field of fields) {
  test.each(invalid)(
    `apply rejects invalid ${field}: %j with exact key and no payload`,
    async (value) => {
      const h = await createHarness(undefined, "absent", false);
      try {
        const config = replace(h.config, field, value);
        const parsed = await ShudJobRegistry.Config["~standard"].validate(config);
        expect(parsed).toHaveProperty("issues");
        if (!("issues" in parsed) || !parsed.issues) throw new Error("Invalid config accepted");
        expect(parsed.issues).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: field.split(".") })]),
        );
        const error: unknown = await h
          .apply(ShudJobRegistry, config)
          .catch((error: unknown) => error);
        expect(error).toBeInstanceOf(Error);
        expect(inspect(error)).toContain(field);
        expect(inspect(error)).not.toContain("PRIVATE_CONFIG_VALUE");
        expect(h.ctx.get("jobs")).toBeUndefined();
        expect(await readdir(h.cwd)).toEqual([]);
        expect(await readdir(h.stateDir)).toEqual([]);
      } finally {
        await h.dispose();
      }
    },
  );
}

test.each([
  ...["stackRepos", "llm"].flatMap((field) => invalid.map((value) => [field, value] as const)),
  ...["stackRepos.SHUD", "stackRepos.rSHUD", "stackRepos.AutoSHUD", "sundialsRoot"].map(
    (field) => [field, "relative/PRIVATE_CONFIG_VALUE"] as const,
  ),
  ...invalid
    .filter((value) => value !== undefined)
    .map((value) => ["sundialsRoot", value] as const),
  ["unexpected", "PRIVATE_CONFIG_VALUE"],
  ["stackRepos.unexpected", "PRIVATE_CONFIG_VALUE"],
  ["llm.unexpected", "PRIVATE_CONFIG_VALUE"],
])("apply rejects closed capture field %s=%j", async (field, value) => {
  const h = await createHarness(undefined, "absent", false);
  try {
    const config = replace(h.config, field, value);
    const error: unknown = await h.apply(ShudJobRegistry, config).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(inspect(error)).toContain(field);
    expect(inspect(error)).not.toContain("PRIVATE_CONFIG_VALUE");
    expect(h.ctx.get("jobs")).toBeUndefined();
    expect(await readdir(h.cwd)).toEqual([]);
  } finally {
    await h.dispose();
  }
});

test.each([false, true])(
  "capture config applies without git or workspace evidence; optional SUNDIALS=%s",
  async (sundials) => {
    const h = await createHarness(undefined, "absent", false);
    try {
      const config = { ...h.config, ...(sundials ? { sundialsRoot: h.root } : {}) };
      const parent = LocalJobRegistry.Config["~standard"].validate({});
      const parsed = await ShudJobRegistry.Config["~standard"].validate(config);
      if (!("value" in parent) || !("value" in parsed)) throw new Error("Valid config rejected");
      if (typeof parent.value !== "object" || parent.value === null)
        throw new Error("Expected parent object");
      expect(parsed.value).toEqual({ ...parent.value, ...config });
      await h.apply(ShudJobRegistry, config);
      expect(h.ctx.jobs).toBeInstanceOf(ShudJobRegistry);
      expect(await readdir(h.cwd)).toEqual([]);
      for (const repository of Object.values(h.config.stackRepos))
        expect(await readdir(repository)).toEqual([]);
    } finally {
      await h.dispose();
    }
  },
);

test("capture config preserves every explicit parent key and parent schema identity", async () => {
  const h = await createHarness(undefined, "absent", false);
  const schema = LocalJobRegistry.Config;
  const parentInput = {
    maxConcurrentJobsPerOwner: 3,
    retainBytes: 8192,
    settledRetainBytes: 4096,
    pumpPollMs: 13,
  };
  try {
    const parent = schema["~standard"].validate(parentInput);
    const parsed = await ShudJobRegistry.Config["~standard"].validate({
      ...h.config,
      ...parentInput,
    });
    if (!("value" in parent) || !("value" in parsed))
      throw new Error("Valid parent config rejected");
    if (typeof parent.value !== "object" || parent.value === null)
      throw new Error("Expected parent object");
    expect(parsed.value).toEqual({ ...parent.value, ...h.config });
    await h.apply(ShudJobRegistry, { ...h.config, ...parentInput });
    expect(LocalJobRegistry.Config).toBe(schema);
    expect(schema["~standard"].validate(parentInput)).toEqual(parent);
    expect(await readdir(h.cwd)).toEqual([]);
  } finally {
    await h.dispose();
  }
});
