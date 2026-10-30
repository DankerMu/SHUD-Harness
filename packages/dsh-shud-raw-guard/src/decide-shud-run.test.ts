import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import type { PreToolDecision, ToolExecution } from "@deepseek-ai/dsh-tools";
import { afterAll, expect, test, vi } from "vitest";
import { decideRawAccess, normalizeRawDirs, RAW_READ_PROVENANCE_REASON } from "./decide.ts";
import { apply } from "./index.ts";

const cwd = mkdtempSync(join(tmpdir(), "shud-guard-run-"));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

test("shud_run denies an absent runs directory configured as raw", () => {
  mkdirSync(join(cwd, "input", "ccw"), { recursive: true });
  const runs = join(cwd, "runs");
  expect(existsSync(runs)).toBe(false);

  const decision = decideRawAccess(
    { name: "shud_run", arguments: { input_dir: "input/ccw" }, cwd },
    normalizeRawDirs({ rawDirs: ["runs"] }),
  );

  expect(existsSync(runs)).toBe(false);
  expect(decision.kind).toBe("deny");
  expect(decision.code).toBe("raw-immutable");
  expect(decision.reason).toMatch(/immutable/);
});

test("shud_run asks for provenance approval when input is under raw and runs is outside raw", () => {
  mkdirSync(join(cwd, "prot", "ccw"), { recursive: true });

  const decision = decideRawAccess(
    { name: "shud_run", arguments: { input_dir: "prot/ccw" }, cwd },
    normalizeRawDirs({ rawDirs: ["prot"] }),
  );

  expect(decision.kind).toBe("ask");
  expect(decision.code).toBe("raw-read-provenance");
  expect(decision.reason).toBe(RAW_READ_PROVENANCE_REASON);
});

const boundary = mkdtempSync(join(tmpdir(), "shud-guard-run-boundary-"));
afterAll(() => rmSync(boundary, { recursive: true, force: true }));
for (const dir of [
  "prot/ccw",
  "prot/deep",
  "prot/sub",
  "prot/out",
  "protx/ccw",
  "safe/ccw",
  "safe/deep",
  "safe/out",
  "output-in",
  "output-out",
  "output-equal",
  "output-prefix",
  "output-loop",
  "existing/runs",
]) {
  mkdirSync(join(boundary, dir), { recursive: true });
}
for (const [link, target] of [
  ["input-in", "prot/ccw"],
  ["input-out", "safe/ccw"],
  ["raw-deep", "prot/deep"],
  ["safe-deep", "safe/deep"],
  ["session", "."],
  ["output-in/runs", "prot/out"],
  ["output-out/runs", "safe/out"],
  ["output-equal/runs", "prot"],
  ["output-prefix/runs", "protx"],
  ["output-loop/runs", "output-loop/runs"],
  ["loop", "loop"],
]) {
  symlinkSync(join(boundary, target), join(boundary, link));
}
const raw = join(boundary, "prot");
function run(args: unknown, rawDirs = [raw], sessionCwd = boundary) {
  return decideRawAccess(
    { name: "shud_run", arguments: args, cwd: sessionCwd },
    normalizeRawDirs({ rawDirs }),
  );
}

