import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  chmod,
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
import type {
  FuseRule,
  RunningToolHandle,
  RunningToolRegistry,
  RunningToolTerminalMetadata,
  ToolContext,
  ToolLogger,
  ToolResult
} from "@zero-os/shared";
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

const hasSeatbelt = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
const seatbeltTest = hasSeatbelt ? test : test.skip;
const nodeSeatbeltTest = hasSeatbelt && commandExistsSync("node") ? test : test.skip;
const pythonSeatbeltTest = hasSeatbelt && commandExistsSync("python3") ? test : test.skip;
const rubySeatbeltTest = hasSeatbelt && commandExistsSync("ruby") ? test : test.skip;
const rscriptSeatbeltTest = hasSeatbelt && commandExistsSync("Rscript") ? test : test.skip;

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

      const payload = expectDeniedPayload(result, "denied_by_advisory");
      expect(payload.reason).toContain("hide sandbox denial");
      await expectMissing(join(fixture.rawRoot, "node-suppressed.txt"));
      const rows = await readAuditRows(fixture.root);
      expectAuditMatchesPayload(rows.at(-1), payload);
    } finally {
      await fixture.cleanup();
    }
  });

  test("interpreter-internal fragmented raw path with swallowed exception is pre-denied", async () => {
    const fixture = await createFixture();
    try {
      const result = await runSandboxed(
        fixture,
        'node -e \'const fs = require("fs"); try { fs.writeFileSync(["data","raw","node-fragment.txt"].join("/"), "node"); } catch (error) {}\'',
        { enableAdvisory: false }
      );

      const payload = expectDeniedPayload(result, "denied_by_advisory");
      expect(payload.reason).toContain("hide sandbox denial");
      await expectMissing(join(fixture.rawRoot, "node-fragment.txt"));
      const rows = await readAuditRows(fixture.root);
      expectAuditMatchesPayload(rows.at(-1), payload);
    } finally {
      await fixture.cleanup();
    }
  });

  test("interpreter mutation helpers are target-aware in advisory classification", async () => {
    const fixture = await createFixture();
    try {
      const deniedCommands = [
        'python3 -c \'import os; os.unlink("data/raw/input.csv")\'',
        'python3 -c \'import os; os.rename("data/raw/input.csv", "workspace/input.csv")\'',
        'python3 -c \'import shutil; shutil.copyfile("workspace/source.csv", "data/raw/python-copy.csv")\'',
        'node -e \'const fs = require("fs"); fs.unlinkSync("data/raw/input.csv")\'',
        'node -e \'const fs = require("fs"); fs.renameSync("data/raw/input.csv", "workspace/input.csv")\'',
        'node -e \'const fs = require("fs"); fs.copyFileSync("workspace/source.csv", "data/raw/node-copy.csv")\'',
        'ruby -rfileutils -e \'File.delete("data/raw/input.csv")\'',
        'ruby -rfileutils -e \'FileUtils.mv("data/raw/input.csv", "workspace/input.csv")\'',
        'ruby -rfileutils -e \'FileUtils.cp("workspace/source.csv", "data/raw/ruby-copy.csv")\'',
        'Rscript -e \'unlink("data/raw/input.csv")\'',
        'Rscript -e \'file.rename("data/raw/input.csv", "workspace/input.csv")\'',
        'Rscript -e \'file.copy("workspace/source.csv", "data/raw/r-copy.csv")\''
      ];
      const allowedCommands = [
        'python3 -c \'import shutil; shutil.copyfile("data/raw/input.csv", "workspace/python-copy.csv")\'',
        'node -e \'const fs = require("fs"); fs.copyFileSync("data/raw/input.csv", "workspace/node-copy.csv")\'',
        'ruby -rfileutils -e \'FileUtils.cp("data/raw/input.csv", "workspace/ruby-copy.csv")\'',
        'Rscript -e \'file.copy("data/raw/input.csv", "workspace/r-copy.csv")\''
      ];

      for (const command of deniedCommands) {
        expect(evaluateRawDataWriteAdvisory(command, [fixture.rawRoot]).decision).toBe("deny");
      }
      for (const command of allowedCommands) {
        expect(evaluateRawDataWriteAdvisory(command, [fixture.rawRoot])).toEqual({
          decision: "allow"
        });
      }
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

      const payload = expectDeniedPayload(result, "denied_by_advisory");
      expect(payload.reason).toContain("hide sandbox denial");
      expect(await sortedRawEntries(fixture.rawRoot)).toEqual(beforeRawEntries);
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

  seatbeltTest("visible stderr masked by true is pre-denied as advisory", async () => {
    const fixture = await createFixture();
    try {
      const result = await runSandboxed(
        fixture,
        'd=data; r=raw; p="$d/$r/dynamic-visible.txt"; printf dynamic > "$p" || true',
        { enableAdvisory: false }
      );

      const payload = expectDeniedPayload(result, "denied_by_advisory");
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

  seatbeltTest("fake sandbox-exec earlier in PATH cannot bypass the absolute launcher", async () => {
    const fixture = await createFixture();
    const originalPath = process.env.PATH;
    try {
      const fakeBin = join(fixture.workspaceRoot, "fake-bin");
      await mkdir(fakeBin, { recursive: true });
      const fakeLauncher = join(fakeBin, "sandbox-exec");
      await writeFile(
        fakeLauncher,
        "#!/bin/sh\nwhile [ \"$1\" ]; do if [ \"$1\" = \"-f\" ]; then shift 2; else break; fi; done\nexec \"$@\"\n",
        "utf8"
      );
      await chmod(fakeLauncher, 0o755);
      process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;

      const result = await runSandboxed(fixture, "printf fake > data/raw/fake-path.txt", {
        enableAdvisory: false
      });

      const payload = expectDeniedPayload(result, "denied_by_sandbox");
      await expectMissing(join(fixture.rawRoot, "fake-path.txt"));
      const rows = await readAuditRows(fixture.root);
      expectAuditMatchesPayload(rows.at(-1), payload);
    } finally {
      process.env.PATH = originalPath;
      await fixture.cleanup();
    }
  });

  seatbeltTest("BASH_ENV raw-write prelude cannot run before sandbox authority", async () => {
    const fixture = await createFixture();
    const originalBashEnv = process.env.BASH_ENV;
    const originalEnv = process.env.ENV;
    try {
      const prelude = join(fixture.workspaceRoot, "bash-env.sh");
      await writeFile(prelude, "printf prelude > data/raw/bash-env-prelude.txt\n", "utf8");
      process.env.BASH_ENV = prelude;
      process.env.ENV = prelude;

      const result = await runSandboxed(fixture, "printf main > data/raw/bash-env-main.txt", {
        enableAdvisory: false
      });

      const payload = expectDeniedPayload(result, "denied_by_sandbox");
      await expectMissing(join(fixture.rawRoot, "bash-env-prelude.txt"));
      await expectMissing(join(fixture.rawRoot, "bash-env-main.txt"));
      const rows = await readAuditRows(fixture.root);
      expect(rows.at(-1)?.decision).toBe("denied_by_sandbox");
      expectAuditMatchesPayload(rows.at(-1), payload);
    } finally {
      restoreEnv("BASH_ENV", originalBashEnv);
      restoreEnv("ENV", originalEnv);
      await fixture.cleanup();
    }
  });

  seatbeltTest("direct data/raw variable-composed target is denied when shell errors are masked", async () => {
    const fixture = await createFixture();
    try {
      const result = await runSandboxed(
        fixture,
        'd=data; r=raw; printf x > "$d/$r/direct.txt" 2>/dev/null || true',
        { enableAdvisory: false }
      );

      const payload = expectDeniedPayload(result, "denied_by_advisory");
      await expectMissing(join(fixture.rawRoot, "direct.txt"));
      const rows = await readAuditRows(fixture.root);
      expectAuditMatchesPayload(rows.at(-1), payload);
    } finally {
      await fixture.cleanup();
    }
  });

  seatbeltTest("stderr redirected away from parent is pre-denied as advisory", async () => {
    const fixture = await createFixture();
    try {
      const result = await runSandboxed(
        fixture,
        'd=data; r=raw; p="$d/$r/hidden.txt"; 2>workspace/err.log > "$p"; echo ok',
        { enableAdvisory: false }
      );

      const payload = expectDeniedPayload(result, "denied_by_advisory");
      await expectMissing(join(fixture.rawRoot, "hidden.txt"));
      const rows = await readAuditRows(fixture.root);
      expectAuditMatchesPayload(rows.at(-1), payload);
    } finally {
      await fixture.cleanup();
    }
  });

  seatbeltTest("Python Path.joinpath raw write is denied when interpreter errors are suppressed", async () => {
    const fixture = await createFixture();
    try {
      const result = await runSandboxed(
        fixture,
        'python3 -c \'from pathlib import Path; Path("data").joinpath("raw", "pathlib.txt").write_text("x")\' 2>/dev/null || true',
        { enableAdvisory: false }
      );

      const payload = expectDeniedPayload(result, "denied_by_advisory");
      await expectMissing(join(fixture.rawRoot, "pathlib.txt"));
      const rows = await readAuditRows(fixture.root);
      expectAuditMatchesPayload(rows.at(-1), payload);
    } finally {
      await fixture.cleanup();
    }
  });

  pythonSeatbeltTest("Python delete, rename, and copy-to-raw mutations are denied when stderr is suppressed", async () => {
    const fixture = await createFixture();
    try {
      await writeFile(join(fixture.workspaceRoot, "python-source.csv"), "derived\n", "utf8");
      const cases = [
        {
          command: 'python3 -c \'import os; os.unlink("data/raw/input.csv")\' 2>/dev/null || true',
          assert: async () => {
            expect(await readFile(join(fixture.rawRoot, "input.csv"), "utf8")).toBe("raw,input\n");
          }
        },
        {
          command:
            'python3 -c \'import os; os.rename("data/raw/input.csv", "workspace/python-moved.csv")\' 2>/dev/null || true',
          assert: async () => {
            expect(await readFile(join(fixture.rawRoot, "input.csv"), "utf8")).toBe("raw,input\n");
            await expectMissing(join(fixture.workspaceRoot, "python-moved.csv"));
          }
        },
        {
          command:
            'python3 -c \'import shutil; shutil.copyfile("workspace/python-source.csv", "data/raw/python-copy.csv")\' 2>/dev/null || true',
          assert: async () => {
            await expectMissing(join(fixture.rawRoot, "python-copy.csv"));
          }
        }
      ];

      for (const commandCase of cases) {
        const result = await runSandboxed(fixture, commandCase.command, {
          enableAdvisory: false
        });
        const payload = expectDeniedPayload(result, "denied_by_advisory");
        expect(payload.reason).toContain("hide sandbox denial");
        await commandCase.assert();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  pythonSeatbeltTest("assignment-wrapped Python hidden raw write is denied while raw read copy remains allowed", async () => {
    const fixture = await createFixture();
    try {
      const denied = await runSandboxed(
        fixture,
        'TMPDIR="$PWD/workspace/tmp" python3 -c \'open("data/raw/assignment-hidden.txt", mode="w").write("x")\' 2>/dev/null || true',
        { enableAdvisory: false }
      );

      const payload = expectDeniedPayload(denied, "denied_by_advisory");
      expect(payload.reason).toContain("hide sandbox denial");
      await expectMissing(join(fixture.rawRoot, "assignment-hidden.txt"));

      const allowed = await runSandboxed(
        fixture,
        'TMPDIR="$PWD/workspace/tmp" python3 -c \'from pathlib import Path; Path("workspace/assignment-copy.csv").write_text(Path("data/raw/input.csv").read_text())\''
      );

      expect(allowed.success).toBe(true);
      expect(await readFile(join(fixture.workspaceRoot, "assignment-copy.csv"), "utf8")).toBe(
        "raw,input\n"
      );
      const rows = await readAuditRows(fixture.root);
      expectAuditMatchesPayload(
        rows.find((row) => row.error_id === payload.error_record.error_id),
        payload
      );
      expect(rows.at(-1)).toMatchObject({
        event: "tool.completed",
        decision: "allowed"
      });
    } finally {
      await fixture.cleanup();
    }
  });

  test("truncated hidden interpreter write scan fails closed before raw mutation", async () => {
    const fixture = await createFixture();
    try {
      const runningToolRegistry = new TestRunningToolRegistry();
      const handle = runningToolRegistry.register({
        toolUseId: "TOOL-CALL-1",
        toolName: "bash",
        abortable: true
      });
      const benignWrites = Array.from(
        { length: 513 },
        (_, index) => `fs.writeFileSync("workspace/benign-${index}.txt","x");`
      ).join("");
      const result = await runSandboxed(
        fixture,
        `node -e 'const fs=require("fs");try{${benignWrites}fs.writeFileSync("data/raw/truncated-hidden.txt","x");}catch(error){}'`,
        {
          enableAdvisory: false,
          context: {
            ...fixture.context,
            runningToolRegistry
          }
        }
      );

      const payload = expectDeniedPayload(result, "denied_by_advisory");
      expect(payload.reason).toContain("call scan was incomplete");
      await expectMissing(join(fixture.rawRoot, "truncated-hidden.txt"));
      const rows = await readAuditRows(fixture.root);
      expect(rows.at(-1)).toMatchObject({
        event: "tool.failed",
        decision: "denied_by_advisory"
      });
      expectAuditMatchesPayload(rows.at(-1), payload);
      expect(handle.getTerminalMetadata()).toMatchObject({
        cause: "completed",
        success: false,
        outputSummary: result.outputSummary
      });
    } finally {
      await fixture.cleanup();
    }
  });

  test("chr-concatenated hidden interpreter raw write is pre-denied", async () => {
    const fixture = await createFixture();
    try {
      const runningToolRegistry = new TestRunningToolRegistry();
      const handle = runningToolRegistry.register({
        toolUseId: "TOOL-CALL-1",
        toolName: "bash",
        abortable: true
      });
      const result = await runSandboxed(
        fixture,
        [
          'python3 -c "try:',
          '    open(chr(100)+\\"ata/raw/chr-hidden.txt\\", \\"w\\").write(\\"x\\")',
          "except Exception:",
          '    pass"'
        ].join("\n"),
        {
          enableAdvisory: false,
          context: {
            ...fixture.context,
            runningToolRegistry
          }
        }
      );

      const payload = expectDeniedPayload(result, "denied_by_advisory");
      expect(payload.reason).toContain("hide sandbox denial");
      await expectMissing(join(fixture.rawRoot, "chr-hidden.txt"));
      const rows = await readAuditRows(fixture.root);
      expect(rows.at(-1)).toMatchObject({
        event: "tool.failed",
        decision: "denied_by_advisory"
      });
      expectAuditMatchesPayload(rows.at(-1), payload);
      expect(handle.getTerminalMetadata()).toMatchObject({
        cause: "completed",
        success: false,
        outputSummary: result.outputSummary
      });
    } finally {
      await fixture.cleanup();
    }
  });

  pythonSeatbeltTest("Python Path receiver and named-mode raw mutations are denied", async () => {
    const fixture = await createFixture();
    try {
      const cases = [
        {
          command:
            'python3 -c \'from pathlib import Path; Path("data/raw/input.csv").unlink()\' 2>/dev/null || true',
          assert: async () => {
            expect(await readFile(join(fixture.rawRoot, "input.csv"), "utf8")).toBe("raw,input\n");
          }
        },
        {
          command:
            'python3 -c \'from pathlib import Path; Path("data/raw/path-open.txt").open("w").write("x")\' 2>/dev/null || true',
          assert: async () => {
            await expectMissing(join(fixture.rawRoot, "path-open.txt"));
          }
        },
        {
          command:
            'python3 -c \'open("data/raw/named-mode.txt", mode="w").write("x")\' 2>/dev/null || true',
          assert: async () => {
            await expectMissing(join(fixture.rawRoot, "named-mode.txt"));
          }
        },
        {
          command:
            'python3 -c \'from pathlib import Path; Path("data/raw/input.csv").rename("workspace/path-moved.csv")\' 2>/dev/null || true',
          assert: async () => {
            expect(await readFile(join(fixture.rawRoot, "input.csv"), "utf8")).toBe("raw,input\n");
            await expectMissing(join(fixture.workspaceRoot, "path-moved.csv"));
          }
        }
      ];

      for (const commandCase of cases) {
        const result = await runSandboxed(fixture, commandCase.command, {
          enableAdvisory: false
        });
        const payload = expectDeniedPayload(result, "denied_by_advisory");
        expect(payload.reason).toContain("hide sandbox denial");
        await commandCase.assert();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  nodeSeatbeltTest("Node unlink, rename, and copy-to-raw mutations are denied when stderr is suppressed", async () => {
    const fixture = await createFixture();
    try {
      await writeFile(join(fixture.workspaceRoot, "node-source.csv"), "derived\n", "utf8");
      const cases = [
        {
          command:
            'node -e \'const fs = require("fs"); fs.unlinkSync("data/raw/input.csv")\' 2>/dev/null || true',
          assert: async () => {
            expect(await readFile(join(fixture.rawRoot, "input.csv"), "utf8")).toBe("raw,input\n");
          }
        },
        {
          command:
            'node -e \'const fs = require("fs"); fs.renameSync("data/raw/input.csv", "workspace/node-moved.csv")\' 2>/dev/null || true',
          assert: async () => {
            expect(await readFile(join(fixture.rawRoot, "input.csv"), "utf8")).toBe("raw,input\n");
            await expectMissing(join(fixture.workspaceRoot, "node-moved.csv"));
          }
        },
        {
          command:
            'node -e \'const fs = require("fs"); fs.copyFileSync("workspace/node-source.csv", "data/raw/node-copy.csv")\' 2>/dev/null || true',
          assert: async () => {
            await expectMissing(join(fixture.rawRoot, "node-copy.csv"));
          }
        }
      ];

      for (const commandCase of cases) {
        const result = await runSandboxed(fixture, commandCase.command, {
          enableAdvisory: false
        });
        const payload = expectDeniedPayload(result, "denied_by_advisory");
        expect(payload.reason).toContain("hide sandbox denial");
        await commandCase.assert();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  seatbeltTest("Node path.join raw write is denied when interpreter errors are suppressed", async () => {
    const fixture = await createFixture();
    try {
      const result = await runSandboxed(
        fixture,
        'node -e \'const fs = require("fs"); const path = require("path"); fs.writeFileSync(path.join("data", "raw", "node-path-join.txt"), "node")\' 2>/dev/null || true',
        { enableAdvisory: false }
      );

      const payload = expectDeniedPayload(result, "denied_by_advisory");
      await expectMissing(join(fixture.rawRoot, "node-path-join.txt"));
      const rows = await readAuditRows(fixture.root);
      expectAuditMatchesPayload(rows.at(-1), payload);
    } finally {
      await fixture.cleanup();
    }
  });

  rubySeatbeltTest("Ruby delete, move, and copy-to-raw mutations are denied when stderr is suppressed", async () => {
    const fixture = await createFixture();
    try {
      await writeFile(join(fixture.workspaceRoot, "ruby-source.csv"), "derived\n", "utf8");
      const cases = [
        {
          command: "ruby -rfileutils -e 'File.delete(\"data/raw/input.csv\")' 2>/dev/null || true",
          assert: async () => {
            expect(await readFile(join(fixture.rawRoot, "input.csv"), "utf8")).toBe("raw,input\n");
          }
        },
        {
          command:
            "ruby -rfileutils -e 'FileUtils.mv(\"data/raw/input.csv\", \"workspace/ruby-moved.csv\")' 2>/dev/null || true",
          assert: async () => {
            expect(await readFile(join(fixture.rawRoot, "input.csv"), "utf8")).toBe("raw,input\n");
            await expectMissing(join(fixture.workspaceRoot, "ruby-moved.csv"));
          }
        },
        {
          command:
            "ruby -rfileutils -e 'FileUtils.cp(\"workspace/ruby-source.csv\", \"data/raw/ruby-copy.csv\")' 2>/dev/null || true",
          assert: async () => {
            await expectMissing(join(fixture.rawRoot, "ruby-copy.csv"));
          }
        }
      ];

      for (const commandCase of cases) {
        const result = await runSandboxed(fixture, commandCase.command, {
          enableAdvisory: false
        });
        const payload = expectDeniedPayload(result, "denied_by_advisory");
        expect(payload.reason).toContain("hide sandbox denial");
        await commandCase.assert();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  rubySeatbeltTest("Ruby File.join raw write is denied when interpreter errors are suppressed", async () => {
    const fixture = await createFixture();
    try {
      const result = await runSandboxed(
        fixture,
        "ruby -e 'File.write(File.join(\"data\", \"raw\", \"ruby-path-join.txt\"), \"ruby\")' 2>/dev/null || true",
        { enableAdvisory: false }
      );

      const payload = expectDeniedPayload(result, "denied_by_advisory");
      await expectMissing(join(fixture.rawRoot, "ruby-path-join.txt"));
      const rows = await readAuditRows(fixture.root);
      expectAuditMatchesPayload(rows.at(-1), payload);
    } finally {
      await fixture.cleanup();
    }
  });

  pythonSeatbeltTest("Python r+ raw file modification is denied and preserves existing bytes", async () => {
    const fixture = await createFixture();
    try {
      const target = join(fixture.rawRoot, "input.csv");
      const before = await readFile(target, "utf8");
      const result = await runSandboxed(
        fixture,
        'python3 -c \'f = open("data/raw/input.csv", "r+"); f.write("MUTATED"); f.close()\'',
        { enableAdvisory: false }
      );

      const payload = expectDeniedPayload(result, "denied_by_sandbox");
      expect(await readFile(target, "utf8")).toBe(before);
      const rows = await readAuditRows(fixture.root);
      expectAuditMatchesPayload(rows.at(-1), payload);
    } finally {
      await fixture.cleanup();
    }
  });

  for (const commandCase of [
    {
      name: "sed -i",
      fileName: "sed-input.txt",
      command: "sed -i '' 's/ORIGINAL/MUTATED/' data/raw/sed-input.txt"
    },
    {
      name: "perl -pi",
      fileName: "perl-input.txt",
      command: "perl -pi -e 's/ORIGINAL/MUTATED/' data/raw/perl-input.txt"
    }
  ]) {
    seatbeltTest(`${commandCase.name} raw mutation is normalized to raw-data denial`, async () => {
      const fixture = await createFixture();
      try {
        const target = join(fixture.rawRoot, commandCase.fileName);
        await writeFile(target, "ORIGINAL\n", "utf8");

        const result = await runSandboxed(fixture, commandCase.command, {
          enableAdvisory: false
        });

        const expectedDecision = commandCase.command.includes("2>/dev/null")
          ? "denied_by_advisory"
          : "denied_by_sandbox";
        const payload = expectDeniedPayload(result, expectedDecision);
        expect(await readFile(target, "utf8")).toBe("ORIGINAL\n");
        const rows = await readAuditRows(fixture.root);
        expectAuditMatchesPayload(rows.at(-1), payload);
      } finally {
        await fixture.cleanup();
      }
    });
  }

  for (const commandCase of [
    {
      name: "stderr-suppressed sed -i",
      fileName: "sed-input.txt",
      command: "sed -i '' 's/ORIGINAL/MUTATED/' data/raw/sed-input.txt 2>/dev/null || true"
    },
    {
      name: "stderr-suppressed perl -pi",
      fileName: "perl-input.txt",
      command: "perl -pi -e 's/ORIGINAL/MUTATED/' data/raw/perl-input.txt 2>/dev/null || true"
    }
  ]) {
    seatbeltTest(`${commandCase.name} raw mutation is pre-denied when output is hidden`, async () => {
      const fixture = await createFixture();
      try {
        const target = join(fixture.rawRoot, commandCase.fileName);
        await writeFile(target, "ORIGINAL\n", "utf8");

        const result = await runSandboxed(fixture, commandCase.command, {
          enableAdvisory: false
        });

        const payload = expectDeniedPayload(result, "denied_by_advisory");
        expect(payload.reason).toContain("hide sandbox denial");
        expect(await readFile(target, "utf8")).toBe("ORIGINAL\n");
        const rows = await readAuditRows(fixture.root);
        expectAuditMatchesPayload(rows.at(-1), payload);
      } finally {
        await fixture.cleanup();
      }
    });
  }

  for (const commandCase of [
    {
      name: "overwrite redirection",
      command: ": > data/raw/input.csv 2>/dev/null || true"
    },
    {
      name: "append redirection",
      command: "printf appended >> data/raw/input.csv 2>/dev/null || true"
    },
    {
      name: "truncate",
      command: "truncate -s 0 data/raw/input.csv"
    },
    {
      name: "dd overwrite",
      command: "dd if=/dev/zero of=data/raw/input.csv bs=1 count=1"
    }
  ]) {
    seatbeltTest(`existing raw file ${commandCase.name} is denied and preserves bytes`, async () => {
      const fixture = await createFixture();
      try {
        const target = join(fixture.rawRoot, "input.csv");
        const before = await readFile(target, "utf8");

        const result = await runSandboxed(fixture, commandCase.command, {
          enableAdvisory: false
        });

        const expectedDecision = commandCase.command.includes("2>/dev/null")
          ? "denied_by_advisory"
          : "denied_by_sandbox";
        const payload = expectDeniedPayload(result, expectedDecision);
        expect(await readFile(target, "utf8")).toBe(before);
        const rows = await readAuditRows(fixture.root);
        expectAuditMatchesPayload(rows.at(-1), payload);
      } finally {
        await fixture.cleanup();
      }
    });
  }

  for (const commandCase of [
    {
      name: "unsuppressed overwrite redirection",
      command: ": > data/raw/input.csv"
    },
    {
      name: "unsuppressed append redirection",
      command: "printf appended >> data/raw/input.csv"
    }
  ]) {
    seatbeltTest(`existing raw file ${commandCase.name} is denied and preserves bytes`, async () => {
      const fixture = await createFixture();
      try {
        const target = join(fixture.rawRoot, "input.csv");
        const before = await readFile(target, "utf8");

        const result = await runSandboxed(fixture, commandCase.command, {
          enableAdvisory: false
        });

        const payload = expectDeniedPayload(result, "denied_by_sandbox");
        expect(await readFile(target, "utf8")).toBe(before);
        const rows = await readAuditRows(fixture.root);
        expectAuditMatchesPayload(rows.at(-1), payload);
      } finally {
        await fixture.cleanup();
      }
    });
  }

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

  seatbeltTest("raw read redirected to workspace with denial-like stdout stays allowed", async () => {
    const fixture = await createFixture();
    try {
      const result = await runSandboxed(
        fixture,
        "cat data/raw/input.csv > workspace/input-copy.csv; printf 'Permission denied sandbox\\n'"
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain("Permission denied sandbox");
      expect(result.outputSummary).not.toContain("sandbox-exec");
      expect(result.outputSummary).not.toContain(fixture.profileRoot);
      expect(await readFile(join(fixture.workspaceRoot, "input-copy.csv"), "utf8")).toBe(
        "raw,input\n"
      );
      const rows = await readAuditRows(fixture.root);
      expect(rows.at(-1)).toMatchObject({
        event: "tool.completed",
        decision: "allowed",
        profile_id: expect.stringMatching(/^shud-raw-seatbelt-/),
        profile_path: expect.stringContaining(".sb")
      });
    } finally {
      await fixture.cleanup();
    }
  });

  seatbeltTest("ordinary raw read workspace-write command failure is not raw-denial evidence", async () => {
    const fixture = await createFixture();
    try {
      const result = await runSandboxed(
        fixture,
        "grep NOT_PRESENT data/raw/input.csv > workspace/out.txt 2>workspace/err.log",
        { enableAdvisory: false }
      );

      expect(result.success).toBe(false);
      expect(result.outputSummary).toContain("Command failed");
      expect(() => JSON.parse(result.output)).toThrow();
      expect(await readFile(join(fixture.workspaceRoot, "out.txt"), "utf8")).toBe("");
      expect(await readFile(join(fixture.workspaceRoot, "err.log"), "utf8")).toBe("");
      const rows = await readAuditRows(fixture.root);
      expect(rows.at(-1)).toMatchObject({
        event: "tool.failed",
        decision: "failed"
      });
    } finally {
      await fixture.cleanup();
    }
  });

  seatbeltTest("raw read copy into non-writable workspace path stays a generic command failure", async () => {
    const fixture = await createFixture();
    const noWriteDir = join(fixture.workspaceRoot, "no-write");
    try {
      await mkdir(noWriteDir, { recursive: true });
      await chmod(noWriteDir, 0o500);

      const result = await runSandboxed(
        fixture,
        "cp data/raw/input.csv workspace/no-write/input.csv",
        { enableAdvisory: false }
      );

      expect(result.success).toBe(false);
      expect(result.output).toContain("Permission denied");
      expect(result.outputSummary).toContain("Command failed");
      expect(() => JSON.parse(result.output)).toThrow();
      await expectMissing(join(noWriteDir, "input.csv"));
      const rows = await readAuditRows(fixture.root);
      expect(rows.at(-1)).toMatchObject({
        event: "tool.failed",
        decision: "failed"
      });
    } finally {
      await chmod(noWriteDir, 0o700).catch(() => {});
      await fixture.cleanup();
    }
  });

  seatbeltTest("raw-reading grep with unrelated Permission denied stays a generic command failure", async () => {
    const fixture = await createFixture();
    const noReadFile = join(fixture.workspaceRoot, "no-read.txt");
    try {
      await writeFile(noReadFile, "workspace\n", "utf8");
      await chmod(noReadFile, 0o000);

      const result = await runSandboxed(
        fixture,
        "grep raw data/raw/input.csv workspace/no-read.txt",
        { enableAdvisory: false }
      );

      expect(result.success).toBe(false);
      expect(result.output).toContain("raw,input");
      expect(result.output).toContain("Permission denied");
      expect(result.outputSummary).toContain("Command failed");
      expect(() => JSON.parse(result.output)).toThrow();
      const rows = await readAuditRows(fixture.root);
      expect(rows.at(-1)).toMatchObject({
        event: "tool.failed",
        decision: "failed"
      });
    } finally {
      await chmod(noReadFile, 0o600).catch(() => {});
      await fixture.cleanup();
    }
  });

  seatbeltTest("Node raw read copied to workspace is not advisory-denied", async () => {
    const fixture = await createFixture();
    try {
      const command =
        'node -e \'const fs = require("fs"); fs.writeFileSync("workspace/input-copy.csv", fs.readFileSync("data/raw/input.csv"))\'';

      expect(evaluateRawDataWriteAdvisory(command, [fixture.rawRoot])).toEqual({
        decision: "allow"
      });

      const result = await runSandboxed(fixture, command);

      expect(result.success).toBe(true);
      expect(await readFile(join(fixture.workspaceRoot, "input-copy.csv"), "utf8")).toBe(
        "raw,input\n"
      );
      const rows = await readAuditRows(fixture.root);
      expect(rows.at(-1)).toMatchObject({
        event: "tool.completed",
        decision: "allowed"
      });
    } finally {
      await fixture.cleanup();
    }
  });

  pythonSeatbeltTest("Python raw read copied to workspace is not advisory-denied", async () => {
    const fixture = await createFixture();
    try {
      const command =
        'python3 -c \'from pathlib import Path; Path("workspace/input-copy.csv").write_text(Path("data/raw/input.csv").read_text())\'';

      expect(evaluateRawDataWriteAdvisory(command, [fixture.rawRoot])).toEqual({
        decision: "allow"
      });

      const result = await runSandboxed(fixture, command);

      expect(result.success).toBe(true);
      expect(await readFile(join(fixture.workspaceRoot, "input-copy.csv"), "utf8")).toBe(
        "raw,input\n"
      );
    } finally {
      await fixture.cleanup();
    }
  });

  rubySeatbeltTest("Ruby raw read copied to workspace is not advisory-denied", async () => {
    const fixture = await createFixture();
    try {
      const command =
        "ruby -e 'File.write(\"workspace/input-copy.csv\", File.read(\"data/raw/input.csv\"))'";

      expect(evaluateRawDataWriteAdvisory(command, [fixture.rawRoot])).toEqual({
        decision: "allow"
      });

      const result = await runSandboxed(fixture, command);

      expect(result.success).toBe(true);
      expect(await readFile(join(fixture.workspaceRoot, "input-copy.csv"), "utf8")).toBe(
        "raw,input\n"
      );
    } finally {
      await fixture.cleanup();
    }
  });

  test("Rscript writer helpers are target-aware in advisory classification", async () => {
    const fixture = await createFixture();
    try {
      const legalCopy =
        'Rscript -e \'write.csv(read.csv("data/raw/input.csv"), "workspace/input-copy.csv")\'';
      const rawTarget =
        'Rscript -e \'write.csv(data.frame(x = 1), "data/raw/r-output.csv")\'';
      const rawFilePath =
        'Rscript -e \'writeLines("x", file.path("data", "raw", "r-lines.txt"))\'';

      expect(evaluateRawDataWriteAdvisory(legalCopy, [fixture.rawRoot])).toEqual({
        decision: "allow"
      });
      expect(evaluateRawDataWriteAdvisory(rawTarget, [fixture.rawRoot]).decision).toBe("deny");
      expect(evaluateRawDataWriteAdvisory(rawFilePath, [fixture.rawRoot]).decision).toBe("deny");
    } finally {
      await fixture.cleanup();
    }
  });

  rscriptSeatbeltTest("Rscript raw writer helper with hidden output is pre-denied", async () => {
    const fixture = await createFixture();
    try {
      const result = await runSandboxed(
        fixture,
        'Rscript -e \'writeLines("x", "data/raw/r-hidden.txt")\' 2>/dev/null || true',
        { enableAdvisory: false }
      );

      const payload = expectDeniedPayload(result, "denied_by_advisory");
      expect(payload.reason).toContain("hide sandbox denial");
      await expectMissing(join(fixture.rawRoot, "r-hidden.txt"));
    } finally {
      await fixture.cleanup();
    }
  });

  rscriptSeatbeltTest("env-wrapped Rscript hidden raw write is denied", async () => {
    const fixture = await createFixture();
    try {
      const result = await runSandboxed(
        fixture,
        'env TMPDIR="$PWD/workspace/tmp" Rscript -e \'writeLines("x", "data/raw/r-env-hidden.txt")\' 2>/dev/null || true',
        { enableAdvisory: false }
      );

      const payload = expectDeniedPayload(result, "denied_by_advisory");
      expect(payload.reason).toContain("hide sandbox denial");
      await expectMissing(join(fixture.rawRoot, "r-env-hidden.txt"));
    } finally {
      await fixture.cleanup();
    }
  });

  rscriptSeatbeltTest("Rscript file mutation helpers are denied when stderr is suppressed", async () => {
    const fixture = await createFixture();
    try {
      await writeFile(join(fixture.workspaceRoot, "r-source.csv"), "derived\n", "utf8");
      const cases = [
        {
          command: 'Rscript -e \'unlink("data/raw/input.csv")\' 2>/dev/null || true',
          assert: async () => {
            expect(await readFile(join(fixture.rawRoot, "input.csv"), "utf8")).toBe("raw,input\n");
          }
        },
        {
          command:
            'Rscript -e \'file.rename("data/raw/input.csv", "workspace/r-moved.csv")\' 2>/dev/null || true',
          assert: async () => {
            expect(await readFile(join(fixture.rawRoot, "input.csv"), "utf8")).toBe("raw,input\n");
            await expectMissing(join(fixture.workspaceRoot, "r-moved.csv"));
          }
        },
        {
          command:
            'Rscript -e \'file.copy("workspace/r-source.csv", "data/raw/r-copy.csv")\' 2>/dev/null || true',
          assert: async () => {
            await expectMissing(join(fixture.rawRoot, "r-copy.csv"));
          }
        }
      ];

      for (const commandCase of cases) {
        const result = await runSandboxed(fixture, commandCase.command, {
          enableAdvisory: false
        });
        const payload = expectDeniedPayload(result, "denied_by_advisory");
        expect(payload.reason).toContain("hide sandbox denial");
        await commandCase.assert();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  rscriptSeatbeltTest("Rscript raw source file.copy to workspace remains allowed", async () => {
    const fixture = await createFixture();
    try {
      const command =
        'env TMPDIR="$PWD/workspace/tmp" Rscript -e \'file.copy("data/raw/input.csv", "workspace/r-input-copy.csv")\'';

      expect(evaluateRawDataWriteAdvisory(command, [fixture.rawRoot])).toEqual({
        decision: "allow"
      });

      const result = await runSandboxed(fixture, command);

      expect(result.success).toBe(true);
      expect(await readFile(join(fixture.workspaceRoot, "r-input-copy.csv"), "utf8")).toBe(
        "raw,input\n"
      );
    } finally {
      await fixture.cleanup();
    }
  });

  seatbeltTest("dynamic workspace data/raw path is legal while direct dynamic raw target is denied", async () => {
    const fixture = await createFixture();
    try {
      const workspaceCommand =
        'd=data; r=raw; mkdir -p "workspace/$d/$r"; printf ok > "workspace/$d/$r/out.txt"';
      const directRawCommand =
        'd=data; r=raw; printf nope > "$d/$r/direct-dynamic.txt" 2>/dev/null || true';

      expect(evaluateRawDataWriteAdvisory(workspaceCommand, [fixture.rawRoot])).toEqual({
        decision: "allow"
      });

      const allowed = await runSandboxed(fixture, workspaceCommand);
      expect(allowed.success).toBe(true);
      expect(await readFile(join(fixture.workspaceRoot, "data", "raw", "out.txt"), "utf8")).toBe(
        "ok"
      );

      const denied = await runSandboxed(fixture, directRawCommand, {
        enableAdvisory: false
      });
      const payload = expectDeniedPayload(denied, "denied_by_advisory");
      expect(payload.reason).toContain("hide sandbox denial");
      await expectMissing(join(fixture.rawRoot, "direct-dynamic.txt"));
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
        decision: "allowed",
        profile_id: expect.stringMatching(/^shud-raw-seatbelt-/),
        profile_path: expect.stringContaining(".sb")
      });
    } finally {
      await fixture.cleanup();
    }
  });

  seatbeltTest("allowed sandboxed bash logs a single outer lifecycle without profile summary leak", async () => {
    const fixture = await createFixture();
    try {
      const loggerEvents: string[] = [];
      const operationEvents: string[] = [];
      const result = await runSandboxed(fixture, "printf allowed > workspace/logged.txt", {
        context: {
          ...fixture.context,
          logger: {
            debug() {},
            info(event) {
              loggerEvents.push(event);
            },
            warn() {},
            error() {}
          },
          observability: {
            logEvent() {},
            recordOperation(entry) {
              operationEvents.push(entry.event);
            }
          }
        } as ToolContext
      });

      expect(result.success).toBe(true);
      expect(result.outputSummary).toBe("Executed: printf allowed > workspace/logged.txt");
      expect(result.outputSummary).not.toContain("sandbox-exec");
      expect(loggerEvents.filter((event) => event === "tool_call_complete")).toHaveLength(1);
      expect(operationEvents.filter((event) => event === "tool_call_complete")).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });

  seatbeltTest("running metadata matches final allowed ToolResult", async () => {
    const fixture = await createFixture();
    try {
      const runningToolRegistry = new TestRunningToolRegistry();
      const handle = runningToolRegistry.register({
        toolUseId: "TOOL-CALL-1",
        toolName: "bash",
        abortable: true
      });

      const result = await runSandboxed(fixture, "printf ok > workspace/metadata-ok.txt", {
        context: {
          ...fixture.context,
          runningToolRegistry
        }
      });

      expect(result.success).toBe(true);
      expect(handle.getTerminalMetadata()).toMatchObject({
        cause: "completed",
        success: true,
        outputSummary: result.outputSummary
      });
    } finally {
      await fixture.cleanup();
    }
  });

  seatbeltTest("running metadata matches final visible raw-denial ToolResult", async () => {
    const fixture = await createFixture();
    try {
      const runningToolRegistry = new TestRunningToolRegistry();
      const handle = runningToolRegistry.register({
        toolUseId: "TOOL-CALL-1",
        toolName: "bash",
        abortable: true
      });

      const result = await runSandboxed(fixture, "printf nope > data/raw/metadata-denied.txt", {
        enableAdvisory: false,
        context: {
          ...fixture.context,
          runningToolRegistry
        }
      });

      expectDeniedPayload(result, "denied_by_sandbox");
      expect(handle.getTerminalMetadata()).toMatchObject({
        cause: "completed",
        success: false,
        outputSummary: result.outputSummary
      });
      await expectMissing(join(fixture.rawRoot, "metadata-denied.txt"));
    } finally {
      await fixture.cleanup();
    }
  });

  test("running metadata matches final audit-unavailable ToolResult", async () => {
    const fixture = await createFixture();
    try {
      const runningToolRegistry = new TestRunningToolRegistry();
      const handle = runningToolRegistry.register({
        toolUseId: "TOOL-CALL-1",
        toolName: "bash",
        abortable: true
      });

      const result = await runSandboxed(fixture, "printf no-run > workspace/metadata-audit.txt", {
        auditTaskId: "..",
        context: {
          ...fixture.context,
          runningToolRegistry
        }
      });

      expectAuditReservationFailure(result);
      expect(handle.getTerminalMetadata()).toMatchObject({
        cause: "completed",
        success: false,
        outputSummary: result.outputSummary
      });
      await expectMissing(join(fixture.workspaceRoot, "metadata-audit.txt"));
    } finally {
      await fixture.cleanup();
    }
  });

  seatbeltTest("timeout terminal metadata is owned by the outer wrapper", async () => {
    const fixture = await createFixture();
    try {
      const runningToolRegistry = new TestRunningToolRegistry();
      const handle = runningToolRegistry.register({
        toolUseId: "TOOL-CALL-1",
        toolName: "bash",
        abortable: true
      });

      const result = await runSandboxed(fixture, "sleep 2", {
        timeout: 40,
        context: {
          ...fixture.context,
          runningToolRegistry
        }
      });

      expect(result.success).toBe(false);
      const metadata = handle.getTerminalMetadata();
      expect(metadata?.cause).toBe("timeout");
      expect(metadata?.outputSummary).toContain("sleep 2");
      expect(metadata?.outputSummary).not.toContain("sandbox-exec");
      expect(metadata?.outputSummary).not.toContain(fixture.profileRoot);
      expect(result.outputSummary).not.toContain("sandbox-exec");
      expect(result.outputSummary).not.toContain(fixture.profileRoot);
    } finally {
      await fixture.cleanup();
    }
  });

  seatbeltTest("timeout terminates background children before they can write", async () => {
    const fixture = await createFixture();
    try {
      const leakPath = join(fixture.workspaceRoot, "timeout-child-write.txt");
      const result = await runSandboxed(
        fixture,
        "sh -c 'sleep 0.25; printf leaked > workspace/timeout-child-write.txt' & wait",
        { timeout: 40 }
      );

      expect(result.success).toBe(false);
      await expectMissing(leakPath);
      await Bun.sleep(400);
      await expectMissing(leakPath);
    } finally {
      await fixture.cleanup();
    }
  });

  seatbeltTest("timeout kills TERM-ignoring descendants before returning", async () => {
    const fixture = await createFixture();
    try {
      const leakPath = join(fixture.workspaceRoot, "timeout-term-ignore-write.txt");
      const result = await runSandboxed(
        fixture,
        "sh -c '(trap \"\" TERM; sleep 0.25; printf leaked > workspace/timeout-term-ignore-write.txt) & wait'",
        { timeout: 40 }
      );

      expect(result.success).toBe(false);
      await expectMissing(leakPath);
      await Bun.sleep(400);
      await expectMissing(leakPath);
    } finally {
      await fixture.cleanup();
    }
  });

  seatbeltTest("abort terminates background children before they can write", async () => {
    const fixture = await createFixture();
    try {
      const runningToolRegistry = new TestRunningToolRegistry();
      const handle = runningToolRegistry.register({
        toolUseId: "TOOL-CALL-1",
        toolName: "bash",
        abortable: true
      });
      const leakPath = join(fixture.workspaceRoot, "abort-child-write.txt");
      const run = runSandboxed(
        fixture,
        "sh -c 'sleep 0.35; printf leaked > workspace/abort-child-write.txt' & wait",
        {
          timeout: 5_000,
          context: {
            ...fixture.context,
            runningToolRegistry
          }
        }
      );

      await Bun.sleep(80);
      expect(handle.requestAbort("stop command")).toBe("accepted");
      const result = await run;

      expect(result.success).toBe(false);
      expect(handle.getTerminalMetadata()?.cause).toBe("abort");
      await expectMissing(leakPath);
      await Bun.sleep(500);
      await expectMissing(leakPath);
    } finally {
      await fixture.cleanup();
    }
  });

  seatbeltTest("abort kills TERM-ignoring descendants before returning", async () => {
    const fixture = await createFixture();
    try {
      const runningToolRegistry = new TestRunningToolRegistry();
      const handle = runningToolRegistry.register({
        toolUseId: "TOOL-CALL-1",
        toolName: "bash",
        abortable: true
      });
      const leakPath = join(fixture.workspaceRoot, "abort-term-ignore-write.txt");
      const run = runSandboxed(
        fixture,
        "sh -c '(trap \"\" TERM; sleep 0.35; printf leaked > workspace/abort-term-ignore-write.txt) & wait'",
        {
          timeout: 5_000,
          context: {
            ...fixture.context,
            runningToolRegistry
          }
        }
      );

      await Bun.sleep(80);
      expect(handle.requestAbort("stop command")).toBe("accepted");
      const result = await run;

      expect(result.success).toBe(false);
      expect(handle.getTerminalMetadata()?.cause).toBe("abort");
      await expectMissing(leakPath);
      await Bun.sleep(500);
      await expectMissing(leakPath);
    } finally {
      await fixture.cleanup();
    }
  });

  pythonSeatbeltTest("session-escape descendants are rejected before timeout or abort can leak writes", async () => {
    const fixture = await createFixture();
    try {
      const timeoutLeakPath = join(fixture.workspaceRoot, "timeout-setsid-leak.txt");
      const abortLeakPath = join(fixture.workspaceRoot, "abort-setpgrp-leak.txt");

      const timeoutResult = await runSandboxed(
        fixture,
        'python3 -c \'import os, time; os.setsid(); time.sleep(0.2); open("workspace/timeout-setsid-leak.txt", "w").write("leaked")\'',
        { timeout: 40 }
      );
      expectProcessContainmentFailure(timeoutResult);

      const runningToolRegistry = new TestRunningToolRegistry();
      const handle = runningToolRegistry.register({
        toolUseId: "TOOL-CALL-1",
        toolName: "bash",
        abortable: true
      });
      const abortResult = await runSandboxed(
        fixture,
        'python3 -c \'import os, time; os.setpgrp(); time.sleep(0.2); open("workspace/abort-setpgrp-leak.txt", "w").write("leaked")\'',
        {
          timeout: 5_000,
          context: {
            ...fixture.context,
            runningToolRegistry
          }
        }
      );

      expectProcessContainmentFailure(abortResult);
      expect(handle.requestAbort("too late")).toBe("already_finished");
      await expectMissing(timeoutLeakPath);
      await expectMissing(abortLeakPath);
      await Bun.sleep(350);
      await expectMissing(timeoutLeakPath);
      await expectMissing(abortLeakPath);
    } finally {
      await fixture.cleanup();
    }
  });

  test("real process containment escape forms remain rejected", async () => {
    const fixture = await createFixture();
    try {
      const cases = [
        {
          command: "setsid sh -c 'printf leaked > workspace/real-setsid.txt'",
          path: "real-setsid.txt"
        },
        {
          command: "setpgrp sh -c 'printf leaked > workspace/real-setpgrp.txt'",
          path: "real-setpgrp.txt"
        },
        {
          command: "daemonize sh -c 'printf leaked > workspace/real-daemonize.txt'",
          path: "real-daemonize.txt"
        },
        {
          command:
            'python3 -c \'import subprocess; subprocess.Popen(["sh", "-c", "printf leaked > workspace/real-python-session.txt"], start_new_session=True)\'',
          path: "real-python-session.txt"
        },
        {
          command:
            'node -e \'require("child_process").spawn("sh", ["-c", "printf leaked > workspace/real-node-detached.txt"], { detached: true })\'',
          path: "real-node-detached.txt"
        },
        {
          command: 'ruby -e \'Process.daemon; File.write("workspace/real-ruby-daemon.txt", "x")\'',
          path: "real-ruby-daemon.txt"
        },
        {
          command:
            'Rscript -e \'system("printf leaked > workspace/real-r-wait-false.txt", wait = FALSE)\'',
          path: "real-r-wait-false.txt"
        }
      ];

      for (const commandCase of cases) {
        const result = await runSandboxed(fixture, commandCase.command);
        expectProcessContainmentFailure(result);
        await expectMissing(join(fixture.workspaceRoot, commandCase.path));
      }
    } finally {
      await fixture.cleanup();
    }
  });

  pythonSeatbeltTest("dynamic Python Popen session escape is rejected before workspace leak", async () => {
    const fixture = await createFixture();
    try {
      const leakPath = join(fixture.workspaceRoot, "popen-session-leak.txt");
      const result = await runSandboxed(
        fixture,
        'python3 -c \'import subprocess; kw={"start"+"_new_session": True}; subprocess.Popen(["sh","-c","sleep 0.25; printf leaked > workspace/popen-session-leak.txt"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **kw)\''
      );

      expectProcessContainmentFailure(result);
      await expectMissing(leakPath);
      await Bun.sleep(400);
      await expectMissing(leakPath);
      const rows = await readAuditRows(fixture.root);
      expect(rows.at(-1)).toMatchObject({
        event: "tool.failed",
        decision: "policy_gate_process_containment_unavailable"
      });
    } finally {
      await fixture.cleanup();
    }
  });

  seatbeltTest("process containment keywords as workspace data and path text are allowed", async () => {
    const fixture = await createFixture();
    try {
      for (const word of ["setsid", "setpgrp", "daemonize", "start_new_session"]) {
        const result = await runSandboxed(
          fixture,
          `printf ${word} > workspace/${word}.txt # ${word}`
        );

        expect(result.success).toBe(true);
        expect(await readFile(join(fixture.workspaceRoot, `${word}.txt`), "utf8")).toBe(word);
      }
      const dataCases = [
        { text: "subprocess.Popen(", path: "python-popen-text.txt" },
        { text: "child_process.spawn(", path: "node-spawn-text.txt" },
        { text: "multiprocessing.Process(", path: "multiprocessing-process-text.txt" }
      ];
      for (const dataCase of dataCases) {
        const result = await runSandboxed(
          fixture,
          `printf '${dataCase.text}' > workspace/${dataCase.path}`
        );

        expect(result.success).toBe(true);
        expect(await readFile(join(fixture.workspaceRoot, dataCase.path), "utf8")).toBe(
          dataCase.text
        );
      }
      const rows = await readAuditRows(fixture.root);
      expect(rows.at(-1)).toMatchObject({
        event: "tool.completed",
        decision: "allowed"
      });
    } finally {
      await fixture.cleanup();
    }
  });

  seatbeltTest("unwaited delayed background audit subtree move fails closed with canonical audit intact", async () => {
    const fixture = await createFixture();
    try {
      const result = await runSandboxed(
        fixture,
        "(sleep 0.2; mv workspace/tasks workspace/tasks.moved) & true",
        { enableAdvisory: false }
      );

      expectProcessContainmentFailure(result);
      await Bun.sleep(350);
      await expectMissing(join(fixture.workspaceRoot, "tasks.moved"));
      const rows = await readAuditRows(fixture.root);
      expect(rows.at(-1)).toMatchObject({
        event: "tool.failed",
        decision: "policy_gate_process_containment_unavailable"
      });
    } finally {
      await fixture.cleanup();
    }
  });

  pythonSeatbeltTest("detached delayed audit ancestor move cannot displace canonical audit", async () => {
    const fixture = await createFixture();
    try {
      const result = await runSandboxed(
        fixture,
        [
          'python3 -c "import os, time',
          "pid = os.fork()",
          "if pid != 0:",
          "    os._exit(0)",
          'getattr(os, \\"set\\" + \\"sid\\")()',
          "pid = os.fork()",
          "if pid != 0:",
          "    os._exit(0)",
          "time.sleep(0.2)",
          'os.rename(\\"workspace/tasks\\", \\"workspace/tasks.moved\\")"'
        ].join("\n"),
        { enableAdvisory: false }
      );

      await Bun.sleep(350);
      await expectMissing(join(fixture.workspaceRoot, "tasks.moved"));
      const rows = await readAuditRows(fixture.root);
      expect(rows.at(-1)?.event).toMatch(/^tool\.(?:completed|failed)$/);
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

  pythonSeatbeltTest("cwd-aware interpreter targets allow workspace-local data/raw and deny protected root data/raw", async () => {
    const fixture = await createFixture();
    try {
      const workspaceLocal =
        'mkdir -p workspace/data/raw; cd workspace && python3 -c \'try:\n f=open("data/raw/interpreter-out.txt", mode="w"); f.write("ok"); f.close()\nexcept Exception:\n pass\'';
      const protectedRoot =
        'python3 -c \'try:\n f=open("data/raw/interpreter-root.txt", mode="w"); f.write("nope"); f.close()\nexcept Exception:\n pass\'';

      expect(evaluateRawDataWriteAdvisory(workspaceLocal, [fixture.rawRoot])).toEqual({
        decision: "allow"
      });

      const allowed = await runSandboxed(fixture, workspaceLocal);
      expect(allowed.success).toBe(true);
      expect(
        await readFile(join(fixture.workspaceRoot, "data", "raw", "interpreter-out.txt"), "utf8")
      ).toBe("ok");

      const denied = await runSandboxed(fixture, protectedRoot, {
        enableAdvisory: false
      });
      const payload = expectDeniedPayload(denied, "denied_by_advisory");
      expect(payload.reason).toContain("hide sandbox denial");
      await expectMissing(join(fixture.rawRoot, "interpreter-root.txt"));
    } finally {
      await fixture.cleanup();
    }
  });

  for (const commandCase of [
    {
      name: "subshell cd",
      outputPath: ["data", "raw", "subshell-out.txt"],
      command:
        "mkdir -p workspace/data/raw; (cd workspace && printf ok > data/raw/subshell-out.txt)"
    },
    {
      name: "grouped cd",
      outputPath: ["data", "raw", "group-out.txt"],
      command: "mkdir -p workspace/data/raw; { cd workspace; printf ok > data/raw/group-out.txt; }"
    },
    {
      name: "child bash cd",
      outputPath: ["data", "raw", "child-bash-out.txt"],
      command:
        "mkdir -p workspace/data/raw; bash -c 'cd workspace && printf ok > data/raw/child-bash-out.txt'"
    }
  ]) {
    seatbeltTest(`${commandCase.name} workspace data/raw write is not advisory false-denied`, async () => {
      const fixture = await createFixture();
      try {
        expect(evaluateRawDataWriteAdvisory(commandCase.command, [fixture.rawRoot])).toEqual({
          decision: "allow"
        });

        const result = await runSandboxed(fixture, commandCase.command);

        expect(result.success).toBe(true);
        expect(
          await readFile(join(fixture.workspaceRoot, ...commandCase.outputPath), "utf8")
        ).toBe("ok");
        const rows = await readAuditRows(fixture.root);
        expect(rows.at(-1)).toMatchObject({
          event: "tool.completed",
          decision: "allowed"
        });
      } finally {
        await fixture.cleanup();
      }
    });
  }

  seatbeltTest("parent-relative workspace data/raw write is not treated as protected raw", async () => {
    const fixture = await createFixture();
    try {
      const command =
        "mkdir -p workspace/data/raw workspace/subdir; cd workspace/subdir && printf ok > ../data/raw/parent-out.txt";

      expect(evaluateRawDataWriteAdvisory(command, [fixture.rawRoot])).toEqual({
        decision: "allow"
      });

      const result = await runSandboxed(fixture, command);

      expect(result.success).toBe(true);
      expect(
        await readFile(join(fixture.workspaceRoot, "data", "raw", "parent-out.txt"), "utf8")
      ).toBe("ok");
      const rows = await readAuditRows(fixture.root);
      expect(rows.at(-1)).toMatchObject({
        event: "tool.completed",
        decision: "allowed"
      });
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

  test("audit reservation failure fails closed before bash execution", async () => {
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
        command: "printf side-effect > workspace/audit-fail-side-effect.txt; printf nope > data/raw/audit-fail.txt",
        timeout: 30_000
      });

      expectAuditReservationFailure(result);
      await expectMissing(join(fixture.rawRoot, "audit-fail.txt"));
      await expectMissing(join(fixture.workspaceRoot, "audit-fail-side-effect.txt"));
    } finally {
      await fixture.cleanup();
    }
  });

  seatbeltTest("task scratch and artifacts writes remain allowed under audit protection", async () => {
    const fixture = await createFixture();
    try {
      const result = await runSandboxed(
        fixture,
        [
          "mkdir -p workspace/tasks/TASK-M1-SPIKE/scratch workspace/tasks/TASK-M1-SPIKE/artifacts",
          "printf scratch > workspace/tasks/TASK-M1-SPIKE/scratch/out.txt",
          "printf artifact > workspace/tasks/TASK-M1-SPIKE/artifacts/out.txt"
        ].join("; ")
      );

      expect(result.success).toBe(true);
      expect(
        await readFile(
          join(fixture.workspaceRoot, "tasks", "TASK-M1-SPIKE", "scratch", "out.txt"),
          "utf8"
        )
      ).toBe("scratch");
      expect(
        await readFile(
          join(fixture.workspaceRoot, "tasks", "TASK-M1-SPIKE", "artifacts", "out.txt"),
          "utf8"
        )
      ).toBe("artifact");
      const rows = await readAuditRows(fixture.root);
      expect(rows.at(-1)).toMatchObject({
        event: "tool.completed",
        decision: "allowed"
      });
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

  seatbeltTest("profileRoot under workspace tasks is allowed outside the audit file", async () => {
    const fixture = await createFixture();
    try {
      const beforeRawEntries = await sortedRawEntries(fixture.rawRoot);
      const result = await runSandboxed(fixture, "printf ok > workspace/profile-task-ok.txt", {
        profileRoot: join(fixture.root, "workspace", "tasks", "TASK-M1-SPIKE", "scratch", "profiles")
      });

      expect(result.success).toBe(true);
      expect(await readFile(join(fixture.workspaceRoot, "profile-task-ok.txt"), "utf8")).toBe(
        "ok"
      );
      expect(await sortedRawEntries(fixture.rawRoot)).toEqual(beforeRawEntries);
    } finally {
      await fixture.cleanup();
    }
  });

  seatbeltTest("tempRoot under workspace tasks is allowed outside the audit file", async () => {
    const fixture = await createFixture();
    try {
      const beforeRawEntries = await sortedRawEntries(fixture.rawRoot);
      const result = await runSandboxed(fixture, "printf ok > workspace/temp-task-ok.txt", {
        tempRoot: join(fixture.root, "workspace", "tasks", "TASK-M1-SPIKE", "scratch", "tmp")
      });

      expect(result.success).toBe(true);
      expect(await readFile(join(fixture.workspaceRoot, "temp-task-ok.txt"), "utf8")).toBe("ok");
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
    },
    {
      name: "exit-zero masked dynamic raw write",
      target: "masked-exit-zero.txt",
      command: () =>
        'd=data; r=raw; p="$d/$r/masked-exit-zero.txt"; printf masked > "$p" 2>/dev/null; exit 0'
    },
    {
      name: "colon masked dynamic raw write",
      target: "masked-colon.txt",
      command: () =>
        'd=data; r=raw; p="$d/$r/masked-colon.txt"; printf masked > "$p" 2>/dev/null || :'
    },
    {
      name: "stderr-before-raw-redirection dynamic raw write",
      target: "stderr-before-raw.txt",
      command: () =>
        'd=data; r=raw; p="$d/$r/stderr-before-raw.txt"; printf masked 2>/dev/null > "$p"'
    }
  ];

  for (const suppressedCase of suppressedCases) {
    seatbeltTest(`${suppressedCase.name} is pre-denied instead of being swallowed`, async () => {
      const fixture = await createFixture();
      try {
        const result = await runSandboxed(fixture, suppressedCase.command(fixture), {
          enableAdvisory: false
        });

        const payload = expectDeniedPayload(result, "denied_by_advisory");
        expect(payload.reason).toContain("hide sandbox denial");
        await expectMissing(join(fixture.rawRoot, suppressedCase.target));
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

      expectAuditReservationFailure(result);
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

      expectAuditReservationFailure(result);
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

      expectAuditReservationFailure(result);
      expect(await sortedRawEntries(fixture.rawRoot)).toEqual(beforeRawEntries);
    } finally {
      await fixture.cleanup();
    }
  });

  test("stale audit file symlink fails closed before bash side effects", async () => {
    const fixture = await createFixture();
    try {
      const rawInput = join(fixture.rawRoot, "input.csv");
      const beforeRaw = await readFile(rawInput, "utf8");
      const auditDir = await createAuditDir(fixture.root);
      await symlink(rawInput, join(auditDir, "policy-gate.ndjson"));

      const result = await runSandboxed(
        fixture,
        "printf side-effect > workspace/stale-symlink-side-effect.txt; printf nope > data/raw/stale-symlink.txt"
      );

      expectAuditReservationFailure(result);
      expect(await readFile(rawInput, "utf8")).toBe(beforeRaw);
      await expectMissing(join(fixture.rawRoot, "stale-symlink.txt"));
      await expectMissing(join(fixture.workspaceRoot, "stale-symlink-side-effect.txt"));
    } finally {
      await fixture.cleanup();
    }
  });

  test("stale audit file hardlink fails closed before bash side effects", async () => {
    const fixture = await createFixture();
    try {
      const rawInput = join(fixture.rawRoot, "input.csv");
      const beforeRaw = await readFile(rawInput, "utf8");
      const auditDir = await createAuditDir(fixture.root);
      await link(rawInput, join(auditDir, "policy-gate.ndjson"));

      const result = await runSandboxed(
        fixture,
        "printf side-effect > workspace/stale-hardlink-side-effect.txt; printf nope > data/raw/stale-hardlink.txt"
      );

      expectAuditReservationFailure(result);
      expect(await readFile(rawInput, "utf8")).toBe(beforeRaw);
      await expectMissing(join(fixture.rawRoot, "stale-hardlink.txt"));
      await expectMissing(join(fixture.workspaceRoot, "stale-hardlink-side-effect.txt"));
    } finally {
      await fixture.cleanup();
    }
  });

  test("non-writable regular audit file fails closed before bash side effects", async () => {
    const fixture = await createFixture();
    const auditFile = join(
      fixture.root,
      "workspace",
      "tasks",
      "TASK-M1-SPIKE",
      "audit",
      "policy-gate.ndjson"
    );
    try {
      await createAuditDir(fixture.root);
      await writeFile(auditFile, "", { mode: 0o400 });
      await chmod(auditFile, 0o400);

      await expect(
        appendPolicyGateAuditRow({
          workspaceRoot: fixture.root,
          protectedRawPaths: [fixture.rawRoot],
          row: minimalAuditRow()
        })
      ).rejects.toThrow();

      const result = await runSandboxed(
        fixture,
        "printf side-effect > workspace/non-writable-audit-side-effect.txt; printf nope > data/raw/non-writable-audit.txt",
        { enableAdvisory: false }
      );

      expectAuditReservationFailure(result);
      await expectMissing(join(fixture.workspaceRoot, "non-writable-audit-side-effect.txt"));
      await expectMissing(join(fixture.rawRoot, "non-writable-audit.txt"));
    } finally {
      await chmod(auditFile, 0o600).catch(() => {});
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

  seatbeltTest("sandbox command moving audit ancestor is denied before audit identity can drift", async () => {
    const fixture = await createFixture();
    try {
      const result = await runSandboxed(
        fixture,
        "mv workspace/tasks workspace/tasks.moved; mkdir -p workspace/tasks/TASK-M1-SPIKE/audit; printf forged > workspace/tasks/TASK-M1-SPIKE/audit/policy-gate.ndjson; printf nope > data/raw/audit-ancestor.txt",
        { enableAdvisory: false }
      );

      const payload = expectDeniedPayload(result, "denied_by_sandbox");
      await expectMissing(join(fixture.rawRoot, "audit-ancestor.txt"));
      await expectMissing(join(fixture.workspaceRoot, "tasks.moved"));
      const rows = await readAuditRows(fixture.root);
      expectAuditMatchesPayload(rows.at(-1), payload);
    } finally {
      await fixture.cleanup();
    }
  });

  seatbeltTest("allowed command cannot move audit ancestor or lose canonical audit", async () => {
    const fixture = await createFixture();
    try {
      const result = await runSandboxed(
        fixture,
        "mv workspace/tasks workspace/tasks.moved; mkdir -p workspace/tasks/TASK-M1-SPIKE/audit; true",
        { enableAdvisory: false }
      );

      expect(result.success).toBe(true);
      await expectMissing(join(fixture.workspaceRoot, "tasks.moved"));
      const rows = await readAuditRows(fixture.root);
      expect(rows.at(-1)).toMatchObject({
        event: "tool.completed",
        decision: "allowed"
      });
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

  test("audit root resolves project-root fixtures and canonical workspace roots", async () => {
    const fixture = await createFixture();
    try {
      const canonicalWorkspaceRoot = await realpath(fixture.workspaceRoot);
      const projectRootAuditPath = await appendPolicyGateAuditRow({
        workspaceRoot: fixture.root,
        protectedRawPaths: [fixture.rawRoot],
        fileName: "project-root.ndjson",
        row: minimalAuditRow()
      });
      const canonicalWorkspaceAuditPath = await appendPolicyGateAuditRow({
        workspaceRoot: fixture.workspaceRoot,
        protectedRawPaths: [fixture.rawRoot],
        fileName: "canonical-workspace.ndjson",
        row: minimalAuditRow()
      });

      expect(projectRootAuditPath).toBe(
        join(
          canonicalWorkspaceRoot,
          "tasks",
          "TASK-M1-SPIKE",
          "audit",
          "project-root.ndjson"
        )
      );
      expect(canonicalWorkspaceAuditPath).toBe(
        join(
          canonicalWorkspaceRoot,
          "tasks",
          "TASK-M1-SPIKE",
          "audit",
          "canonical-workspace.ndjson"
        )
      );
      expect(canonicalWorkspaceAuditPath).not.toContain("workspace/workspace");
      expect(await readFile(projectRootAuditPath, "utf8")).toContain("denied_by_advisory");
      expect(await readFile(canonicalWorkspaceAuditPath, "utf8")).toContain(
        "denied_by_advisory"
      );
    } finally {
      await fixture.cleanup();
    }
  });

  test("fresh project root with data/raw but no workspace writes audit under workspace/tasks", async () => {
    const root = await mkdtemp(join(tmpdir(), "shud-raw-fresh-project-"));
    try {
      const rawRoot = join(root, "data", "raw");
      await mkdir(rawRoot, { recursive: true });
      await writeFile(join(rawRoot, "input.csv"), "raw,input\n", "utf8");

      const auditPath = await appendPolicyGateAuditRow({
        workspaceRoot: root,
        protectedRawPaths: [rawRoot],
        fileName: "fresh-project.ndjson",
        row: minimalAuditRow()
      });

      const canonicalRoot = await realpath(root);
      expect(auditPath).toBe(
        join(canonicalRoot, "workspace", "tasks", "TASK-M1-SPIKE", "audit", "fresh-project.ndjson")
      );
      expect(await readFile(auditPath, "utf8")).toContain("denied_by_advisory");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  seatbeltTest("sandboxed bash writes audit rows under canonical workspace root", async () => {
    const fixture = await createFixture();
    try {
      const result = await runSandboxed(
        fixture,
        "printf ok > workspace/canonical-audit-root.txt",
        { auditWorkspaceRoot: fixture.workspaceRoot }
      );

      expect(result.success).toBe(true);
      const rows = await readAuditRowsFromWorkspaceRoot(fixture.workspaceRoot);
      expect(rows.at(-1)).toMatchObject({
        event: "tool.completed",
        decision: "allowed"
      });
      await expectMissing(
        join(
          fixture.workspaceRoot,
          "workspace",
          "tasks",
          "TASK-M1-SPIKE",
          "audit",
          "policy-gate.ndjson"
        )
      );
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
          protectedRawPaths: [fixture.rawRoot],
          taskId: "..",
          row: minimalAuditRow()
        })
      ).rejects.toThrow("Invalid audit task id");
      await expect(
        appendPolicyGateAuditRow({
          workspaceRoot: fixture.root,
          protectedRawPaths: [fixture.rawRoot],
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

  seatbeltTest("large benign command inside advisory scan budget still runs under OS authority", async () => {
    const fixture = await createFixture();
    try {
      const filler = "x".repeat(60_000);
      const startedAt = Date.now();
      const result = await runSandboxed(
        fixture,
        `printf ok > workspace/large-benign.txt # ${filler}`,
        { timeout: 30_000 }
      );

      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(result.success).toBe(true);
      expect(await readFile(join(fixture.workspaceRoot, "large-benign.txt"), "utf8")).toBe("ok");
      const rows = await readAuditRows(fixture.root);
      expect(rows.at(-1)).toMatchObject({
        event: "tool.completed",
        decision: "allowed"
      });
    } finally {
      await fixture.cleanup();
    }
  });

  seatbeltTest("over-budget legal raw read and workspace write are not pre-denied", async () => {
    const fixture = await createFixture();
    try {
      const filler = "x".repeat(140_000);
      const startedAt = Date.now();
      const rawRead = await runSandboxed(
        fixture,
        `cat data/raw/input.csv > workspace/over-budget-raw-read.txt # ${filler}`,
        { enableAdvisory: false }
      );
      const workspaceWrite = await runSandboxed(
        fixture,
        `printf ok > workspace/over-budget-workspace-write.txt 2>/dev/null; true # ${filler}`,
        { enableAdvisory: false }
      );

      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(rawRead.success).toBe(true);
      expect(workspaceWrite.success).toBe(true);
      expect(await readFile(join(fixture.workspaceRoot, "over-budget-raw-read.txt"), "utf8")).toBe(
        "raw,input\n"
      );
      expect(
        await readFile(join(fixture.workspaceRoot, "over-budget-workspace-write.txt"), "utf8")
      ).toBe("ok");
      const rows = await readAuditRows(fixture.root);
      expect(rows.at(-1)).toMatchObject({
        event: "tool.completed",
        decision: "allowed"
      });
    } finally {
      await fixture.cleanup();
    }
  });

  test("audit append rejects missing protected roots without mutating raw workspace root", async () => {
    const fixture = await createFixture();
    try {
      const beforeRawEntries = await sortedRawEntries(fixture.rawRoot);
      await expect(
        appendPolicyGateAuditRow({
          workspaceRoot: fixture.rawRoot,
          row: minimalAuditRow()
        } as Parameters<typeof appendPolicyGateAuditRow>[0])
      ).rejects.toThrow("protectedRawPaths is required");
      expect(await sortedRawEntries(fixture.rawRoot)).toEqual(beforeRawEntries);
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
          protectedRawPaths: [dirFixture.rawRoot],
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
          protectedRawPaths: [fileFixture.rawRoot],
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
          protectedRawPaths: [fixture.rawRoot],
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
    auditTaskId?: string;
    profileRoot?: string;
    tempRoot?: string;
    context?: ToolContext;
    timeout?: number;
  } = {}
): Promise<ToolResult> {
  const tool = new RawDataSandboxedBashTool({
    protectedRawPaths: [fixture.rawRoot],
    allowedWriteRoots: [fixture.root],
    tempRoot: options.tempRoot ?? fixture.tempRoot,
    profileRoot: options.profileRoot ?? fixture.profileRoot,
    enableAdvisory: options.enableAdvisory,
    auditWorkspaceRoot: options.auditWorkspaceRoot,
    auditTaskId: options.auditTaskId,
    fuseRules: options.fuseRules ?? []
  });

  return tool.run(options.context ?? fixture.context, {
    command,
    timeout: options.timeout ?? 30_000
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
  expect(payload.error_record.remediation?.hint).toContain("data/raw");
  expect(payload.error_record.remediation?.ref).toContain("policy-gate-spike");
  return payload;
}

function expectAuditReservationFailure(result: ToolResult): void {
  expect(result.success).toBe(false);
  const payload = JSON.parse(result.output) as {
    error?: string;
    rule?: string;
    remediation?: {
      next_action?: string;
      hint?: string;
      ref?: string;
    };
  };
  expect(payload.error).toBe("policy_gate_audit_unavailable");
  expect(payload.rule).toBe(RAW_DATA_WRITE_RULE_ID);
  expect(payload.remediation?.next_action).toBe("fix_and_retry");
  expect(payload.remediation?.hint).toContain("audit path");
  expect(payload.remediation?.ref).toContain("policy-gate-spike");
}

function expectProcessContainmentFailure(result: ToolResult): void {
  expect(result.success).toBe(false);
  const payload = JSON.parse(result.output) as {
    error?: string;
    rule?: string;
    remediation?: {
      next_action?: string;
      hint?: string;
      ref?: string;
    };
  };
  expect(payload.error).toBe("policy_gate_process_containment_unavailable");
  expect(payload.rule).toBe(RAW_DATA_WRITE_RULE_ID);
  expect(payload.remediation?.next_action).toBe("fix_and_retry");
  expect(payload.remediation?.hint).toContain("foreground");
  expect(payload.remediation?.ref).toContain("policy-gate-spike");
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
  return readAuditRowsFromWorkspaceRoot(join(root, "workspace"));
}

async function readAuditRowsFromWorkspaceRoot(workspaceRoot: string): Promise<PolicyGateAuditRow[]> {
  const auditFile = join(
    workspaceRoot,
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

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function commandExistsSync(command: string): boolean {
  return (process.env.PATH ?? "")
    .split(":")
    .filter(Boolean)
    .some((dir) => existsSync(join(dir, command)));
}

class TestRunningToolRegistry implements RunningToolRegistry {
  private readonly handles = new Map<string, TestRunningToolHandle>();

  register(entry: {
    toolUseId: string;
    toolName: string;
    abortable: boolean;
  }): RunningToolHandle {
    const handle = new TestRunningToolHandle(entry);
    this.handles.set(entry.toolUseId, handle);
    return handle;
  }

  get(toolUseId: string): RunningToolHandle | undefined {
    return this.handles.get(toolUseId);
  }
}

class TestRunningToolHandle implements RunningToolHandle {
  readonly toolUseId: string;
  readonly toolName: string;
  readonly abortable: boolean;

  private state: "running" | "abort_requested" | "finished" = "running";
  private abortReason: string | undefined;
  private abortHandler: ((reason?: string) => void) | undefined;
  private terminalMetadata: RunningToolTerminalMetadata | undefined;

  constructor(entry: { toolUseId: string; toolName: string; abortable: boolean }) {
    this.toolUseId = entry.toolUseId;
    this.toolName = entry.toolName;
    this.abortable = entry.abortable;
  }

  getState(): "running" | "abort_requested" | "finished" {
    return this.state;
  }

  getAbortReason(): string | undefined {
    return this.abortReason;
  }

  getTerminalMetadata(): RunningToolTerminalMetadata | undefined {
    return this.terminalMetadata;
  }

  requestAbort(reason?: string): "accepted" | "already_requested" | "already_finished" | "not_abortable" {
    if (!this.abortable) {
      return "not_abortable";
    }
    if (this.state === "finished") {
      return "already_finished";
    }
    if (this.state === "abort_requested") {
      return "already_requested";
    }
    this.state = "abort_requested";
    this.abortReason = reason;
    this.abortHandler?.(reason);
    return "accepted";
  }

  setAbortHandler(handler: (reason?: string) => void): void {
    this.abortHandler = handler;
  }

  markFinished(metadata: RunningToolTerminalMetadata): boolean {
    if (this.state === "finished") {
      return false;
    }
    this.state = "finished";
    this.terminalMetadata = metadata;
    return true;
  }
}

const testLogger: ToolLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {}
};
