import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { decideRawAccess, normalizeRawDirs } from "./decide.ts";

let cwd: string;
let entries: string[];
beforeEach(() => {
  cwd = realpathSync.native(mkdtempSync(join(tmpdir(), "raw-dispatch-")));
  for (const root of ["protected", "changes", "builds", "repos/SHUD"]) {
    mkdirSync(join(cwd, root), { recursive: true });
  }
  entries = readdirSync(cwd, { recursive: true }).sort();
});
afterEach(() => {
  try {
    expect(readdirSync(cwd, { recursive: true }).sort()).toEqual(entries);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// Exercise the real public decider with a direct call envelope. The adapter's
// fieldsOf reads execution.arguments first; this does not claim runtime/LLM
// reachability for throwing envelope getters. No tool executes or writes files.
function observedCall(name: string, readArguments: () => unknown) {
  let reads = 0;
  return {
    call: {
      name,
      cwd,
      get arguments(): unknown {
        reads++;
        return readArguments();
      },
    },
    reads: () => reads,
  };
}

const next = { kind: "next", code: "unrelated" };
const rawDeny = { kind: "deny", code: "raw-immutable" };
const governanceDeny = { kind: "deny", code: "governance-immutable" };
const rawAsk = { kind: "ask", code: "raw-read-provenance" };

// Counts distinguish the known branch's own extraction from irrelevant fallback
// reads: change_submit owns one caught read; shud_build needs only fixed roots.
test.each([
  ["unrelated", 0],
  ["shud_build", 0],
  ["change_submit", 1],
] as const)("%s delegates with unavailable arguments and only %i owned reads", (name, reads) => {
  const observed = observedCall(name, () => {
    throw new Error("unavailable arguments");
  });
  expect(decideRawAccess(observed.call, normalizeRawDirs({ rawDirs: ["protected"] }))).toEqual(
    next,
  );
  expect(observed.reads()).toBe(reads);
});

test.each([
  ["shud_build", "builds", 0],
  ["shud_build", "repos/SHUD", 0],
  ["change_submit", "changes", 1],
] as const)("%s still denies protected %s with %i owned argument reads", (name, root, reads) => {
  const observed = observedCall(name, () => {
    throw new Error("unavailable arguments");
  });
  expect(decideRawAccess(observed.call, normalizeRawDirs({ rawDirs: [root] }))).toMatchObject(
    rawDeny,
  );
  expect(observed.reads()).toBe(reads);
});

test.each([
  "unrelated",
  "read",
  "run_code",
  "present",
  "Write",
  "BASH",
  "shud_build",
  "change_submit",
])("%s does not become a file or shell tool because of payload field names", (name) => {
  for (const root of ["protected", "changes"]) {
    const args = { file_path: root, path: root, command: `rm ${root}`, workdir: root };
    expect(
      decideRawAccess({ name, arguments: args, cwd }, normalizeRawDirs({ rawDirs: ["protected"] })),
    ).toEqual(next);
  }
});

const mutations = [
  ["write", { file_path: "changes" }],
  ["edit", { file_path: "changes" }],
  ["str_replace_editor", { path: "changes", command: "create" }],
  ["bash", { command: "touch changes" }],
  ["pwsh", { command: "Set-Content changes '{}'" }],
] as const;

test.each(mutations)(
  "%s retains raw denial before governance without a fallback read",
  (name, args) => {
    const observed = observedCall(name, () => args);
    expect(
      decideRawAccess(observed.call, normalizeRawDirs({ rawDirs: ["changes"] })),
    ).toMatchObject(rawDeny);
    expect(observed.reads()).toBe(1);
  },
);

test.each(mutations)("%s still reaches governance after raw delegation", (name, args) => {
  expect(
    decideRawAccess({ name, arguments: args, cwd }, normalizeRawDirs({ rawDirs: ["protected"] })),
  ).toMatchObject(governanceDeny);
});

test.each([
  ["bash", "cat changes"],
  ["pwsh", "Get-Content changes"],
])(
  "%s retains raw read approval before governance and delegates governance-only reads",
  (name, command) => {
    const observed = observedCall(name, () => ({ command }));
    expect(
      decideRawAccess(observed.call, normalizeRawDirs({ rawDirs: ["changes"] })),
    ).toMatchObject(rawAsk);
    expect(observed.reads()).toBe(1);
    expect(
      decideRawAccess(
        { name, arguments: { command }, cwd },
        normalizeRawDirs({ rawDirs: ["protected"] }),
      ),
    ).toEqual(next);
  },
);

// Admission must not swallow errors from an actual supported tool. Existing
// view/workdir, parsing, path-identity and case matrices remain in their suites.
test.each(["write", "edit", "str_replace_editor", "bash", "pwsh"])(
  "%s retains argument-access and native path failures",
  (name) => {
    const failure = new Error("unavailable supported arguments");
    const observed = observedCall(name, () => {
      throw failure;
    });
    const options = normalizeRawDirs({ rawDirs: ["protected"] });
    expect(() => decideRawAccess(observed.call, options)).toThrow(failure);
    expect(observed.reads()).toBe(1);
    const args = { file_path: "\0", path: "\0", command: "touch changes", workdir: "\0" };
    expect(() => decideRawAccess({ name, arguments: args, cwd }, options)).toThrow(TypeError);
  },
);