test.each([
  ["input equals raw", "prot", boundary, [raw], "ask"],
  ["input sibling prefix", "protx/ccw", boundary, [raw], "next"],
  ["unrelated input", "safe/ccw", boundary, [raw], "next"],
  ["missing raw input descendants", "prot/missing/deep", boundary, [raw], "ask"],
  ["missing safe input descendants", "safe/missing/deep", boundary, [raw], "next"],
  ["session below raw", join(boundary, "safe/ccw"), join(raw, "sub"), [raw], "deny"],
  [
    "absent session below raw",
    join(boundary, "safe/ccw"),
    join(raw, "missing/deep"),
    [raw],
    "deny",
  ],
  ["session sibling prefix", "ccw", join(boundary, "protx"), [raw], "next"],
  ["existing output equals raw", "input", join(boundary, "existing"), ["runs"], "deny"],
  ["existing output sibling prefix", "input", join(boundary, "existing"), ["runsx"], "next"],
  ["missing output sibling prefix", "safe/ccw", boundary, ["runsx"], "next"],
  ["normalized output root", "safe/ccw", boundary, ["././runs/"], "deny"],
  ["normalized input root", "prot/ccw", boundary, ["././prot/"], "ask"],
  ["nested session relative raw root", "../prot/ccw", join(boundary, "safe"), ["../prot"], "ask"],
] as const)("%s", (_label, input_dir, sessionCwd, rawDirs, kind) => {
  const decision = run({ input_dir }, [...rawDirs], sessionCwd);
  expect(decision.kind).toBe(kind);
  if (kind === "deny") {
    expect(decision.code).toBe("raw-immutable");
    expect(decision.reason).toMatch(/immutable/);
  }
  if (kind === "ask") {
    expect(decision.code).toBe("raw-read-provenance");
    expect(decision.reason).toBe(RAW_READ_PROVENANCE_REASON);
  }
  if (kind === "next") expect(decision).toEqual({ kind: "next", code: "unrelated" });
});

test.each([[["prot", "runs"]], [["runs", "prot"]]])(
  "output denial precedes input approval for raw roots %j",
  (rawDirs) => {
    const denied = run({ input_dir: "prot/ccw" }, rawDirs);
    expect(denied).toMatchObject({ kind: "deny", code: "raw-immutable" });
    expect(denied.reason).toMatch(/immutable/);
    expect(
      run(
        { input_dir: "prot/ccw" },
        rawDirs.filter((dir) => dir !== "runs"),
      ),
    ).toMatchObject({
      kind: "ask",
      reason: RAW_READ_PROVENANCE_REASON,
    });
  },
);

test.each([
  ["missing arguments", undefined],
  ["null arguments", null],
  ["array arguments", []],
  ["string arguments", "prot/ccw"],
  ["numeric arguments", 1],
  ["boolean arguments", false],
  ["missing input", {}],
  ["null input", { input_dir: null }],
  ["numeric input", { input_dir: 1 }],
  ["array input", { input_dir: ["prot/ccw"] }],
  ["object input", { input_dir: { path: "prot/ccw" } }],
])("%s still protects output without inventing an input", (_label, args) => {
  expect(run(args, ["runs"])).toMatchObject({ kind: "deny", code: "raw-immutable" });
  expect(run(args)).toEqual({ kind: "next", code: "unrelated" });
  for (const name of ["write", "edit", "bash", "pwsh", "read", "str_replace_editor"]) {
    expect(
      decideRawAccess(
        { name, arguments: args, cwd: boundary },
        normalizeRawDirs({ rawDirs: ["runs"] }),
      ),
    ).toEqual({ kind: "next", code: "unrelated" });
  }
});

test.each([
  ["protected output", "input", join(raw, "sub"), join(boundary, "safe"), "deny"],
  ["protected relative input", "prot/ccw", boundary, join(boundary, "safe"), "ask"],
  ["safe relative input", "ccw", join(boundary, "safe"), raw, "next"],
])("workdir cannot redirect %s", (_label, input_dir, sessionCwd, workdir, kind) => {
  expect(run({ input_dir, workdir }, [raw], sessionCwd).kind).toBe(kind);
});

