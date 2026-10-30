import { mkdir, readFile, readdir, readlink, realpath, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { ApprovalService } from "@deepseek-ai/dsh-user-approval";
import * as rawGuard from "@shud-harness/dsh-shud-raw-guard";
import { expect, test, vi } from "vitest";
import { createToolHarness } from "./test-harness.ts";

test.each([
  "output denied",
  "both denied",
  "input rejected",
  "input unavailable",
  "input allowed",
  "ordinary input",
])("registered shud_run respects actual raw guard: %s", async (kind) => {
  const h = await createToolHarness();
  try {
    const asks: Array<Parameters<ApprovalService["request"]>[0]> = [];
    let executions = 0;
    const roots =
      kind === "output denied"
        ? [h.cwd]
        : kind === "both denied"
          ? [h.inputDir, h.cwd]
          : kind === "ordinary input"
            ? [join(h.root, "unrelated-raw")]
            : [h.inputDir];
    await h.apply(rawGuard, { rawDirs: roots });
    await h.ctx.plugin((services: Context) => {
      services.provide("approval", {
        request(request: Parameters<ApprovalService["request"]>[0]) {
          asks.push(request);
          return Promise.resolve(
            kind === "input allowed"
              ? "allowed-once"
              : kind === "input unavailable"
                ? "unavailable"
                : "rejected",
          );
        },
      });
      services.on("tools/execute", (_execution, next) => {
        executions++;
        return next();
      });
    });
    const result = await h.call({ input_dir: h.inputDir });
    const allowed = kind === "input allowed" || kind === "ordinary input";
    expect(result.isError).toBe(!allowed);
    expect(executions).toBe(allowed ? 1 : 0);
    expect(asks).toHaveLength(kind.startsWith("input ") ? 1 : 0);
    if (asks.length > 0) {
      expect(asks[0]).toMatchObject({ toolName: "shud_run", agent: h.agent });
    }
    if (!allowed) {
      if (!result.isError) throw new Error("Raw policy unexpectedly allowed the call");
      expect(result.error.message).toMatch(
        kind === "input rejected"
          ? /user rejected/iu
          : kind === "input unavailable"
            ? /no approval channel/iu
            : /immutable/iu,
      );
      expect(h.registry.list()).toEqual([]);
      expect(h.registry.indexes.read()).toEqual({ active: [], completed: [] });
      await expect(readdir(join(h.cwd, "runs"))).rejects.toMatchObject({ code: "ENOENT" });
    }
    for (const [path, original] of Object.entries(h.originals)) {
      expect(await readFile(join(h.inputDir, path))).toEqual(original);
    }
  } finally {
    await h.dispose();
  }
});

async function snapshotGuardTree(root: string) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (entries === null) return null;
  const items = await Promise.all(
    entries.map(async (entry) => {
      const path = join(entry.parentPath, entry.name);
      const name = relative(root, path);
      if (entry.isSymbolicLink()) return { name, link: await readlink(path) };
      if (entry.isDirectory()) return { name, directory: true };
      if (entry.isFile()) return { name, bytes: await readFile(path) };
      throw new Error("Unexpected protected fixture entry");
    }),
  );
  return items.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
}

async function observeGuardedExecution(ctx: Context) {
  const asks: Array<Parameters<ApprovalService["request"]>[0]> = [];
  let executions = 0;
  await ctx.plugin((services: Context) => {
    services.provide("approval", {
      request(request: Parameters<ApprovalService["request"]>[0]) {
        asks.push(request);
        return Promise.resolve("allowed-once" as const);
      },
    });
    services.on("tools/execute", (_execution, next) => {
      executions++;
      return next();
    });
  });
  return {
    asks,
    get executions() {
      return executions;
    },
  };
}

