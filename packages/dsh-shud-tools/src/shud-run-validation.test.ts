import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createToolHarness } from "./test-harness.ts";

test("shud_run advertises a closed model contract with optional task identity", async () => {
  const h = await createToolHarness();
  try {
    const schema = h.runtime.schemas(h.agent).find((tool) => tool.name === "shud_run");
    expect(schema?.parameters).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["input_dir"],
    });
    expect(Object.keys(schema?.parameters?.properties ?? {}).sort()).toEqual([
      "end_days",
      "input_dir",
      "label",
      "project",
      "task_id",
    ]);
    expect(schema?.parameters?.properties?.task_id).toMatchObject({ type: "string" });
  } finally {
    await h.dispose();
  }
});

const invalidArguments: Array<{ name: string; args: unknown; error: RegExp }> = [
  { name: "null root", args: null, error: /object/iu },
  { name: "array root", args: [], error: /object/iu },
  { name: "string root", args: "tiny", error: /object/iu },
  { name: "numeric root", args: 7, error: /object/iu },
  { name: "boolean root", args: false, error: /object/iu },
  { name: "missing input", args: {}, error: /input_dir/iu },
  { name: "numeric input", args: { input_dir: 7 }, error: /input_dir/iu },
  { name: "null input", args: { input_dir: null }, error: /input_dir/iu },
  { name: "boolean input", args: { input_dir: false }, error: /input_dir/iu },
  { name: "array input", args: { input_dir: [] }, error: /input_dir/iu },
  { name: "empty input", args: { input_dir: "" }, error: /input_dir|project/iu },
  { name: "threads", args: { threads: 4 }, error: /unknown parameter/iu },
  { name: "workdir", args: { workdir: "/tmp" }, error: /unknown parameter/iu },
  {
    name: "inherited-looking key",
    args: { toString: "unknown" },
    error: /unknown parameter/iu,
  },
  ...[0, -1, 1.5, 9007199254740992, "30", null, false, [], {}].map((end_days) => ({
    name: `invalid END ${JSON.stringify(end_days)}`,
    args: { end_days },
    error: /end_days|positive|integer|number/iu,
  })),
  ...[7, null, false, [], "", "two\nlines", "two\rlines"].map((label) => ({
    name: `invalid label ${JSON.stringify(label)}`,
    args: { label },
    error: /label|line|invalid|string/iu,
  })),
  ...[7, null, false, [], "", ".", "..", "../tiny", "a/b", "a\\b", "a\0b"].map((project) => ({
    name: `invalid project ${JSON.stringify(project)}`,
    args: { project },
    error: /project|component|string|small/iu,
  })),
];

test.each(invalidArguments)("rejects $name before submission", async ({ args, error }) => {
  const h = await createToolHarness();
  try {
    const parameters =
      typeof args === "object" && args !== null && !Array.isArray(args)
        ? { input_dir: h.inputDir, ...args }
        : args;
    if (
      typeof args === "object" &&
      args !== null &&
      !Array.isArray(args) &&
      Object.keys(args).length === 0
    ) {
      Reflect.deleteProperty(parameters as object, "input_dir");
    }
    const result = await h.call(parameters);
    expect(result.isError).toBe(true);
    if (!result.isError) throw new Error("Invalid arguments unexpectedly submitted a run");
    expect(result.error.message).toMatch(error);
    expect(h.registry.list()).toEqual([]);
    expect(h.registry.indexes.read()).toEqual({ active: [], completed: [] });
    await expect(readdir(join(h.cwd, "runs"))).rejects.toMatchObject({ code: "ENOENT" });
    for (const [path, original] of Object.entries(h.originals)) {
      expect(await readFile(join(h.inputDir, path))).toEqual(original);
    }
  } finally {
    await h.dispose();
  }
});