test.each([
  ["runs link into raw", "safe/ccw", "output-in", "deny"],
  ["runs link equals raw", "safe/ccw", "output-equal", "deny"],
  ["runs link outside raw", "safe/ccw", "output-out", "next"],
  ["runs link to raw sibling prefix", "safe/ccw", "output-prefix", "next"],
  ["input link into raw", "input-in", ".", "ask"],
  ["input link outside raw", "input-out", ".", "next"],
  ["input link with missing suffix", "input-in/missing/deep", ".", "ask"],
  ["outside input link with missing suffix", "input-out/missing/deep", ".", "next"],
  ["input native link traversal into raw", "raw-deep/../ccw", ".", "ask"],
  ["input native link traversal outside raw", "safe-deep/../ccw", ".", "next"],
  ["input parent traversal into raw", "safe/../prot/ccw", ".", "ask"],
  ["input parent traversal outside raw", "prot/../safe/ccw", ".", "next"],
  ["aliased session raw input", "prot/ccw", "session", "ask"],
  ["aliased session safe input", "safe/ccw", "session", "next"],
  ["session native link traversal into raw", "ccw", "raw-deep/..", "deny"],
  ["session native link traversal outside raw", "ccw", "safe-deep/..", "next"],
] as const)("%s", (_label, input_dir, session, kind) => {
  // Do not join the session suffix: link/.. must reach the native resolver intact.
  const decision = run({ input_dir }, [raw], `${boundary}/${session}`);
  expect(decision.kind).toBe(kind);
  if (kind === "deny") expect(decision.code).toBe("raw-immutable");
  if (kind === "ask") expect(decision.reason).toBe(RAW_READ_PROVENANCE_REASON);
});

test("portable session aliases protect absent output with either raw-root spelling", () => {
  const native = realpathSync.native(boundary);
  const alias = join(boundary, "session");
  expect(existsSync(join(native, "runs"))).toBe(false);
  for (const [session, configured] of [
    [alias, native],
    [native, alias],
  ]) {
    expect(run({}, [join(configured, "runs")], session).kind).toBe("deny");
    expect(run({}, [join(configured, "runsx")], session).kind).toBe("next");
  }
  expect(existsSync(join(native, "runs"))).toBe(false);
});

test("native raw-root aliases preserve containment and sibling exclusions", () => {
  const aliasedRaw = `${boundary}/raw-deep/..`;
  expect(run({ input_dir: "prot/ccw" }, [aliasedRaw]).kind).toBe("ask");
  expect(run({ input_dir: "safe/ccw" }, [aliasedRaw]).kind).toBe("next");
  expect(run({}, [aliasedRaw], join(raw, "sub")).kind).toBe("deny");
  expect(run({}, [aliasedRaw], join(boundary, "protx")).kind).toBe("next");
});

test.each([
  ["input", { input_dir: "loop" }, [raw], boundary],
  ["output", {}, [raw], join(boundary, "output-loop")],
  ["raw root", {}, [join(boundary, "loop")], boundary],
] as const)("canonical %s errors remain visible", (_label, args, rawDirs, sessionCwd) => {
  expect(() => run(args, [...rawDirs], sessionCwd)).toThrowError(
    expect.objectContaining({ code: "ELOOP" }),
  );
});

test.runIf(process.platform === "darwin")(
  "Darwin /var and /private/var identify the same raw paths",
  () => {
    const alias = mkdtempSync("/var/tmp/shud-guard-run-alias-");
    try {
      const native = realpathSync.native(alias);
      expect(native).toBe(`/private${alias}`);
      mkdirSync(join(alias, "prot", "ccw"), { recursive: true });
      mkdirSync(join(alias, "protx", "ccw"), { recursive: true });
      for (const [session, configured] of [
        [alias, join(native, "prot")],
        [native, join(alias, "prot")],
      ]) {
        expect(run({ input_dir: "prot/ccw" }, [configured], session).kind).toBe("ask");
        expect(run({ input_dir: "protx/ccw" }, [configured], session).kind).toBe("next");
        expect(run({}, [configured], `${session}/prot`).kind).toBe("deny");
        expect(run({}, [configured], `${session}/protx`).kind).toBe("next");
        expect(run({}, [join(configured, "runs")], `${session}/prot`).kind).toBe("deny");
      }
    } finally {
      rmSync(alias, { recursive: true, force: true });
    }
  },
);