for (const destination of ["stacks", "provenance"]) {
  for (const kind of [
    "absent",
    "present",
    "session-alias-absent",
    "session-alias-present",
    "output-alias-equal",
    "output-alias-inside",
    "raw-alias",
    "input-alias",
    "case-alias",
  ]) {
    test(`actual guarded shud_run preserves protected ${destination}: ${kind}`, async ({
      skip,
    }) => {
      const h = await createToolHarness();
      const submissions = vi.spyOn(h.registry, "submitShud");
      try {
        const output = join(h.cwd, destination);
        let protectedRoot = output;
        let rawDirs = [destination];
        let input = h.inputDir;
        if (kind === "present" || kind === "session-alias-present") {
          await mkdir(output);
          await writeFile(join(output, "protected-sentinel"), "protected capture bytes\n");
        }
        if (kind.startsWith("session-alias")) {
          const alias = join(h.root, "session-alias");
          await symlink(h.cwd, alias);
          Object.assign(h.agent.session.header, { cwd: alias });
          rawDirs = [join(await realpath(h.cwd), destination)];
        } else if (kind.startsWith("output-alias")) {
          protectedRoot = join(h.root, "protected-output");
          const target =
            kind === "output-alias-equal" ? protectedRoot : join(protectedRoot, "nested-output");
          await mkdir(target, { recursive: true });
          await writeFile(join(protectedRoot, "protected-sentinel"), "protected alias bytes\n");
          await symlink(target, output);
          rawDirs = [protectedRoot];
        } else if (kind === "raw-alias") {
          await mkdir(output);
          const alias = join(h.root, "raw-alias");
          await symlink(output, alias);
          rawDirs = [alias];
        } else if (kind === "input-alias") {
          input = join(h.root, "raw-input-alias");
          await symlink(h.inputDir, input);
          rawDirs = [h.inputDir, output];
        } else if (kind === "case-alias") {
          const spelling = destination[0].toUpperCase() + destination.slice(1);
          protectedRoot = join(h.cwd, spelling);
          await mkdir(protectedRoot);
          const physical = await realpath(output).catch((error: unknown) => {
            if (error instanceof Error && "code" in error && error.code === "ENOENT")
              return undefined;
            throw error;
          });
          if (physical === undefined) {
            skip("filesystem distinguishes the capture root case spellings");
            return;
          }
          expect(physical).toBe(await realpath(protectedRoot));
          rawDirs = [protectedRoot];
        }
        await h.apply(rawGuard, { rawDirs });
        const observed = await observeGuardedExecution(h.ctx);
        const trees = [h.cwd, h.stateDir, h.inputDir, protectedRoot];
        const before = await Promise.all(trees.map(snapshotGuardTree));
        const indexesBefore = h.registry.indexes.read();
        const result = await h.call({ input_dir: input, project: "tiny" });

        expect(result.isError).toBe(true);
        if (!result.isError) throw new Error("Protected capture output unexpectedly accepted");
        expect(result.error.message).toMatch(/immutable/iu);
        expect(observed.executions).toBe(0);
        expect(observed.asks).toEqual([]);
        expect(submissions).not.toHaveBeenCalled();
        expect(h.registry.list()).toEqual([]);
        expect(h.registry.indexes.read()).toEqual(indexesBefore);
        expect(await Promise.all(trees.map(snapshotGuardTree))).toEqual(before);
        await expect(readdir(join(h.cwd, "runs"))).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        submissions.mockRestore();
        await h.dispose();
      }
    });
  }

  test.each([false, true])(
    `actual ${destination} denial precedes input approval and argument validation; reversed=%s`,
    async (reversed) => {
      const h = await createToolHarness();
      const submissions = vi.spyOn(h.registry, "submitShud");
      try {
        const roots = [h.inputDir, join(h.cwd, destination)];
        await h.apply(rawGuard, { rawDirs: reversed ? [...roots].reverse() : roots });
        const observed = await observeGuardedExecution(h.ctx);
        const trees = [h.cwd, h.stateDir, h.inputDir];
        const before = await Promise.all(trees.map(snapshotGuardTree));
        const indexesBefore = h.registry.indexes.read();
        for (const args of [
          { input_dir: h.inputDir, project: "tiny" },
          { project: "tiny" },
          { input_dir: null, project: "tiny" },
          { input_dir: 7, project: "tiny" },
          null,
          [],
        ]) {
          const result = await h.call(args);
          expect(result.isError).toBe(true);
          if (!result.isError) throw new Error("Protected capture output unexpectedly accepted");
          expect(result.error.message).toMatch(/immutable/iu);
          expect(observed.executions).toBe(0);
          expect(observed.asks).toEqual([]);
          expect(submissions).not.toHaveBeenCalled();
          expect(h.registry.list()).toEqual([]);
          expect(h.registry.indexes.read()).toEqual(indexesBefore);
          expect(await Promise.all(trees.map(snapshotGuardTree))).toEqual(before);
        }
      } finally {
        submissions.mockRestore();
        await h.dispose();
      }
    },
  );

  test(`actual guarded submission does not confuse ${destination} with its raw sibling prefix`, async () => {
    const h = await createToolHarness();
    const submissions = vi.spyOn(h.registry, "submitShud");
    try {
      const raw = join(h.cwd, `${destination}-input`);
      await mkdir(raw);
      await writeFile(join(raw, "protected-sentinel"), "unchanged raw sibling\n");
      const before = await snapshotGuardTree(raw);
      const inputBefore = await snapshotGuardTree(h.inputDir);
      await h.apply(rawGuard, { rawDirs: [raw] });
      const observed = await observeGuardedExecution(h.ctx);
      const result = await h.call({ input_dir: h.inputDir, project: "tiny" });
      expect(result.isError).toBe(false);
      expect(observed.executions).toBe(1);
      expect(observed.asks).toEqual([]);
      expect(submissions).toHaveBeenCalledTimes(1);
      expect(h.registry.indexes.read().active).toHaveLength(1);
      expect(await snapshotGuardTree(raw)).toEqual(before);
      expect(await snapshotGuardTree(h.inputDir)).toEqual(inputBefore);
    } finally {
      submissions.mockRestore();
      await h.dispose();
    }
  });
}
