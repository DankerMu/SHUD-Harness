import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FuseRule, ToolContext, ToolLogger, ToolResult } from "@zero-os/shared";
import {
  appendPolicyGateAuditRow,
  RAW_DATA_WRITE_RULE_ID,
  RawDataSandboxedBashTool,
  buildRawDataSeatbeltProfile,
  evaluateRawDataWriteAdvisory,
  rawDataSandboxProfileFileName,
  scanProtectedHardlinks,
  type PolicyGateAuditRow,
  type RawDataDenialPayload
} from "./raw-data-sandbox";

const seatbeltTest =
  process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec") ? test : test.skip;

describe("raw data seatbelt sandbox", () => {
  test("profile builder canonicalizes paths and returns stable profile identity", async () => {
    const fixture = await createFixture();
    try {
      const tempRoot = await realpath("/tmp");
      const profile = await buildRawDataSeatbeltProfile({
        protectedRawPaths: [join(fixture.root, "data", "..", "data", "raw")],
        allowedWriteRoots: [fixture.root],
        tempRoot: "/tmp",
        profileRoot: fixture.profileRoot
      });
      const sameProfile = await buildRawDataSeatbeltProfile({
        protectedRawPaths: [fixture.rawRoot],
        allowedWriteRoots: [fixture.root],
        tempRoot: "/tmp",
        profileRoot: fixture.profileRoot
      });

      expect(profile.profileId).toMatch(/^shud-raw-seatbelt-[a-f0-9]{16}$/);
      expect(profile.profileId).toBe(sameProfile.profileId);
      expect(profile.metadata.profileId).toBe(profile.profileId);
      expect(profile.metadata.protectedRawPaths).toEqual([await realpath(fixture.rawRoot)]);
      expect(profile.metadata.tempRoot).toBe(tempRoot);
      expect(profile.profileText).toContain("(deny default)");
      expect(profile.profileText).toContain("(allow file-read*)");
      expect(profile.profileText).toContain(`(allow file-write* (subpath "${await realpath(fixture.root)}"))`);
      expect(profile.profileText).toContain(`(deny file-write* (subpath "${await realpath(fixture.rawRoot)}"))`);
      expect(profile.profileText).not.toContain('(subpath "/tmp")');
    } finally {
      await fixture.cleanup();
    }
  });

  const negativeCases: readonly NegativeCase[] = [
    {
      name: "interpreter payload",
      target: "interpreter.txt",
      command: () =>
        "awk 'BEGIN { print \"interpreter\" > \"data/raw/interpreter.txt\" }'"
    },
    {
      name: "pipeline/stdin data flow",
      target: "pipeline.txt",
      command: () => "printf pipeline | tee data/raw/pipeline.txt >/dev/null"
    },
    {
      name: "dynamic write target",
      target: "dynamic.txt",
      command: () => 'd=data; r=raw; p="$d/$r/dynamic.txt"; printf dynamic > "$p"'
    },
    {
      name: "shell dynamic state with child and grandchild",
      target: "grandchild.txt",
      command: () =>
        "mkdir -p nested; (cd nested && sh -c 'sh -c \"printf grandchild > ../data/raw/grandchild.txt\"')"
    },
    {
      name: "symlink and ../ alias",
      target: "symlink-alias.txt",
      setup: async (fixture) => {
        await symlink(join(fixture.rawRoot, "symlink-alias.txt"), join(fixture.workspaceRoot, "symlink-to-raw.txt"));
      },
      command: () =>
        "printf symlink > workspace/symlink-to-raw.txt; printf dotdot > workspace/../data/raw/dotdot.txt",
      assertRaw: async (fixture) => {
        await expectMissing(join(fixture.rawRoot, "symlink-alias.txt"));
        await expectMissing(join(fixture.rawRoot, "dotdot.txt"));
      }
    },
    {
      name: "rename/unlink",
      target: "renamed.txt",
      setup: async (fixture) => {
        await writeFile(join(fixture.workspaceRoot, "source.txt"), "source", "utf8");
        await writeFile(join(fixture.rawRoot, "existing.txt"), "KEEP", "utf8");
      },
      command: () => "mv workspace/source.txt data/raw/renamed.txt; rm data/raw/existing.txt",
      assertRaw: async (fixture) => {
        await expectMissing(join(fixture.rawRoot, "renamed.txt"));
        expect(await readFile(join(fixture.rawRoot, "existing.txt"), "utf8")).toBe("KEEP");
      }
    }
  ];

  for (const negativeCase of negativeCases) {
    seatbeltTest(`${negativeCase.name} is denied by sandbox without mutating data/raw`, async () => {
      const fixture = await createFixture();
      try {
        await negativeCase.setup?.(fixture);
        const result = await runSandboxed(fixture, negativeCase.command(fixture), {
          enableAdvisory: false
        });

        const payload = expectDeniedPayload(result, "denied_by_sandbox");
        if (negativeCase.assertRaw) {
          await negativeCase.assertRaw(fixture);
        } else {
          await expectMissing(join(fixture.rawRoot, negativeCase.target));
        }
        const rows = await readAuditRows(fixture.root);
        expect(rows.at(-1)).toMatchObject({
          event: "tool.failed",
          tool_id: "bash",
          rule: RAW_DATA_WRITE_RULE_ID,
          decision: "denied_by_sandbox"
        });
        expect(rows.at(-1)?.profile_id).toMatch(/^shud-raw-seatbelt-/);
        expectAuditMatchesPayload(rows.at(-1), payload);
      } finally {
        await fixture.cleanup();
      }
    });
  }

  seatbeltTest("interpreter file API raw write denial maps to raw-data payload", async () => {
    const fixture = await createFixture();
    try {
      const result = await runSandboxed(
        fixture,
        'node -e \'require("fs").writeFileSync("data/raw/node-write.txt", "node")\'',
        { enableAdvisory: false }
      );

      const payload = expectDeniedPayload(result, "denied_by_sandbox");
      await expectMissing(join(fixture.rawRoot, "node-write.txt"));
      const rows = await readAuditRows(fixture.root);
      expectAuditMatchesPayload(rows.at(-1), payload);
    } finally {
      await fixture.cleanup();
    }
  });

  seatbeltTest("stderr-suppressed interpreter raw write is pre-denied", async () => {
    const fixture = await createFixture();
    try {
      const result = await runSandboxed(
        fixture,
        'node -e \'require("fs").writeFileSync("data/raw/node-suppressed.txt", "node")\' 2>/dev/null || true',
        { enableAdvisory: false }
      );

      const payload = expectDeniedPayload(result, "denied_by_sandbox");
      expect(payload.reason).toContain("hide sandbox denial");
      await expectMissing(join(fixture.rawRoot, "node-suppressed.txt"));
      const rows = await readAuditRows(fixture.root);
      expectAuditMatchesPayload(rows.at(-1), payload);
    } finally {
      await fixture.cleanup();
    }
  });

  seatbeltTest("semicolon-normalized interpreter raw write is pre-denied", async () => {
    const fixture = await createFixture();
    try {
      const beforeRawEntries = await sortedRawEntries(fixture.rawRoot);
      const result = await runSandboxed(
        fixture,
        'node -e \'require("fs").writeFileSync("data/raw/semicolon-true.txt", "x")\' 2>/dev/null; true',
        { enableAdvisory: false }
      );

      const payload = expectDeniedPayload(result, "denied_by_sandbox");
      expect(payload.reason).toContain("hide sandbox denial");
      expect(await sortedRawEntries(fixture.rawRoot)).toEqual(beforeRawEntries);
      const rows = await readAuditRows(fixture.root);
      expect(rows.at(-1)).toMatchObject({
        event: "tool.failed",
        decision: "denied_by_sandbox"
      });
      expectAuditMatchesPayload(rows.at(-1), payload);
    } finally {
      await fixture.cleanup();
    }
  });

  seatbeltTest("visible stderr masked by true is still normalized to sandbox denial", async () => {
    const fixture = await createFixture();
    try {
      const result = await runSandboxed(
        fixture,
        'd=data; r=raw; p="$d/$r/dynamic-visible.txt"; printf dynamic > "$p" || true',
        { enableAdvisory: false }
      );

      const payload = expectDeniedPayload(result, "denied_by_sandbox");
      await expectMissing(join(fixture.rawRoot, "dynamic-visible.txt"));
      const rows = await readAuditRows(fixture.root);
      expectAuditMatchesPayload(rows.at(-1), payload);
    } finally {
      await fixture.cleanup();
    }
  });

  seatbeltTest("child shell masked denial is still normalized to sandbox denial", async () => {
    const fixture = await createFixture();
    try {
      const result = await runSandboxed(
        fixture,
        "bash -c 'printf child > data/raw/child-mask.txt || true'",
        { enableAdvisory: false }
      );

      const payload = expectDeniedPayload(result, "denied_by_sandbox");
      await expectMissing(join(fixture.rawRoot, "child-mask.txt"));
      const rows = await readAuditRows(fixture.root);
      expectAuditMatchesPayload(rows.at(-1), payload);
    } finally {
      await fixture.cleanup();
    }
  });

  seatbeltTest("raw read succeeds under the same profile and is not advisory-denied", async () => {
    const fixture = await createFixture();
    try {
      expect(evaluateRawDataWriteAdvisory("cat data/raw/input.csv", [fixture.rawRoot])).toEqual({
        decision: "allow"
      });

      const result = await runSandboxed(fixture, "cat data/raw/input.csv");

      expect(result.success).toBe(true);
      expect(result.output).toContain("raw,input");
      const rows = await readAuditRows(fixture.root);
      expect(rows.at(-1)).toMatchObject({
        event: "tool.completed",
        decision: "allowed"
      });
    } finally {
      await fixture.cleanup();
    }
  });

  seatbeltTest("successful raw read output containing sandbox denial text stays allowed", async () => {
    const fixture = await createFixture();
    try {
      await writeFile(join(fixture.rawRoot, "says-sandbox.txt"), "sandbox\n", "utf8");
      await writeFile(
        join(fixture.rawRoot, "says-permission-denied.txt"),
        "Permission denied\n",
        "utf8"
      );

      const sandboxText = await runSandboxed(fixture, "cat data/raw/says-sandbox.txt");
      const permissionText = await runSandboxed(
        fixture,
        "cat data/raw/says-permission-denied.txt"
      );

      expect(sandboxText.success).toBe(true);
      expect(sandboxText.output).toContain("sandbox");
      expect(permissionText.success).toBe(true);
      expect(permissionText.output).toContain("Permission denied");
      const rows = await readAuditRows(fixture.root);
      expect(rows.at(-1)).toMatchObject({
        event: "tool.completed",
        decision: "allowed"
      });
    } finally {
      await fixture.cleanup();
    }
  });

  seatbeltTest("workspace allowed write succeeds under the same profile", async () => {
    const fixture = await createFixture();
    try {
      const result = await runSandboxed(fixture, "printf allowed > workspace/out.txt");

      expect(result.success).toBe(true);
      expect(await readFile(join(fixture.workspaceRoot, "out.txt"), "utf8")).toBe("allowed");
      const rows = await readAuditRows(fixture.root);
      expect(rows.at(-1)).toMatchObject({
        event: "tool.completed",
        decision: "allowed"
      });
    } finally {
      await fixture.cleanup();
    }
  });

  seatbeltTest("raw source copy to workspace succeeds and raw destination copy is denied", async () => {
    const fixture = await createFixture();
    try {
      expect(evaluateRawDataWriteAdvisory("cp data/raw/input.csv workspace/input.csv", [
        fixture.rawRoot
      ])).toEqual({ decision: "allow" });

      const readCopy = await runSandboxed(fixture, "cp data/raw/input.csv workspace/input.csv");
      expect(readCopy.success).toBe(true);
      expect(await readFile(join(fixture.workspaceRoot, "input.csv"), "utf8")).toBe("raw,input\n");

      await writeFile(join(fixture.workspaceRoot, "source.csv"), "derived\n", "utf8");
      const rawDestination = evaluateRawDataWriteAdvisory(
        "cp workspace/source.csv data/raw/copied.csv",
        [fixture.rawRoot]
      );
      expect(rawDestination.decision).toBe("deny");

      const denied = await runSandboxed(fixture, "cp workspace/source.csv data/raw/copied.csv");
      const payload = expectDeniedPayload(denied, "denied_by_advisory");
      await expectMissing(join(fixture.rawRoot, "copied.csv"));
      const rows = await readAuditRows(fixture.root);
      expectAuditMatchesPayload(rows.at(-1), payload);
    } finally {
      await fixture.cleanup();
    }
  });

  seatbeltTest("advisory can deny obvious static writes but fails open for uncertainty", async () => {
    const fixture = await createFixture();
    try {
      const obvious = evaluateRawDataWriteAdvisory("printf nope > data/raw/obvious.txt", [
        fixture.rawRoot
      ]);
      const uncertain = evaluateRawDataWriteAdvisory(
        'd=data; r=raw; p="$d/$r/uncertain.txt"; printf maybe > "$p"',
        [fixture.rawRoot]
      );
      const ddWrite = evaluateRawDataWriteAdvisory(
        "dd if=/dev/zero of=data/raw/dd.bin bs=1 count=1",
        [fixture.rawRoot]
      );
      const mkdirWrite = evaluateRawDataWriteAdvisory("mkdir data/raw/new-dir", [
        fixture.rawRoot
      ]);
      const chmodWrite = evaluateRawDataWriteAdvisory("chmod 600 data/raw/input.csv", [
        fixture.rawRoot
      ]);

      expect(obvious.decision).toBe("deny");
      expect(ddWrite.decision).toBe("deny");
      expect(mkdirWrite.decision).toBe("deny");
      expect(chmodWrite.decision).toBe("deny");
      if (obvious.decision === "deny") {
        expect(obvious.remediation.next_action).toBe("adjust_scope");
        expect(obvious.remediation.hint).toContain("outside data/raw");
      }
      expect(uncertain).toEqual({ decision: "allow" });

      const result = await runSandboxed(fixture, "printf nope > data/raw/obvious.txt");
      const payload = expectDeniedPayload(result, "denied_by_advisory");
      await expectMissing(join(fixture.rawRoot, "obvious.txt"));
      const rows = await readAuditRows(fixture.root);
      expect(rows.at(-1)).toMatchObject({
        event: "tool.failed",
        decision: "denied_by_advisory"
      });
      expectAuditMatchesPayload(rows.at(-1), payload);
    } finally {
      await fixture.cleanup();
    }
  });

  seatbeltTest("advisory preserves root raw denial but fails open after cwd changes", async () => {
    const fixture = await createFixture();
    try {
      const rootRawWrite = evaluateRawDataWriteAdvisory("printf nope > data/raw/root.txt", [
        fixture.rawRoot
      ]);
      const workspaceRawWrite = evaluateRawDataWriteAdvisory(
        "mkdir -p workspace/data/raw; cd workspace && printf ok > data/raw/out.txt",
        [fixture.rawRoot]
      );

      expect(rootRawWrite.decision).toBe("deny");
      expect(workspaceRawWrite).toEqual({ decision: "allow" });

      const allowed = await runSandboxed(
        fixture,
        "mkdir -p workspace/data/raw; cd workspace && printf ok > data/raw/out.txt"
      );
      expect(allowed.success).toBe(true);
      expect(await readFile(join(fixture.workspaceRoot, "data", "raw", "out.txt"), "utf8")).toBe(
        "ok"
      );

      const denied = await runSandboxed(fixture, "printf nope > data/raw/root.txt");
      expectDeniedPayload(denied, "denied_by_advisory");
      await expectMissing(join(fixture.rawRoot, "root.txt"));
    } finally {
      await fixture.cleanup();
    }
  });

  test("requires either an explicit inner tool or fuse rules", async () => {
    const fixture = await createFixture();
    try {
      expect(
        () =>
          new RawDataSandboxedBashTool({
            protectedRawPaths: [fixture.rawRoot],
            allowedWriteRoots: [fixture.root],
            tempRoot: fixture.tempRoot,
            profileRoot: fixture.profileRoot
          } as never)
      ).toThrow("requires either innerTool or fuseRules");
    } finally {
      await fixture.cleanup();
    }
  });

  test("preserves Zero fuse denial when constructing the inner BashTool", async () => {
    const fixture = await createFixture();
    try {
      const result = await runSandboxed(fixture, "printf blocked-by-fuse", {
        fuseRules: [{ pattern: "blocked-by-fuse", description: "sentinel fuse" }]
      });

      expect(result.success).toBe(false);
      expect(result.output).toContain("Command blocked by fuse list");
      expect(result.output).toContain("sentinel fuse");
    } finally {
      await fixture.cleanup();
    }
  });

  test("preserves denial payload when audit append fails", async () => {
    const fixture = await createFixture();
    try {
      const tool = new RawDataSandboxedBashTool({
        protectedRawPaths: [fixture.rawRoot],
        allowedWriteRoots: [fixture.root],
        tempRoot: fixture.tempRoot,
        profileRoot: fixture.profileRoot,
        auditTaskId: "..",
        fuseRules: []
      });

      const result = await tool.run(fixture.context, {
        command: "printf nope > data/raw/audit-fail.txt",
        timeout: 30_000
      });

      const payload = expectDeniedPayload(result, "denied_by_advisory");
      expect(payload.reason).toContain("raw-data write target");
      await expectMissing(join(fixture.rawRoot, "audit-fail.txt"));
    } finally {
      await fixture.cleanup();
    }
  });

  seatbeltTest("stable profile path symlink does not poison raw bytes across two calls", async () => {
    const fixture = await createFixture();
    try {
      const profile = await buildRawDataSeatbeltProfile({
        protectedRawPaths: [fixture.rawRoot],
        allowedWriteRoots: [fixture.root],
        tempRoot: fixture.tempRoot,
        profileRoot: fixture.profileRoot
      });
      const rawPoisonTarget = join(fixture.rawRoot, "profile-poison.txt");
      await writeFile(rawPoisonTarget, "ORIGINAL", "utf8");
      await symlink(rawPoisonTarget, join(fixture.profileRoot, rawDataSandboxProfileFileName(profile)));

      const first = await runSandboxed(fixture, "cat data/raw/input.csv");
      const second = await runSandboxed(fixture, "printf ok > workspace/profile-ok.txt");

      expect(first.success).toBe(true);
      expect(second.success).toBe(true);
      expect(await readFile(rawPoisonTarget, "utf8")).toBe("ORIGINAL");
      expect(await readFile(join(fixture.workspaceRoot, "profile-ok.txt"), "utf8")).toBe("ok");
    } finally {
      await fixture.cleanup();
    }
  });

  test("profileRoot symlink into protected raw is rejected before profile artifacts", async () => {
    const fixture = await createFixture();
    try {
      const beforeRawEntries = await sortedRawEntries(fixture.rawRoot);
      await rm(fixture.profileRoot, { recursive: true, force: true });
      await symlink(fixture.rawRoot, fixture.profileRoot);

      const result = await runSandboxed(fixture, "cat data/raw/input.csv");

      expect(result.success).toBe(false);
      expect(result.output).toContain("protected raw data path");
      expect(await sortedRawEntries(fixture.rawRoot)).toEqual(beforeRawEntries);
    } finally {
      await fixture.cleanup();
    }
  });

  test("profileRoot symlink ancestor into protected raw is rejected before missing leaf creation", async () => {
    const fixture = await createFixture();
    try {
      const beforeRawEntries = await sortedRawEntries(fixture.rawRoot);
      const symlinkAncestor = join(fixture.workspaceRoot, "profile-parent");
      await symlink(fixture.rawRoot, symlinkAncestor);

      const result = await runSandboxed(fixture, "cat data/raw/input.csv", {
        profileRoot: join(symlinkAncestor, "profiles")
      });

      expect(result.success).toBe(false);
      expect(result.output).toContain("protected raw data path");
      expect(await sortedRawEntries(fixture.rawRoot)).toEqual(beforeRawEntries);
    } finally {
      await fixture.cleanup();
    }
  });

  test("tempRoot symlink into protected raw is rejected before profile artifacts", async () => {
    const fixture = await createFixture();
    try {
      const beforeRawEntries = await sortedRawEntries(fixture.rawRoot);
      await rm(fixture.tempRoot, { recursive: true, force: true });
      await symlink(fixture.rawRoot, fixture.tempRoot);

      const result = await runSandboxed(fixture, "cat data/raw/input.csv");

      expect(result.success).toBe(false);
      expect(result.output).toContain("protected raw data path");
      expect(await sortedRawEntries(fixture.rawRoot)).toEqual(beforeRawEntries);
    } finally {
      await fixture.cleanup();
    }
  });

  const suppressedCases: readonly NegativeCase[] = [
    {
      name: "suppressed group raw write",
      target: "suppressed-group.txt",
      command: () => "{ printf group > data/raw/suppressed-group.txt; } 2>/dev/null || true"
    },
    {
      name: "suppressed subshell raw write",
      target: "suppressed-subshell.txt",
      command: () => "(printf subshell > data/raw/suppressed-subshell.txt) 2>/dev/null || true"
    },
    {
      name: "suppressed child bash raw write",
      target: "suppressed-child.txt",
      command: () =>
        "bash -c 'printf child > data/raw/suppressed-child.txt' 2>/dev/null || true"
    },
    {
      name: "suppressed variable raw write",
      target: "suppressed-variable.txt",
      command: () =>
        'p=data/raw/suppressed-variable.txt; { printf variable > "$p"; } 2>/dev/null || true'
    },
    {
      name: "suppressed dynamic variable raw write",
      target: "swallowed-dynamic.txt",
      command: () =>
        'd=data; r=raw; p="$d/$r/swallowed-dynamic.txt"; { printf swallowed > "$p"; } 2>/dev/null || true'
    }
  ];

  for (const suppressedCase of suppressedCases) {
    seatbeltTest(`${suppressedCase.name} is pre-denied instead of being swallowed`, async () => {
      const fixture = await createFixture();
      try {
        const result = await runSandboxed(fixture, suppressedCase.command(fixture), {
          enableAdvisory: false
        });

        const payload = expectDeniedPayload(result, "denied_by_sandbox");
        expect(payload.reason).toContain("hide sandbox denial");
        await expectMissing(join(fixture.rawRoot, suppressedCase.target));
        const rows = await readAuditRows(fixture.root);
        expect(rows.at(-1)).toMatchObject({
          event: "tool.failed",
          decision: "denied_by_sandbox"
        });
        expectAuditMatchesPayload(rows.at(-1), payload);
      } finally {
        await fixture.cleanup();
      }
    });
  }

  seatbeltTest("suppressed raw read is not treated as a hidden sandbox denial", async () => {
    const fixture = await createFixture();
    try {
      const orTrueResult = await runSandboxed(
        fixture,
        "{ cat data/raw/input.csv; } 2>/dev/null || true",
        { enableAdvisory: false }
      );
      const semicolonTrueResult = await runSandboxed(
        fixture,
        "{ cat data/raw/input.csv; } 2>/dev/null; true",
        { enableAdvisory: false }
      );

      expect(orTrueResult.success).toBe(true);
      expect(orTrueResult.output).toContain("raw,input");
      expect(semicolonTrueResult.success).toBe(true);
      expect(semicolonTrueResult.output).toContain("raw,input");
      const rows = await readAuditRows(fixture.root);
      expect(rows.at(-1)).toMatchObject({
        event: "tool.completed",
        decision: "allowed"
      });
    } finally {
      await fixture.cleanup();
    }
  });

  test("audit root inside protected raw is rejected without raw audit mutation", async () => {
    const fixture = await createFixture();
    try {
      const beforeRawEntries = await sortedRawEntries(fixture.rawRoot);
      const result = await runSandboxed(fixture, "printf nope > data/raw/audit-root.txt", {
        auditWorkspaceRoot: fixture.rawRoot
      });

      expectDeniedPayload(result, "denied_by_advisory");
      expect(await sortedRawEntries(fixture.rawRoot)).toEqual(beforeRawEntries);
    } finally {
      await fixture.cleanup();
    }
  });

  test("default audit root from raw workDir is rejected without raw audit mutation", async () => {
    const fixture = await createFixture();
    try {
      const beforeRawEntries = await sortedRawEntries(fixture.rawRoot);
      const result = await runSandboxed(
        fixture,
        `printf nope > ${join(fixture.rawRoot, "ctx-audit-root.txt")}`,
        {
          context: {
            ...fixture.context,
            workDir: fixture.rawRoot
          }
        }
      );

      expectDeniedPayload(result, "denied_by_advisory");
      expect(await sortedRawEntries(fixture.rawRoot)).toEqual(beforeRawEntries);
    } finally {
      await fixture.cleanup();
    }
  });

  test("symlinked audit root into protected raw is rejected without raw audit mutation", async () => {
    const fixture = await createFixture();
    try {
      const beforeRawEntries = await sortedRawEntries(fixture.rawRoot);
      const auditRootLink = join(fixture.workspaceRoot, "audit-root-link");
      await symlink(fixture.rawRoot, auditRootLink);

      const result = await runSandboxed(fixture, "printf nope > data/raw/audit-link.txt", {
        auditWorkspaceRoot: auditRootLink
      });

      expectDeniedPayload(result, "denied_by_advisory");
      expect(await sortedRawEntries(fixture.rawRoot)).toEqual(beforeRawEntries);
    } finally {
      await fixture.cleanup();
    }
  });

  seatbeltTest("sandbox command cannot sabotage policy-gate audit subtree before denial append", async () => {
    const fixture = await createFixture();
    try {
      const result = await runSandboxed(
        fixture,
        "printf forged > workspace/tasks/TASK-M1-SPIKE/audit/policy-gate.ndjson; printf nope > data/raw/audit-sabotage.txt",
        { enableAdvisory: false }
      );

      const payload = expectDeniedPayload(result, "denied_by_sandbox");
      await expectMissing(join(fixture.rawRoot, "audit-sabotage.txt"));
      const auditContent = await readFile(
        join(fixture.root, "workspace", "tasks", "TASK-M1-SPIKE", "audit", "policy-gate.ndjson"),
        "utf8"
      );
      expect(auditContent).not.toContain("forged");
      const rows = await readAuditRows(fixture.root);
      expectAuditMatchesPayload(rows.at(-1), payload);
    } finally {
      await fixture.cleanup();
    }
  });

  seatbeltTest("pre-existing hardlink residual is demonstrated and bounded nlink scan detects it", async () => {
    const fixture = await createFixture();
    try {
      const rawSource = join(fixture.rawRoot, "hardlink-source.txt");
      const aliasDir = join(fixture.workspaceRoot, "aliases");
      const aliasPath = join(aliasDir, "raw-alias.txt");
      await mkdir(aliasDir, { recursive: true });
      await writeFile(rawSource, "ORIGINAL", "utf8");
      await link(rawSource, aliasPath);

      const result = await runSandboxed(fixture, "printf MUTATED > workspace/aliases/raw-alias.txt", {
        enableAdvisory: false
      });

      expect(result.success).toBe(true);
      expect(await readFile(rawSource, "utf8")).toBe("MUTATED");

      const scan = await scanProtectedHardlinks({ protectedRoots: [fixture.rawRoot] });
      expect(scan.protectedRoots).toEqual([await realpath(fixture.rawRoot)]);
      expect(scan.riskyPaths).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: await realpath(rawSource),
            nlink: 2
          })
        ])
      );
      for (const risk of scan.riskyPaths) {
        expect(risk.path.startsWith(await realpath(fixture.rawRoot))).toBe(true);
      }
    } finally {
      await fixture.cleanup();
    }
  });

  test("audit path segments and hardlink scan budget are bounded", async () => {
    const fixture = await createFixture();
    try {
      await expect(
        appendPolicyGateAuditRow({
          workspaceRoot: fixture.root,
          taskId: "..",
          row: minimalAuditRow()
        })
      ).rejects.toThrow("Invalid audit task id");
      await expect(
        appendPolicyGateAuditRow({
          workspaceRoot: fixture.root,
          fileName: "../policy-gate.ndjson",
          row: minimalAuditRow()
        })
      ).rejects.toThrow("Invalid audit file name");
      await expect(
        scanProtectedHardlinks({ protectedRoots: [fixture.rawRoot], maxScannedPathCount: 1 })
      ).rejects.toThrow("exceeded budget");
      for (let index = 0; index < 25; index += 1) {
        await writeFile(join(fixture.rawRoot, `wide-${index}.txt`), "wide", "utf8");
      }
      await expect(
        scanProtectedHardlinks({ protectedRoots: [fixture.rawRoot], maxScannedPathCount: 2 })
      ).rejects.toThrow("exceeded budget");
    } finally {
      await fixture.cleanup();
    }
  });

  test("audit append rejects symlink audit dir and file targets without mutating raw", async () => {
    const dirFixture = await createFixture();
    try {
      const rawInput = join(dirFixture.rawRoot, "input.csv");
      const before = await readFile(rawInput, "utf8");
      const auditParent = join(
        dirFixture.root,
        "workspace",
        "tasks",
        "TASK-M1-SPIKE"
      );
      await mkdir(auditParent, { recursive: true });
      await symlink(dirFixture.rawRoot, join(auditParent, "audit"));

      await expect(
        appendPolicyGateAuditRow({
          workspaceRoot: dirFixture.root,
          fileName: "input.csv",
          row: minimalAuditRow()
        })
      ).rejects.toThrow("symlink");
      expect(await readFile(rawInput, "utf8")).toBe(before);
    } finally {
      await dirFixture.cleanup();
    }

    const fileFixture = await createFixture();
    try {
      const rawInput = join(fileFixture.rawRoot, "input.csv");
      const before = await readFile(rawInput, "utf8");
      const auditDir = await createAuditDir(fileFixture.root);
      await symlink(rawInput, join(auditDir, "policy-gate.ndjson"));

      await expect(
        appendPolicyGateAuditRow({
          workspaceRoot: fileFixture.root,
          row: minimalAuditRow()
        })
      ).rejects.toThrow("symlink");
      expect(await readFile(rawInput, "utf8")).toBe(before);
    } finally {
      await fileFixture.cleanup();
    }
  });

  test("audit append rejects hardlink audit file target without mutating raw", async () => {
    const fixture = await createFixture();
    try {
      const rawInput = join(fixture.rawRoot, "input.csv");
      const before = await readFile(rawInput, "utf8");
      const auditDir = await createAuditDir(fixture.root);
      await link(rawInput, join(auditDir, "policy-gate.ndjson"));

      await expect(
        appendPolicyGateAuditRow({
          workspaceRoot: fixture.root,
          row: minimalAuditRow()
        })
      ).rejects.toThrow("hardlink");
      expect(await readFile(rawInput, "utf8")).toBe(before);
    } finally {
      await fixture.cleanup();
    }
  });
});

