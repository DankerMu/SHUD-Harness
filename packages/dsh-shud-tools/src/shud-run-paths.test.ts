import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { readRecord } from "../../dsh-shud-jobs/src/poll-shud/test-harness.ts";
import { createToolHarness } from "./test-harness.ts";

test.each([
  "missing",
  "file",
  "cfg absent",
  "internal symlink",
  "FIFO",
  "run overlap",
  "state overlap",
])("real registry rejects input with %s before creating a run", async (kind) => {
  const h = await createToolHarness();
  try {
    let input = h.inputDir;
    let cwd = h.cwd;
    let error = /ENOENT|directory|regular|parameter|inside|unsafe/iu;
    if (kind === "missing") input = join(h.root, "missing");
    if (kind === "file") input = join(h.inputDir, "tiny.cfg.para");
    if (kind === "cfg absent") await rm(join(input, "tiny.cfg.para"));
    if (kind === "internal symlink") {
      await symlink(join(input, "binary.dat"), join(input, "tiny.att"));
      error = /tiny\.att/iu;
    }
    if (kind === "FIFO") {
      const fifo = spawnSync("mkfifo", [join(input, "forcing.pipe")], { encoding: "utf8" });
      if (fifo.error || fifo.status !== 0)
        throw new Error("mkfifo fixture failed", { cause: fifo.error });
      error = /forcing\.pipe/iu;
    }
    if (kind === "run overlap") {
      cwd = input;
      Object.assign(h.agent.session.header, { cwd });
    }
    if (kind === "state overlap") input = h.stateDir;
    const result = await h.call({ input_dir: input, project: "tiny" });
    expect(result.isError).toBe(true);
    if (!result.isError) throw new Error("Unsafe input unexpectedly submitted a run");
    expect(result.error.message).toMatch(error);
    expect(h.registry.list()).toEqual([]);
    expect(h.registry.indexes.read()).toEqual({ active: [], completed: [] });
    await expect(readdir(join(cwd, "runs"))).rejects.toMatchObject({ code: "ENOENT" });
    for (const [path, original] of Object.entries(h.originals)) {
      if (kind === "cfg absent" && path === "tiny.cfg.para") continue;
      expect(await readFile(join(h.inputDir, path))).toEqual(original);
    }
  } finally {
    await h.dispose();
  }
});

test.each(["relative", "trailing separator", "alias", "dot", "dotdot", "native alias traversal"])(
  "submits %s input without lexical path collapse or original-input mutation",
  async (kind) => {
    const h = await createToolHarness();
    try {
      let input = h.inputDir;
      let project: string | undefined;
      if (kind === "relative") input = "../input/tiny";
      if (kind === "trailing separator") input += "///";
      if (kind === "alias") {
        input = join(h.root, "different-name");
        await symlink(h.inputDir, input);
        project = "tiny";
      }
      if (kind === "dot" || kind === "dotdot") {
        input += kind === "dot" ? "/." : "/nested/..";
        project = "tiny";
      }
      if (kind === "native alias traversal") {
        await mkdir(join(h.root, "physical", "branch"), { recursive: true });
        await cp(h.inputDir, join(h.root, "physical", "tiny"), { recursive: true });
        await symlink(join(h.root, "physical", "branch"), join(h.root, "alias"));
        input = `${h.root}/alias/../tiny/`;
        await writeFile(join(h.root, "physical", "tiny", "native-marker"), "physical traversal\n");
      }
      const result = await h.call({
        input_dir: input,
        ...(project === undefined ? {} : { project }),
      });
      expect(result, JSON.stringify(result)).toMatchObject({ isError: false });
      const entry = h.registry.indexes.read().active[0];
      if (!entry) throw new Error("Successful submission has no index entry");
      expect(await readRecord(entry.run_dir)).toMatchObject({
        project: "tiny",
        end_days: null,
        label: null,
      });
      for (const [path, original] of Object.entries(h.originals)) {
        expect(await readFile(join(h.inputDir, path))).toEqual(original);
        expect(await readFile(join(entry.run_dir, "input", "tiny", path))).toEqual(original);
      }
      if (kind === "native alias traversal") {
        expect(await readFile(join(entry.run_dir, "input", "tiny", "native-marker"), "utf8")).toBe(
          "physical traversal\n",
        );
      }
    } finally {
      await h.dispose();
    }
  },
);

test.each([".", "nested/.."])(
  'input ending in "%s" requires an explicit project',
  async (suffix) => {
    const h = await createToolHarness();
    try {
      const result = await h.call({ input_dir: `${h.inputDir}/${suffix}` });
      expect(result.isError).toBe(true);
      if (!result.isError) throw new Error("Ambiguous project unexpectedly submitted a run");
      expect(result.error.message).toMatch(/explicit project/iu);
      expect(h.registry.indexes.read()).toEqual({ active: [], completed: [] });
      await expect(readdir(join(h.cwd, "runs"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await h.dispose();
    }
  },
);
