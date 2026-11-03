import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCallId } from "@deepseek-ai/dsh-llm";
import {
  BuildIdSchema,
  BuildRecordSchema,
  ChangeIdSchema,
  TaskCardSchema,
  TaskIdSchema,
} from "@shud-harness/dsh-shud-core";
import { readWorkspaceRecord, rewriteChangeRequest } from "@shud-harness/dsh-shud-records";
import { expect, test, vi } from "vitest";
import { fileSnapshot, git, taskArgs, valueOf } from "./change-create/test-harness.ts";
import { allSourceFiles, invokeTool, seedBuildSource } from "./shud-build/test-harness.ts";
import { expectToolError } from "./task-linked/test-harness.ts";
import { createToolHarness } from "./test-harness.ts";

test("shud_build publishes an executable from the pinned base without changing source or task", async () => {
  const sundialsRoot = fs.mkdtempSync(join(tmpdir(), "shud-build-sundials-"));
  try {
    const h = await createToolHarness({ pumpPollMs: 60_000, sundialsRoot });
    try {
      const invoke = (name: string, arguments_: unknown) =>
        h.runtime.execute({
          callId: "shud-build-base-tracer" as ToolCallId,
          name,
          arguments: arguments_,
          agent: h.agent,
          signal: new AbortController().signal,
        });
      const { source, head } = seedBuildSource(h.cwd);
      const created = valueOf(
        await invoke("task_create", {
          type: "code_change",
          title: "Build the pinned base",
          question_or_goal: "Bind archived source to executable evidence",
        }),
      );
      const taskId = TaskIdSchema.parse(created.task_id);
      const cardPath = join(h.cwd, "tasks", taskId, "task.json");
      const card = TaskCardSchema.parse(JSON.parse(fs.readFileSync(cardPath, "utf8")));
      expect(card).toMatchObject({
        task_id: taskId,
        type: "code_change",
        status: "planned",
        source_base_commit: head,
      });
      const beforeSource = allSourceFiles(source);
      expect(beforeSource.map((file) => file.path)).toEqual(
        expect.arrayContaining([".git/HEAD", ".git/index", "Makefile", ".gitignore", "shud"]),
      );
      const beforeCard = fileSnapshot(cardPath);
      const expectedCompiler = execFileSync("cc", ["--version"], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: process.env.HOME, SUNDIALS_DIR: sundialsRoot },
      }).split(/\r?\n/u)[0];
      const expectedBinary = '#!/bin/sh\nprintf "base-tracer\\n"\n';
      const expectedSha = createHash("sha256").update(expectedBinary).digest("hex");
      const staleSha = createHash("sha256")
        .update(fs.readFileSync(join(source, "shud")))
        .digest("hex");

      try {
        const result = valueOf(await invoke("shud_build", { task_id: taskId }));
        const buildId = BuildIdSchema.parse(result.build_id);
        const directory = join(h.cwd, "builds", buildId);
        expect(fs.readdirSync(join(h.cwd, "builds"))).toEqual([buildId]);
        expect(fs.readdirSync(directory).sort()).toEqual([
          "build-record.json",
          "make.stderr.log",
          "make.stdout.log",
          "shud",
        ]);
        const record = BuildRecordSchema.parse(
          JSON.parse(fs.readFileSync(join(directory, "build-record.json"), "utf8")),
        );
        expect(record).toMatchObject({
          build_id: buildId,
          task_id: taskId,
          change_id: null,
          patch_sha256: null,
          source_path: "repos/SHUD",
          source_commit: head,
          source_branch: "main",
          dirty_paths: [],
          sundials_dir: sundialsRoot,
          rhs_openmp: false,
          compiler: expectedCompiler,
          exit_code: 0,
          binary_path: `builds/${buildId}/shud`,
          binary_sha256: expectedSha,
          stdout_path: `builds/${buildId}/make.stdout.log`,
          stderr_path: `builds/${buildId}/make.stderr.log`,
        });
        expect(record.make_argv).toEqual([
          "make",
          "-C",
          `builds/.tmp-${buildId}/src`,
          "shud",
          `SUNDIALS_DIR=${sundialsRoot}`,
        ]);
        expect(result).toMatchObject({
          build_id: buildId,
          change_id: null,
          patch_sha256: null,
          source_commit: card.source_base_commit,
          rhs_openmp: false,
          binary_sha256: expectedSha,
          duration_seconds: record.duration_seconds,
        });
        const binaryPath = join(directory, "shud");
        expect(fs.lstatSync(binaryPath).isFile()).toBe(true);
        expect(fs.readFileSync(binaryPath, "utf8")).toBe(expectedBinary);
        expect(execFileSync(binaryPath, [], { encoding: "utf8" })).toBe("base-tracer\n");
        expect(createHash("sha256").update(fs.readFileSync(binaryPath)).digest("hex")).toBe(
          record.binary_sha256,
        );
        expect(record.binary_sha256).not.toBe(staleSha);
        const stdout = fs.readFileSync(join(directory, "make.stdout.log"), "utf8");
        expect(stdout).toContain("printf '%s\\n' '#!/bin/sh' 'printf \"base-tracer\\n\"' > shud\n");
        expect(stdout).toContain("chmod 755 shud\n");
        expect(fs.readFileSync(join(directory, "make.stderr.log"), "utf8")).toBe("");
      } finally {
        expect(allSourceFiles(source)).toEqual(beforeSource);
        expect(fileSnapshot(cardPath)).toEqual(beforeCard);
      }
    } finally {
      await h.dispose();
    }
  } finally {
    fs.rmSync(sundialsRoot, { recursive: true, force: true });
  }
});

