import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { BuildIdSchema, ChangeIdSchema, TaskIdSchema } from "@shud-harness/dsh-shud-core";
import { readWorkspaceRecord, writeWorkspaceRecord } from "@shud-harness/dsh-shud-records";
import { createToolHarness } from "./test-harness.ts";
import { git, taskArgs, valueOf, type ChangeHarness } from "./change-create/test-harness.ts";
import { allSourceFiles, invokeTool, seedBuildSource } from "./shud-build/test-harness.ts";
import { expectToolError, treeOrAbsent } from "./task-linked/test-harness.ts";

const sourceFiles = {
  Makefile:
    "CXX := cc\nshud:\n\tprintf '%s\\n' '#!/bin/sh' 'printf \"PHYSICAL_BUILD_SENTINEL\\n\"' > shud\n\tchmod 755 shud\n",
  "docs/source.txt": "base source evidence\n",
};

async function sourceWorkspace(distinctHeads = false) {
  const sundialsRoot = fs.mkdtempSync(join(tmpdir(), "physical-source-sundials-"));
  try {
    const h = await createToolHarness({ pumpPollMs: 60_000, sundialsRoot });
    try {
      const physical = fs.realpathSync.native(h.cwd);
      const lexical = fs.realpathSync.native(h.root);
      const { source, head } = seedBuildSource(physical, sourceFiles);
      const lexicalSource = join(lexical, "repos", "SHUD");
      if (distinctHeads) {
        seedBuildSource(lexical, {
          ...sourceFiles,
          "docs/source.txt": "LEXICAL_COMMIT_SENTINEL\n",
        });
      } else {
        fs.mkdirSync(join(lexical, "repos"));
        git(lexical, "clone", "--no-hardlinks", "--template=", source, lexicalSource);
      }
      const lexicalHead = git(lexicalSource, "rev-parse", "HEAD").toString("utf8").trim();
      expect(git(source, "rev-parse", "HEAD").toString("utf8").trim()).toBe(head);
      if (distinctHeads) expect(lexicalHead).not.toBe(head);
      else expect(lexicalHead).toBe(head);
      for (const directory of ["tasks", "changes", "patches", "builds"]) {
        fs.mkdirSync(join(lexical, directory));
        fs.writeFileSync(join(lexical, directory, "sentinel"), "LEXICAL_NAMESPACE_SENTINEL\n");
      }
      fs.mkdirSync(join(physical, "child"));
      const alias = join(lexical, "cwd-alias");
      fs.symlinkSync(join(physical, "child"), alias);
      const aliasedCwd = `${alias}/..`;
      expect(fs.realpathSync.native(aliasedCwd)).toBe(physical);
      return {
        ...h,
        physical,
        lexical,
        source,
        lexicalSource,
        head,
        lexicalHead,
        alias,
        aliasedCwd,
        async dispose() {
          try {
            await h.dispose();
          } finally {
            fs.rmSync(sundialsRoot, { recursive: true, force: true });
          }
        },
      };
    } catch (error) {
      await h.dispose();
      throw error;
    }
  } catch (error) {
    fs.rmSync(sundialsRoot, { recursive: true, force: true });
    throw error;
  }
}

async function lexicalSnapshot(root: string, alias: string) {
  return {
    entries: fs.readdirSync(root).sort(),
    namespaces: await Promise.all(
      ["repos", "tasks", "changes", "patches", "builds"].map((name) =>
        treeOrAbsent(join(root, name)),
      ),
    ),
    alias: await treeOrAbsent(alias),
  };
}

async function createPinnedCard(h: Pick<ChangeHarness, "runtime" | "agent">, cwd: string) {
  Object.assign(h.agent.session.header, { cwd });
  const result = valueOf(await invokeTool(h, "task_create", taskArgs));
  const id = TaskIdSchema.parse(result.task_id);
  return readWorkspaceRecord(cwd, "task", id, { readonly: true });
}

test("task_create code_change pins the physical source HEAD through cwd alias parent traversal", async () => {
  const h = await sourceWorkspace(true);
  try {
    const physicalControl = await createPinnedCard(h, h.physical);
    const lexicalControl = await createPinnedCard(h, h.lexical);
    expect(physicalControl.source_base_commit).toBe(h.head);
    expect(lexicalControl.source_base_commit).toBe(h.lexicalHead);
    const before = await lexicalSnapshot(h.lexical, h.alias);
    const sourceBefore = allSourceFiles(h.source);
    Object.assign(h.agent.session.header, { cwd: h.aliasedCwd });

    const result = valueOf(await invokeTool(h, "task_create", taskArgs));
    const id = TaskIdSchema.parse(result.task_id);
    const card = readWorkspaceRecord(h.physical, "task", id, { readonly: true });

    expect(card.source_base_commit).toBe(h.head);
    expect(card.source_base_commit).not.toBe(h.lexicalHead);
    expect(fs.existsSync(join(h.lexical, "tasks", id))).toBe(false);
    expect(allSourceFiles(h.source)).toEqual(sourceBefore);
    expect(await lexicalSnapshot(h.lexical, h.alias)).toEqual(before);
  } finally {
    await h.dispose();
  }
});