interface NegativeCase {
  name: string;
  target: string;
  setup?: (fixture: Fixture) => Promise<void>;
  command: (fixture: Fixture) => string;
  assertRaw?: (fixture: Fixture) => Promise<void>;
}

interface Fixture {
  root: string;
  rawRoot: string;
  workspaceRoot: string;
  profileRoot: string;
  tempRoot: string;
  context: ToolContext;
  cleanup(): Promise<void>;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "shud-raw-sandbox-"));
  const rawRoot = join(root, "data", "raw");
  const workspaceRoot = join(root, "workspace");
  const profileRoot = join(workspaceRoot, "profiles");
  const tempRoot = join(workspaceRoot, "tmp");
  await mkdir(rawRoot, { recursive: true });
  await mkdir(profileRoot, { recursive: true });
  await mkdir(tempRoot, { recursive: true });
  await writeFile(join(rawRoot, "input.csv"), "raw,input\n", "utf8");

  return {
    root,
    rawRoot,
    workspaceRoot,
    profileRoot,
    tempRoot,
    context: {
      sessionId: "TEST-SESSION",
      currentToolUseId: "TOOL-CALL-1",
      workDir: root,
      logger: testLogger
    },
    cleanup: () => rm(root, { recursive: true, force: true })
  };
}

async function runSandboxed(
  fixture: Fixture,
  command: string,
  options: {
    enableAdvisory?: boolean;
    fuseRules?: readonly FuseRule[];
    auditWorkspaceRoot?: string;
    profileRoot?: string;
    context?: ToolContext;
  } = {}
): Promise<ToolResult> {
  const tool = new RawDataSandboxedBashTool({
    protectedRawPaths: [fixture.rawRoot],
    allowedWriteRoots: [fixture.root],
    tempRoot: fixture.tempRoot,
    profileRoot: options.profileRoot ?? fixture.profileRoot,
    enableAdvisory: options.enableAdvisory,
    auditWorkspaceRoot: options.auditWorkspaceRoot,
    fuseRules: options.fuseRules ?? []
  });

  return tool.run(options.context ?? fixture.context, {
    command,
    timeout: 30_000
  });
}