test("real Cordis uses session cwd, preserves downstream results and audits only safe decisions", async () => {
  const ctx = new Context();
  const messages: unknown[][] = [];
  const stop = ctx.logger.exporter({
    export(message) {
      if (message.name === "shud-raw-guard") messages.push(message.args as unknown[]);
    },
  });
  const fiber = await ctx.plugin({ apply }, { rawDirs: [raw] });
  const downstream: PreToolDecision = { kind: "deny", reason: "another guard" };
  const next = vi.fn(() => Promise.resolve(downstream));
  const execution = (sessionCwd: string, args: unknown) =>
    ({
      name: "shud_run",
      arguments: args,
      agent: { session: { header: { cwd: sessionCwd } } },
    }) as unknown as ToolExecution;
  const privateArgs = {
    input_dir: "ccw",
    workdir: process.cwd(),
    content: "private-raw-payload",
    env: { PRIVATE_VALUE: "private-environment-payload" },
  };
  try {
    expect(realpathSync.native(boundary)).not.toBe(realpathSync.native(process.cwd()));
    const denied = await ctx.waterfall(
      "tools/pre-execute",
      execution(join(raw, "sub"), privateArgs),
      next,
    );
    expect(denied.kind).toBe("deny");
    if (denied.kind === "deny") expect(denied.reason).toMatch(/immutable/);
    const asked = await ctx.waterfall(
      "tools/pre-execute",
      execution(boundary, { ...privateArgs, input_dir: "prot/ccw" }),
      next,
    );
    expect(asked).toMatchObject({ kind: "ask", reason: RAW_READ_PROVENANCE_REASON });
    expect(next).not.toHaveBeenCalled();
    expect(
      await ctx.waterfall(
        "tools/pre-execute",
        execution(join(boundary, "safe"), privateArgs),
        next,
      ),
    ).toBe(downstream);
    expect(next).toHaveBeenCalledTimes(1);
    const failure = new Error("downstream failed");
    const failingNext = vi.fn(() => Promise.reject(failure));
    await expect(
      ctx.waterfall(
        "tools/pre-execute",
        execution(join(boundary, "safe"), privateArgs),
        failingNext,
      ),
    ).rejects.toBe(failure);
    expect(failingNext).toHaveBeenCalledTimes(1);
    await fiber.dispose();
    await fiber.dispose();
    expect(messages).toEqual([
      ["deny shud_run raw-immutable"],
      ["ask shud_run raw-read-provenance"],
      ["deny=1 ask=1"],
    ]);
    expect(
      await ctx.waterfall("tools/pre-execute", execution(join(raw, "sub"), privateArgs), next),
    ).toBe(downstream);
    expect(next).toHaveBeenCalledTimes(2);
  } finally {
    await fiber.dispose();
    await stop();
  }
});