test("shud_build binds an approved patch and the OpenMP flag to the executed candidate", async () => {
  const sundialsRoot = fs.mkdtempSync(join(tmpdir(), "shud-build-sundials-"));
  try {
    const h = await createToolHarness({ pumpPollMs: 60_000, sundialsRoot });
    try {
      const { source, head } = seedBuildSource(h.cwd, {
        Makefile:
          "CXX := cc\nshud:\n\tprintf '%s\\n' '#!/bin/sh' > shud\n\tcat src/Model/f.cpp >> shud\n\tprintf '%s\\n' 'printf \"rhs-openmp=$(SHUD_ENABLE_OPENMP_RHS)\\n\"' >> shud\n\tchmod 755 shud\n",
        "src/Model/f.cpp": 'printf "base-tracer\\n"\n',
      });
      const created = valueOf(await invokeTool(h, "task_create", taskArgs));
      const taskId = TaskIdSchema.parse(created.task_id);
      const cardPath = join(h.cwd, "tasks", taskId, "task.json");
      fs.writeFileSync(join(source, "src/Model/f.cpp"), 'printf "candidate-tracer\\n"\n');
      const expectedPatch = git(
        source,
        "diff",
        "HEAD",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--",
        "src/Model/f.cpp",
      );
      const expectedPatchSha = createHash("sha256").update(expectedPatch).digest("hex");
      const changed = valueOf(await invokeTool(h, "change_create", { task_id: taskId }));
      const changeId = ChangeIdSchema.parse(changed.change_id);
      const proposed = readWorkspaceRecord(h.cwd, "change", changeId, { readonly: true });
      expect(proposed).toMatchObject({
        task_id: taskId,
        base_commit: head,
        files_changed: ["src/Model/f.cpp"],
        patch_sha256: expectedPatchSha,
        status: "proposed",
        approval_ref: null,
        approved_at: null,
      });
      // Explicit canonical test setup only: this is not an exercised PI approval.
      rewriteChangeRequest(h.cwd, {
        ...proposed,
        status: "approved",
        approval_ref: "explicit-test-fixture-not-PI",
        approved_at: proposed.created_at,
      });
      const approved = readWorkspaceRecord(h.cwd, "change", changeId, { readonly: true });
      expect(approved).toMatchObject({
        status: "approved",
        approval_ref: "explicit-test-fixture-not-PI",
        approved_at: proposed.created_at,
      });
      const patchPath = join(h.cwd, approved.patch_path);
      expect(fs.readFileSync(patchPath)).toEqual(expectedPatch);
      const beforePatch = fileSnapshot(patchPath);
      const changePath = join(h.cwd, "changes", `${changeId}.json`);
      const beforeChange = fileSnapshot(changePath);
      const card = TaskCardSchema.parse(JSON.parse(fs.readFileSync(cardPath, "utf8")));
      expect(card).toMatchObject({
        task_id: taskId,
        source_base_commit: head,
        status: "running",
        linked_changes: [changeId],
      });
      const expectedBinary = '#!/bin/sh\nprintf "candidate-tracer\\n"\nprintf "rhs-openmp=1\\n"\n';
      const expectedSha = createHash("sha256").update(expectedBinary).digest("hex");
      const expectedCompiler = execFileSync("cc", ["--version"], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: process.env.HOME, SUNDIALS_DIR: sundialsRoot },
      }).split(/\r?\n/u)[0];
      const beforeSource = allSourceFiles(source);
      const beforeCard = fileSnapshot(cardPath);
      try {
        const result = valueOf(
          await invokeTool(h, "shud_build", {
            task_id: taskId,
            change_id: changeId,
            rhs_openmp: true,
          }),
        );
        const buildId = BuildIdSchema.parse(result.build_id);
        const directory = join(h.cwd, "builds", buildId);
        expect(fs.readdirSync(join(h.cwd, "builds"))).toEqual([buildId]);
        expect(fs.readdirSync(directory).sort()).toEqual([
          "build-record.json",
          "make.stderr.log",
          "make.stdout.log",
          "shud",
        ]);
        const record = readWorkspaceRecord(h.cwd, "build", buildId, { readonly: true });
        expect(record).toMatchObject({
          build_id: buildId,
          task_id: taskId,
          change_id: changeId,
          patch_sha256: expectedPatchSha,
          source_path: "repos/SHUD",
          source_commit: head,
          source_branch: "main",
          dirty_paths: approved.files_changed,
          sundials_dir: sundialsRoot,
          rhs_openmp: true,
          compiler: expectedCompiler,
          exit_code: 0,
          binary_path: `builds/${buildId}/shud`,
          binary_sha256: expectedSha,
          stdout_path: `builds/${buildId}/make.stdout.log`,
          stderr_path: `builds/${buildId}/make.stderr.log`,
        });
        expect(record.patch_sha256).toBe(approved.patch_sha256);
        expect(record.patch_sha256).toBe(
          createHash("sha256").update(fs.readFileSync(patchPath)).digest("hex"),
        );
        expect(record.make_argv).toEqual([
          "make",
          "-C",
          `builds/.tmp-${buildId}/src`,
          "shud",
          `SUNDIALS_DIR=${sundialsRoot}`,
          "SHUD_ENABLE_OPENMP_RHS=1",
        ]);
        expect(result).toMatchObject({
          build_id: buildId,
          change_id: changeId,
          patch_sha256: expectedPatchSha,
          source_commit: card.source_base_commit,
          rhs_openmp: true,
          binary_sha256: expectedSha,
          duration_seconds: record.duration_seconds,
        });
        const binary = join(directory, "shud");
        expect(fs.lstatSync(binary).isFile()).toBe(true);
        expect(fs.readFileSync(binary, "utf8")).toBe(expectedBinary);
        expect(execFileSync(binary, [], { encoding: "utf8" })).toBe(
          "candidate-tracer\nrhs-openmp=1\n",
        );
        expect(createHash("sha256").update(fs.readFileSync(binary)).digest("hex")).toBe(
          record.binary_sha256,
        );
        const stdout = fs.readFileSync(join(directory, "make.stdout.log"), "utf8");
        expect(stdout).toContain("cat src/Model/f.cpp >> shud\n");
        expect(stdout).toContain("printf '%s\\n' 'printf \"rhs-openmp=1\\n\"' >> shud\n");
        expect(fs.readFileSync(join(directory, "make.stderr.log"), "utf8")).toBe("");
      } finally {
        expect(allSourceFiles(source)).toEqual(beforeSource);
        expect(fileSnapshot(cardPath)).toEqual(beforeCard);
        expect(fileSnapshot(patchPath)).toEqual(beforePatch);
        expect(fileSnapshot(changePath)).toEqual(beforeChange);
      }
    } finally {
      await h.dispose();
    }
  } finally {
    fs.rmSync(sundialsRoot, { recursive: true, force: true });
  }
});