test("change_create binds the physical dirty patch to its physical record and task through cwd alias parent traversal", async () => {
  const h = await sourceWorkspace();
  try {
    const card = await createPinnedCard(h, h.physical);
    expect(card.source_base_commit).toBe(h.head);
    writeWorkspaceRecord(h.lexical, "task", card);
    expect(readWorkspaceRecord(h.lexical, "task", card.task_id, { readonly: true })).toEqual(card);
    fs.writeFileSync(join(h.source, "docs/source.txt"), "PHYSICAL_SOURCE_MARKER\n");
    fs.writeFileSync(join(h.lexicalSource, "docs/source.txt"), "LEXICAL_SOURCE_MARKER\n");
    const expectedPatch = git(
      h.source,
      "diff",
      "HEAD",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--",
      "docs/source.txt",
    );
    const lexicalPatch = git(
      h.lexicalSource,
      "diff",
      "HEAD",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--",
      "docs/source.txt",
    );
    expect(expectedPatch.toString("utf8")).toContain("+PHYSICAL_SOURCE_MARKER");
    expect(lexicalPatch.toString("utf8")).toContain("+LEXICAL_SOURCE_MARKER");
    expect(expectedPatch).not.toEqual(lexicalPatch);
    const before = await lexicalSnapshot(h.lexical, h.alias);
    const sourceBefore = allSourceFiles(h.source);
    Object.assign(h.agent.session.header, { cwd: h.aliasedCwd });

    const result = valueOf(
      await invokeTool(h, "change_create", {
        task_id: card.task_id,
        semantic_level: "pure_engineering",
      }),
    );
    const id = ChangeIdSchema.parse(result.change_id);
    const change = readWorkspaceRecord(h.physical, "change", id, { readonly: true });
    const patch = fs.readFileSync(join(h.physical, change.patch_path));

    expect(patch).toEqual(expectedPatch);
    expect(patch.toString("utf8")).not.toContain("LEXICAL_SOURCE_MARKER");
    expect(change).toMatchObject({
      task_id: card.task_id,
      source_path: "repos/SHUD",
      base_commit: h.head,
      files_changed: ["docs/source.txt"],
      patch_sha256: createHash("sha256").update(expectedPatch).digest("hex"),
      status: "proposed",
    });
    expect(readWorkspaceRecord(h.physical, "task", card.task_id, { readonly: true })).toMatchObject(
      {
        source_base_commit: h.head,
        status: "running",
        linked_changes: [id],
      },
    );
    expect(allSourceFiles(h.source)).toEqual(sourceBefore);
    expect(await lexicalSnapshot(h.lexical, h.alias)).toEqual(before);
  } finally {
    await h.dispose();
  }
});

test.each(["physical", "lexical"] as const)(
  "shud_build uses physical source admission and publication when only the %s checkout is dirty",
  async (dirty) => {
    const h = await sourceWorkspace();
    try {
      const card = await createPinnedCard(h, h.physical);
      expect(card.source_base_commit).toBe(h.head);
      writeWorkspaceRecord(h.lexical, "task", card);
      fs.writeFileSync(
        join(dirty === "physical" ? h.source : h.lexicalSource, "docs/source.txt"),
        `${dirty.toUpperCase()}_DIRTY_SOURCE\n`,
      );
      expect(git(h.source, "status", "--porcelain").toString("utf8")).toBe(
        dirty === "physical" ? " M docs/source.txt\n" : "",
      );
      expect(git(h.lexicalSource, "status", "--porcelain").toString("utf8")).toBe(
        dirty === "lexical" ? " M docs/source.txt\n" : "",
      );
      const before = await lexicalSnapshot(h.lexical, h.alias);
      const sourceBefore = allSourceFiles(h.source);
      const cardBefore = await treeOrAbsent(join(h.physical, "tasks", card.task_id));
      Object.assign(h.agent.session.header, { cwd: h.aliasedCwd });

      const result = await invokeTool(h, "shud_build", { task_id: card.task_id });

      if (dirty === "physical") {
        expectToolError(result, /dirty|clean/iu);
        const builds = join(h.physical, "builds");
        expect(fs.existsSync(builds) ? fs.readdirSync(builds) : []).toEqual([]);
      } else {
        const id = BuildIdSchema.parse(valueOf(result).build_id);
        const build = readWorkspaceRecord(h.physical, "build", id, { readonly: true });
        const binary = join(h.physical, build.binary_path);
        const expectedBinary = '#!/bin/sh\nprintf "PHYSICAL_BUILD_SENTINEL\\n"\n';
        expect(build).toMatchObject({
          task_id: card.task_id,
          change_id: null,
          patch_sha256: null,
          source_path: "repos/SHUD",
          source_commit: h.head,
          dirty_paths: [],
          exit_code: 0,
          binary_sha256: createHash("sha256").update(expectedBinary).digest("hex"),
        });
        expect(fs.readFileSync(binary, "utf8")).toBe(expectedBinary);
        expect(execFileSync(binary, [], { encoding: "utf8" })).toBe("PHYSICAL_BUILD_SENTINEL\n");
        expect(fs.readdirSync(join(h.physical, "builds"))).toEqual([id]);
        expect(fs.readdirSync(join(h.physical, "builds", id)).sort()).toEqual([
          "build-record.json",
          "make.stderr.log",
          "make.stdout.log",
          "shud",
        ]);
      }
      expect(allSourceFiles(h.source)).toEqual(sourceBefore);
      expect(await treeOrAbsent(join(h.physical, "tasks", card.task_id))).toEqual(cardBefore);
      expect(await lexicalSnapshot(h.lexical, h.alias)).toEqual(before);
    } finally {
      await h.dispose();
    }
  },
);