for (const destination of ["stacks", "provenance"]) {
  test.each([false, true])(
    `shud_run denies protected ${destination}; root exists=%s`,
    (present) => {
      const root = mkdtempSync(join(tmpdir(), "shud-guard-capture-"));
      try {
        if (present) mkdirSync(join(root, destination));
        const before = readdirSync(root);
        for (const configured of [destination, `./${destination}/`, join(root, destination)]) {
          const decision = run(
            { input_dir: "ordinary-input", project: "tiny" },
            [configured],
            root,
          );
          expect(decision.kind).toBe("deny");
          expect(decision.code).toBe("raw-immutable");
          expect(decision.reason).toMatch(/immutable/u);
        }
        expect(readdirSync(root)).toEqual(before);
        expect(existsSync(join(root, destination))).toBe(present);
        expect(run({ input_dir: "ordinary-input" }, [`${destination}-input`], root)).toEqual({
          kind: "next",
          code: "unrelated",
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test.each([
    "output-link-equal",
    "output-link-inside",
    "raw-link",
    "raw-link-parent",
    "session-link-absent",
    "session-link-present",
    "input-link",
  ])(`protected ${destination} retains canonical containment through %s`, (kind) => {
    const root = mkdtempSync(join(tmpdir(), "shud-guard-capture-alias-"));
    try {
      const workspace = join(root, "workspace");
      const protectedRoot = join(root, "protected");
      mkdirSync(workspace);
      mkdirSync(join(protectedRoot, "input"), { recursive: true });
      let session = workspace;
      let input = join(root, "ordinary-input");
      let roots = [join(workspace, destination)];
      if (kind.startsWith("output-link")) {
        const target = kind === "output-link-equal" ? protectedRoot : join(protectedRoot, "output");
        if (kind === "output-link-inside") mkdirSync(target);
        symlinkSync(target, join(workspace, destination));
        roots = [protectedRoot];
      } else if (kind.startsWith("raw-link")) {
        mkdirSync(join(workspace, destination, "child"), { recursive: true });
        const target =
          kind === "raw-link"
            ? join(workspace, destination)
            : join(workspace, destination, "child");
        symlinkSync(target, join(root, "raw-alias"));
        roots = [kind === "raw-link" ? join(root, "raw-alias") : `${root}/raw-alias/..`];
      } else if (kind.startsWith("session-link")) {
        if (kind === "session-link-present") mkdirSync(join(workspace, destination));
        symlinkSync(workspace, join(root, "session-alias"));
        session = join(root, "session-alias");
        roots = [join(realpathSync.native(workspace), destination)];
      } else {
        symlinkSync(join(protectedRoot, "input"), join(root, "input-alias"));
        input = join(root, "input-alias");
        roots = [protectedRoot, join(workspace, destination)];
        expect(run({ input_dir: input }, [protectedRoot], session).reason).toBe(
          RAW_READ_PROVENANCE_REASON,
        );
      }
      const before = readdirSync(workspace);
      const decision = run({ input_dir: input, project: "tiny" }, roots, session);
      expect(decision.kind).toBe("deny");
      expect(decision.code).toBe("raw-immutable");
      expect(decision.reason).toMatch(/immutable/u);
      expect(readdirSync(workspace)).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(`protected ${destination} uses existing physical case spelling`, ({ skip }) => {
    const root = mkdtempSync(join(tmpdir(), "shud-guard-capture-case-"));
    try {
      const spelling = destination[0].toUpperCase() + destination.slice(1);
      mkdirSync(join(root, spelling));
      if (!existsSync(join(root, destination))) {
        skip("filesystem distinguishes the capture root case spellings");
        return;
      }
      const decision = run({ input_dir: "ordinary-input" }, [join(root, spelling)], root);
      expect(decision.kind).toBe("deny");
      expect(decision.code).toBe("raw-immutable");
      expect(decision.reason).toMatch(/immutable/u);
      expect(readdirSync(root)).toEqual([spelling]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([
    ["protected input", { input_dir: "prot/ccw", project: "tiny" }],
    ["missing arguments", undefined],
    ["null arguments", null],
    ["array arguments", []],
    ["string arguments", "prot/ccw"],
    ["numeric arguments", 1],
    ["boolean arguments", false],
    ["missing input", {}],
    ["null input", { input_dir: null }],
    ["numeric input", { input_dir: 1 }],
    ["array input", { input_dir: ["prot/ccw"] }],
    ["object input", { input_dir: { path: "prot/ccw" } }],
  ])(`${destination} write denial precedes %s regardless of raw-root order`, (_label, args) => {
    for (const roots of [
      ["prot", destination],
      [destination, "prot"],
    ]) {
      const decision = run(args, roots);
      expect(decision.kind).toBe("deny");
      expect(decision.code).toBe("raw-immutable");
      expect(decision.reason).toMatch(/immutable/u);
    }
  });
}