test("make failure keeps its exit code while redacting environment values from diagnostic logs", async () => {
  const sundialsRoot = fs.mkdtempSync(join(tmpdir(), "shud-build-sundials-"));
  vi.stubEnv("SHUD_TEST_ENV_NUMBER", "2");
  vi.stubEnv("SHUD_TEST_ENV_PRIVATE", "PRIVATE_BUILD_DIAGNOSTIC_537");
  try {
    const h = await createToolHarness({ pumpPollMs: 60_000, sundialsRoot });
    try {
      const { source } = seedBuildSource(h.cwd, {
        Makefile:
          "CXX := cc\nshud:\n\tprintf '%s\\n' 'diagnostic secret=PRIVATE_BUILD_DIAGNOSTIC_537 number=2' >&2\n\texit 2\n",
      });
      const created = valueOf(await invokeTool(h, "task_create", taskArgs));
      const taskId = TaskIdSchema.parse(created.task_id);
      const cardPath = join(h.cwd, "tasks", taskId, "task.json");
      const beforeSource = allSourceFiles(source);
      const beforeCard = fileSnapshot(cardPath);
      try {
        const message = expectToolError(
          await invokeTool(h, "shud_build", { task_id: taskId }),
          /make failed \(exit 2\)/u,
        );
        expect(message.split("\n")[0]).toBe("make failed (exit 2)");
        expect(message).toContain("diagnostic secret=[redacted] number=[redacted]");
        expect(message).not.toContain("PRIVATE_BUILD_DIAGNOSTIC_537");
        expect(message).not.toContain("number=2");
        expect(message).not.toContain(".tmp-");
        expect(message).not.toContain(sundialsRoot);
        expect(fs.readdirSync(join(h.cwd, "builds"))).toEqual([]);
      } finally {
        expect(allSourceFiles(source)).toEqual(beforeSource);
        expect(fileSnapshot(cardPath)).toEqual(beforeCard);
      }
    } finally {
      await h.dispose();
    }
  } finally {
    vi.unstubAllEnvs();
    fs.rmSync(sundialsRoot, { recursive: true, force: true });
  }
});