function expectDeniedPayload(
  result: ToolResult,
  decision: "denied_by_advisory" | "denied_by_sandbox"
): RawDataDenialPayload {
  expect(result.success).toBe(false);
  const payload = JSON.parse(result.output) as RawDataDenialPayload;
  expect(payload.error).toBe("raw_data_write_denied");
  expect(payload.rule).toBe(RAW_DATA_WRITE_RULE_ID);
  expect(payload.decision).toBe(decision);
  expect(payload.guard_class).toBe("authority");
  expect(payload.profile_id).toMatch(/^shud-raw-seatbelt-/);
  expect(payload.invocation_id).toBe("TOOL-CALL-1");
  expect(payload.remediation.next_action).toBe("adjust_scope");
  expect(payload.remediation.hint).toContain("data/raw");
  expect(payload.remediation.ref).toContain("policy-gate-spike");
  expect(payload.error_record.remediation?.next_action).toBe("adjust_scope");
  return payload;
}

function expectAuditMatchesPayload(
  row: PolicyGateAuditRow | undefined,
  payload: RawDataDenialPayload
): void {
  expect(row).toMatchObject({
    event: "tool.failed",
    tool_id: payload.tool_id,
    rule: payload.rule,
    decision: payload.decision,
    guard_class: payload.guard_class,
    profile_id: payload.profile_id,
    error_id: payload.error_record.error_id,
    invocation_id: payload.invocation_id,
    remediation_next_action: payload.remediation.next_action,
    remediation_ref: payload.remediation.ref
  });
}

function minimalAuditRow(): PolicyGateAuditRow {
  return {
    event: "tool.failed",
    tool_id: "bash",
    rule: RAW_DATA_WRITE_RULE_ID,
    decision: "denied_by_advisory",
    ts: "2026-07-04T00:00:00.000Z"
  };
}

async function expectMissing(path: string): Promise<void> {
  await expect(readFile(path, "utf8")).rejects.toThrow();
}

async function sortedRawEntries(rawRoot: string): Promise<string[]> {
  return (await readdir(rawRoot)).sort();
}

async function createAuditDir(root: string): Promise<string> {
  const auditDir = join(root, "workspace", "tasks", "TASK-M1-SPIKE", "audit");
  await mkdir(auditDir, { recursive: true });
  return auditDir;
}

async function readAuditRows(root: string): Promise<PolicyGateAuditRow[]> {
  const auditFile = join(
    root,
    "workspace",
    "tasks",
    "TASK-M1-SPIKE",
    "audit",
    "policy-gate.ndjson"
  );
  const content = await readFile(auditFile, "utf8");
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PolicyGateAuditRow);
}

const testLogger: ToolLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {}
};
