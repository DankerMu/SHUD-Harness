import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { decideRawAccess, normalizeRawDirs } from "./decide.ts";

const fixedRoots = [
  ["RUNS", "runs"],
  ["STACKS", "stacks"],
  ["PROVENANCE", "provenance"],
] as const;
let root: string;
let cwd: string;
let input: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "raw-missing-path-case-"));
  cwd = join(root, "workspace");
  input = join(root, "ordinary-input");
  mkdirSync(cwd);
  mkdirSync(input);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function snapshot() {
  return {
    entries: readdirSync(root, { recursive: true }).sort(),
    directories: [root, cwd, input].map((path) => {
      const { dev, ino, mode, mtimeNs, ctimeNs } = lstatSync(path, { bigint: true });
      return { dev, ino, mode, mtimeNs, ctimeNs };
    }),
  };
}

function decideWithoutWrites(raw: string) {
  for (const spelling of fixedRoots.flat()) {
    expect(lstatSync(join(cwd, spelling), { throwIfNoEntry: false })).toBeUndefined();
  }
  const before = snapshot();
  try {
    return decideRawAccess(
      { name: "shud_run", arguments: { input_dir: input, project: "tiny" }, cwd },
      normalizeRawDirs({ rawDirs: [raw] }),
    );
  } finally {
    // Directory timestamps also catch probe files created and then removed.
    expect(snapshot()).toEqual(before);
    for (const spelling of fixedRoots.flat()) {
      expect(lstatSync(join(cwd, spelling), { throwIfNoEntry: false })).toBeUndefined();
    }
  }
}

test.each(fixedRoots)(
  "absent raw %s versus output %s follows independently observed namespace sensitivity",
  (raw) => {
    // Only this unrelated fixture marker is created, never a protected/output root.
    const marker = join(cwd, "marker");
    const bytes = "independent namespace marker\n";
    writeFileSync(marker, bytes, { flag: "wx" });
    const original = lstatSync(marker);
    const alternate = lstatSync(join(cwd, "MARKER"), { throwIfNoEntry: false });
    expect(original.isFile()).toBe(true);
    if (alternate) {
      expect(alternate.isFile()).toBe(true);
      expect(alternate.dev).toBe(original.dev);
      expect(alternate.ino).toBe(original.ino);
    }
    expect(readdirSync(cwd)).toEqual(["marker"]);

    const decision = decideWithoutWrites(raw);
    expect(readFileSync(marker, "utf8")).toBe(bytes);
    if (alternate) {
      expect(decision).toMatchObject({ kind: "deny", code: "raw-immutable" });
      expect(decision.reason).toMatch(/immutable/u);
    } else {
      expect(decision).toEqual({ kind: "next", code: "unrelated" });
    }
  },
);

test("an empty workspace denies an unproved missing case overlap without approval", () => {
  expect(readdirSync(cwd)).toEqual([]);
  const decision = decideWithoutWrites("RUNS");
  expect(decision.kind).toBe("deny");
  expect(decision.code).toMatch(/^raw-[a-z-]+$/u);
  expect(decision.reason).toMatch(/unavailable/iu);
  expect(decision.reason).not.toContain(root);
  expect(readdirSync(cwd)).toEqual([]);
});

test.each(fixedRoots)(
  "empty namespace keeps ordinary containment and sibling boundaries for %s/%s",
  (_raw, output) => {
    expect(decideWithoutWrites(output)).toMatchObject({ kind: "deny", code: "raw-immutable" });
    expect(decideWithoutWrites(`${output}x`)).toEqual({ kind: "next", code: "unrelated" });
  },
);
