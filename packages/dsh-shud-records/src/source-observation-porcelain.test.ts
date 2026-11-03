import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { observeSourceChanges } from "./index.ts";
import { realGit, sourceRepo } from "./source-observation-test-harness.ts";

let root: string;
let repo: string;
let diffMarker: string;
const privatePayload = "private-malformed-porcelain-payload-528";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "source-porcelain-"));
  repo = sourceRepo(root);
  diffMarker = join(root, "diff-called");
  vi.stubEnv("HOME", root);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function controlledGit(
  status: Uint8Array,
  mode: "normal" | "status-error" | "diff-error" | "overflow" = "normal",
): void {
  const bin = join(root, "bin");
  mkdirSync(bin);
  const statusPath = join(root, "status.bin");
  writeFileSync(statusPath, status);
  // Inject malformed external-protocol responses at the executable boundary. Core runGit remains real.
  // Root validation still executes real Git. No assertions echo requested argv back as a result.
  writeFileSync(
    join(bin, "git"),
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const mode = ${JSON.stringify(mode)};
if (args.includes("status")) {
  if (mode === "status-error") {
    process.stdout.write(${JSON.stringify(privatePayload)});
    process.stderr.write("controlled status failure");
    process.exitCode = 23;
  } else if (mode === "overflow") {
    process.stdout.write(Buffer.alloc(64 * 1024 * 1024 + 1, 120));
  } else process.stdout.write(fs.readFileSync(${JSON.stringify(statusPath)}));
} else if (args.includes("diff")) {
  fs.writeFileSync(${JSON.stringify(diffMarker)}, "called");
  if (mode === "diff-error") {
    process.stdout.write(${JSON.stringify(privatePayload)});
    process.stderr.write("controlled diff failure");
    process.exitCode = 24;
  } else process.stdout.write(Buffer.from([0, 255, 13, 10, 97]));
} else {
  const child = require("node:child_process").spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit" });
  process.exitCode = child.status === null ? 125 : child.status;
}
`,
    { mode: 0o755 },
  );
  vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH ?? ""}`);
}

describe("observeSourceChanges porcelain protocol failures", () => {
  test.each([
    { label: "missing NUL terminator", bytes: Buffer.from(" M model.cpp") },
    { label: "truncated XY", bytes: Buffer.from("M\0") },
    { label: "missing space separator", bytes: Buffer.from(" M:model.cpp\0") },
    { label: "missing path", bytes: Buffer.from(" M \0") },
    { label: "empty record", bytes: Buffer.from("\0") },
    { label: "extra empty trailing record", bytes: Buffer.from(" M model.cpp\0\0") },
    { label: "duplicate path", bytes: Buffer.from(" M model.cpp\0M  model.cpp\0") },
    { label: "absolute path", bytes: Buffer.from(" M /outside.cpp\0") },
    { label: "parent traversal", bytes: Buffer.from(" M src/../outside.cpp\0") },
    { label: "orphan NUL path suffix", bytes: Buffer.from(" M model.cpp\0suffix.cpp\0") },
    { label: "invalid UTF8", bytes: Buffer.from([32, 77, 32, 0xff, 0]) },
    { label: "overlong UTF8", bytes: Buffer.from([32, 77, 32, 0xc0, 0xaf, 0]) },
    { label: "truncated UTF8 scalar", bytes: Buffer.from([32, 77, 32, 0xe2, 0x82, 0]) },
    { label: "UTF8 encoded surrogate", bytes: Buffer.from([32, 77, 32, 0xed, 0xa0, 0x80, 0]) },
    { label: "rename missing source", bytes: Buffer.from("R  renamed.cpp\0") },
    { label: "copy empty source", bytes: Buffer.from("C  copied.cpp\0\0") },
    { label: "rename unterminated source", bytes: Buffer.from("R  renamed.cpp\0model.cpp") },
    {
      label: "rename invalid source UTF8",
      bytes: Buffer.concat([Buffer.from("R  renamed.cpp\0"), Buffer.from([0xff, 0])]),
    },
  ])("rejects $label instead of guessing or dropping records", async ({ bytes }) => {
    controlledGit(bytes);
    await expect(observeSourceChanges(repo)).rejects.toThrow();
    expect(existsSync(diffMarker)).toBe(false);
  });

  test.each([
    "??",
    "A ",
    " A",
    "AM",
    "D ",
    " D",
    "MD",
    "UU",
    "AA",
    "DD",
    "AU",
    "UD",
    "UA",
    "DU",
    "T ",
    " T",
    "!!",
    "X ",
    " X",
    "  ",
  ])("rejects unsupported XY %j and names the involved path", async (xy) => {
    controlledGit(Buffer.from(`${xy} model.cpp\0`));
    await expect(observeSourceChanges(repo)).rejects.toThrow("model.cpp");
    expect(existsSync(diffMarker)).toBe(false);
  });

  test.each(["R ", " R", "C ", " C"])(
    "consumes both %j paths and reports both without diff",
    async (xy) => {
      controlledGit(Buffer.from(`${xy} destination.cpp\0source.cpp\0 M model.cpp\0`));
      const error: unknown = await observeSourceChanges(repo).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("destination.cpp");
      expect((error as Error).message).toContain("source.cpp");
      expect(existsSync(diffMarker)).toBe(false);
    },
  );

  test("does not expose unframed stdout or a parser cause in diagnostics", async () => {
    controlledGit(Buffer.from(`M${privatePayload}`));
    const error: unknown = await observeSourceChanges(repo).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(inspect(error, { depth: null })).not.toContain(privatePayload);
    expect((error as Error).cause).toBeUndefined();
    expect(existsSync(diffMarker)).toBe(false);
  });

  test.each([
    { mode: "status-error", code: "23", detail: "controlled status failure", diff: false },
    { mode: "diff-error", code: "24", detail: "controlled diff failure", diff: true },
  ] as const)(
    "preserves the runner's controlled $mode without returning partial stdout",
    async ({ mode, code, detail, diff }) => {
      controlledGit(Buffer.from(" M model.cpp\0"), mode);
      const error: unknown = await observeSourceChanges(repo).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(code);
      expect((error as Error).message).toContain(detail);
      expect((error as Error).cause).toBeUndefined();
      expect(inspect(error, { depth: null })).not.toContain(privatePayload);
      expect(existsSync(diffMarker)).toBe(diff);
    },
  );

  test("does not turn a runner buffer overflow into truncated successful observation", async () => {
    controlledGit(Buffer.alloc(0), "overflow");
    await expect(observeSourceChanges(repo)).rejects.toThrow(/MAXBUFFER|buffer|overflow/iu);
    expect(existsSync(diffMarker)).toBe(false);
  });
});
