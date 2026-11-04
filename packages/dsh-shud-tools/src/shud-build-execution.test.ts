import * as childProcess from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";
import { BuildIdSchema } from "@shud-harness/dsh-shud-core";
import { readWorkspaceRecord } from "@shud-harness/dsh-shud-records";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { valueOf } from "./change-create/test-harness.ts";
import { expectToolError } from "./task-linked/test-harness.ts";
import {
  BASE_FILES,
  buildFixture,
  candidate,
  MAKEFILE,
  noBuilds,
  PRIVATE,
  type BuildFixture,
} from "./shud-build/matrix/test-harness.ts";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof childProcess>();
  return { ...actual, execFile: vi.fn(actual.execFile), spawnSync: vi.fn(actual.spawnSync) };
});
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    accessSync: vi.fn(actual.accessSync),
    copyFileSync: vi.fn(actual.copyFileSync),
  };
});
const nativeFs = await vi.importActual<typeof fs>("node:fs");
const native = await vi.importActual<typeof childProcess>("node:child_process");
let h: BuildFixture;
beforeEach(async () => {
  h = await buildFixture();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.mocked(childProcess.execFile).mockImplementation(native.execFile);
  vi.mocked(childProcess.spawnSync).mockImplementation(native.spawnSync);
  vi.mocked(fs.accessSync).mockImplementation(nativeFs.accessSync);
  vi.mocked(fs.copyFileSync).mockImplementation(nativeFs.copyFileSync);
  await h.dispose();
});

test.each(["source", "copied"])(
  "%s ordinary artifact with execute bits but denied effective permission cannot be published",
  async (location) => {
    await h.dispose();
    h = await buildFixture({
      files: {
        ...BASE_FILES,
        Makefile: MAKEFILE.replace(
          "chmod 755 shud",
          `chmod ${location === "source" ? "650" : "755"} shud`,
        ),
      },
    });
    let deniedPath: string | undefined;
    let qualified = false;
    let denied = false;
    function qualify(path: string) {
      const stat = nativeFs.lstatSync(path);
      expect(stat.isFile()).toBe(true);
      expect(stat.mode & 0o777).toBe(0o650);
      expect(stat.mode & 0o111).not.toBe(0);
      const uid = process.getuid?.();
      expect(uid).toBeTypeOf("number");
      expect(stat.uid).toBe(uid);
      if (uid === 0) {
        // Root can execute when any execute bit is set; inject the OS denial below.
        expect(() => nativeFs.accessSync(path, fs.constants.X_OK)).not.toThrow();
      } else {
        expect(() => nativeFs.accessSync(path, fs.constants.X_OK)).toThrow();
      }
      deniedPath = path;
      qualified = true;
    }
    vi.mocked(childProcess.spawnSync).mockImplementation((...args) => {
      const result = native.spawnSync(...args);
      const argv = args[1];
      if (
        location === "source" &&
        args[0] === "make" &&
        Array.isArray(argv) &&
        argv.includes("shud") &&
        result.status === 0
      ) {
        const source: unknown = argv[argv.indexOf("-C") + 1];
        if (typeof source !== "string")
          throw new Error("Missing make source in permission fixture");
        qualify(join(h.cwd, source, "shud"));
      }
      return result;
    });
    vi.mocked(fs.copyFileSync).mockImplementation((...args) => {
      nativeFs.copyFileSync(...args);
      const target = String(args[1]);
      if (
        location === "copied" &&
        String(args[0]).endsWith("/src/shud") &&
        target.startsWith(`${join(h.cwd, "builds")}/`)
      ) {
        nativeFs.chmodSync(target, 0o650);
        qualify(target);
      }
    });
    vi.mocked(fs.accessSync).mockImplementation((path, mode) => {
      if (mode !== undefined && (mode & fs.constants.X_OK) !== 0 && String(path) === deniedPath) {
        denied = true;
        throw Object.assign(new Error(PRIVATE), { code: "EACCES" });
      }
      return nativeFs.accessSync(path, mode);
    });
    await h.preserve(async () => {
      const result = await h.build();
      expect(qualified).toBe(true);
      const message = expectToolError(result, /executable|permission/iu);
      expect(message).toMatch(/exit(?:ed)? 0/u);
      expect(message).not.toContain(PRIVATE);
      expect(message).not.toContain(".tmp-");
      expect(denied).toBe(true);
      noBuilds(h);
    });
  },
);

const failures = [
  {
    name: "make nonzero",
    body: "printf '%s\\n' last-build-failure >&2\n\texit 2",
    expected: /make failed \(exit 2\)/u,
  },
  { name: "make signal", body: "kill -KILL $$PPID", expected: /make.*signal SIGKILL/u },
  { name: "missing artifact", body: "true", expected: /executable/iu },
  { name: "directory artifact", body: "mkdir shud", expected: /ordinary executable/iu },
  { name: "symlink artifact", body: "ln -s Makefile shud", expected: /ordinary executable/iu },
  { name: "FIFO artifact", body: "mkfifo shud", expected: /ordinary executable/iu },
  { name: "nonexecutable artifact", body: "printf nope > shud", expected: /ordinary executable/iu },
];
test.each(failures)(
  "$name leaves no build or source/card mutation",
  async ({ name, body, expected }) => {
    await h.dispose();
    h = await buildFixture({ files: { Makefile: `CXX := cc\nshud:\n\t${body}\n` } });
    await h.preserve(async () => {
      vi.clearAllMocks();
      const message = expectToolError(await h.build(), expected);
      if (name.endsWith("artifact")) expect(message).toMatch(/exit(?:ed)? 0/u);
      expect(message).not.toContain(".tmp-");
      expect(message).not.toContain(PRIVATE);
      const builds = vi
        .mocked(childProcess.spawnSync)
        .mock.calls.filter(
          ([name, argv]) => name === "make" && Array.isArray(argv) && argv.includes("shud"),
        );
      expect(builds).toHaveLength(1);
      noBuilds(h);
    });
  },
);

test.each([
  "empty",
  "multiword",
  "missing",
  "nonzero",
  "empty-version",
  "blank-first-line",
  "probe-nonzero",
] as const)("compiler %s fails closed with cleanup", async (kind) => {
  await h.dispose();
  const cxx = {
    empty: "",
    multiword: "cc -O0",
    missing: "no-such-shud-compiler",
    nonzero: "false",
    "empty-version": "./compiler",
    "blank-first-line": "./compiler",
    "probe-nonzero": "cc",
  }[kind];
  h = await buildFixture({
    files: {
      ...BASE_FILES,
      Makefile:
        MAKEFILE.replace("CXX := cc", `CXX := ${cxx}`).replace(
          "\tchmod 755 shud",
          "\tchmod 755 shud compiler",
        ) +
        (kind === "probe-nonzero"
          ? `\nprint-cxx: probe-failure\nprobe-failure:\n\t@printf '%s\\n' '${PRIVATE}' >&2\n\t@exit 7\n`
          : ""),
      compiler:
        kind === "empty-version"
          ? "#!/bin/sh\nexit 0\n"
          : "#!/bin/sh\nprintf '\\nsecond line\\n'\n",
    },
  });
  await h.preserve(async () => {
    const message = expectToolError(await h.build(), /compiler/iu);
    expect(message).not.toContain(".tmp-");
    expect(message).not.toContain(PRIVATE);
    if (kind === "empty" || kind === "multiword") expect(message).toMatch(/exit(?:ed)? 0/u);
    noBuilds(h);
  });
});

function compilerProbeFiles(action: string, phase: "selection" | "version") {
  const makefile = MAKEFILE.replace("CXX := cc", "CXX := ./compiler").replace(
    "chmod 755 shud",
    "chmod 755 shud compiler",
  );
  return {
    ...BASE_FILES,
    Makefile:
      makefile +
      (phase === "selection"
        ? `\n.PHONY: probe-output\nprint-cxx: probe-output\nprobe-output:\n\t@${action}\n`
        : ""),
    compiler:
      `#!/bin/sh\n${phase === "version" ? `${action}\n` : ""}` +
      "printf '%s\\n' 'fixture compiler 1.0'\n",
  };
}

test("extra main-make output cannot expand the exact published build inventory", async () => {
  await h.dispose();
  h = await buildFixture({
    files: {
      ...BASE_FILES,
      Makefile: `${MAKEFILE}\tprintf '%s\\n' auxiliary-build-note > ../build-note.txt\n`,
    },
  });
  await h.preserve(async () => {
    const result = await h.build();
    if (result.isError) {
      const message = expectToolError(result, /inventory|entry|publication|build/iu);
      expect(message).not.toContain(".tmp-");
      noBuilds(h);
    } else {
      const value = valueOf(result);
      const id = BuildIdSchema.parse(value.build_id);
      const directory = join(h.cwd, "builds", id);
      expect(fs.readdirSync(directory).sort()).toEqual([
        "build-record.json",
        "make.stderr.log",
        "make.stdout.log",
        "shud",
      ]);
      const record = readWorkspaceRecord(h.cwd, "build", id, { readonly: true });
      expect(
        childProcess.execFileSync(join(h.cwd, record.binary_path), [], { encoding: "utf8" }),
      ).toBe("base-matrix\n");
    }
  });
});

test("compiler version probing cannot publish a mutation of the initially hashed binary", async () => {
  await h.dispose();
  h = await buildFixture({
    files: {
      ...BASE_FILES,
      Makefile: MAKEFILE.replace("CXX := cc", "CXX := ./compiler").replace(
        "chmod 755 shud",
        "chmod 755 shud compiler",
      ),
      compiler:
        "#!/bin/sh\nprintf '%s\\n' '# compiler-probe mutation' >> ../shud\nprintf '%s\\n' 'fixture compiler 1.0'\n",
    },
  });
  await h.preserve(async () => {
    const message = expectToolError(await h.build(), /binary|digest|integrity/iu);
    expect(message).not.toContain(".tmp-");
    noBuilds(h);
  });
});

test("compiler version probing cannot rewrite ordinary main-make stdout evidence", async () => {
  await h.dispose();
  h = await buildFixture({
    files: compilerProbeFiles(
      "printf '%s\\n' 'forged compiler commands' > ../make.stdout.log",
      "version",
    ),
  });
  await h.preserve(async () => {
    const message = expectToolError(await h.build(), /log|evidence|integrity/iu);
    expect(message).not.toContain(".tmp-");
    noBuilds(h);
  });
});

test.each([
  { build: "base", phase: "main", entry: "make.stdout.log" },
  { build: "candidate", phase: "main", entry: "make.stderr.log" },
  { build: "candidate", phase: "selection", entry: "make.stdout.log" },
  { build: "base", phase: "selection", entry: "make.stderr.log" },
  { build: "base", phase: "version", entry: "make.stdout.log" },
  { build: "candidate", phase: "version", entry: "make.stderr.log" },
] as const)(
  "$build build rejects ordinary $entry replacement by $phase execution",
  async ({ build, phase, entry }) => {
    await h.dispose();
    // Keep the old inode alive under src, then clone its bytes into a new file.
    // Digest-only validation cannot substitute for the creation-time identity.
    const action = `mv ../${entry} original-${entry}; cat original-${entry} > ../${entry}`;
    h = await buildFixture({
      files:
        phase === "main"
          ? { ...BASE_FILES, Makefile: `${MAKEFILE}\t${action}\n` }
          : compilerProbeFiles(action, phase),
    });
    const id = build === "candidate" ? await candidate(h) : undefined;
    await h.preserve(async () => {
      const message = expectToolError(
        await h.build(id === undefined ? {} : { change_id: id }),
        /log identity changed/iu,
      );
      expect(message).toContain(entry);
      expect(message).not.toContain(".tmp-");
      noBuilds(h);
    });
  },
);

test.each([
  { build: "base", phase: "selection", entry: "make.stdout.log", mutation: "overwrite" },
  { build: "candidate", phase: "selection", entry: "make.stderr.log", mutation: "append" },
  { build: "candidate", phase: "version", entry: "make.stderr.log", mutation: "append" },
] as const)(
  "$build build rejects in-place $entry $mutation by compiler $phase",
  async ({ build, phase, entry, mutation }) => {
    await h.dispose();
    const redirect = mutation === "append" ? ">>" : ">";
    h = await buildFixture({
      files: compilerProbeFiles(
        `printf '%s\\n' 'probe-contaminated make evidence' ${redirect} ../${entry}`,
        phase,
      ),
    });
    const id = build === "candidate" ? await candidate(h) : undefined;
    await h.preserve(async () => {
      const message = expectToolError(
        await h.build(id === undefined ? {} : { change_id: id }),
        /log changed after main make/iu,
      );
      expect(message).toContain(entry);
      expect(message).not.toContain(".tmp-");
      noBuilds(h);
    });
  },
);

test("successful main-make stdout and stderr writes remain immutable candidate evidence", async () => {
  await h.dispose();
  const files = compilerProbeFiles(":", "version");
  h = await buildFixture({
    files: {
      ...files,
      Makefile: files.Makefile.replace(
        "chmod 755 shud compiler\n",
        "chmod 755 shud compiler\n\tprintf '%s\\n' original-main-stdout\n\tprintf '%s\\n' original-main-stderr >&2\n",
      ),
    },
  });
  const id = await candidate(h);
  await h.preserve(async () => {
    const result = valueOf(await h.build({ change_id: id }));
    const record = readWorkspaceRecord(h.cwd, "build", BuildIdSchema.parse(result.build_id), {
      readonly: true,
    });
    const stdout = fs.readFileSync(join(h.cwd, record.stdout_path), "utf8");
    expect(stdout).toContain("\noriginal-main-stdout\n");
    expect(stdout).not.toContain("fixture compiler 1.0");
    expect(fs.readFileSync(join(h.cwd, record.stderr_path), "utf8")).toBe("original-main-stderr\n");
    expect(record.compiler).toBe("fixture compiler 1.0");
    expect(fs.readdirSync(join(h.cwd, "builds", record.build_id)).sort()).toEqual([
      "build-record.json",
      "make.stderr.log",
      "make.stdout.log",
      "shud",
    ]);
    expect(
      childProcess.execFileSync(join(h.cwd, record.binary_path), [], { encoding: "utf8" }),
    ).toBe("candidate-matrix\n");
  });
});

test.each([
  { build: "base", phase: "selection" },
  { build: "candidate", phase: "main" },
  { build: "candidate", phase: "selection" },
] as const)(
  "$build build rejects extra producer files from $phase make",
  async ({ build, phase }) => {
    await h.dispose();
    const action = "printf '%s\\n' auxiliary-build-note > ../build-note.txt";
    h = await buildFixture({
      files:
        phase === "selection"
          ? compilerProbeFiles(action, phase)
          : { ...BASE_FILES, Makefile: `${MAKEFILE}\t${action}\n` },
    });
    const id = build === "candidate" ? await candidate(h) : undefined;
    await h.preserve(async () => {
      const message = expectToolError(
        await h.build(id === undefined ? {} : { change_id: id }),
        /publication inventory/iu,
      );
      expect(message).not.toContain(".tmp-");
      noBuilds(h);
    });
  },
);

test.each([
  { build: "base", phase: "selection", mutation: "contents" },
  { build: "candidate", phase: "selection", mutation: "contents" },
  { build: "candidate", phase: "version", mutation: "contents" },
  { build: "base", phase: "selection", mutation: "permissions" },
  { build: "candidate", phase: "version", mutation: "permissions" },
  { build: "base", phase: "version", mutation: "type" },
  { build: "candidate", phase: "selection", mutation: "type" },
  { build: "base", phase: "selection", mutation: "effective-permission" },
  { build: "candidate", phase: "version", mutation: "effective-permission" },
] as const)(
  "$build build rejects copied-binary $mutation changed by compiler $phase",
  async ({ build, phase, mutation }) => {
    await h.dispose();
    const action =
      mutation === "contents"
        ? "printf '%s\\n' '# late copied-binary mutation' >> ../shud"
        : mutation === "permissions"
          ? "chmod 000 ../shud"
          : mutation === "effective-permission"
            ? "chmod 650 ../shud"
            : phase === "selection"
              ? "rm -f ../shud; mkdir ../shud"
              : "rm -f ../shud; ln -s make.stdout.log ../shud";
    h = await buildFixture({ files: compilerProbeFiles(action, phase) });
    const id = build === "candidate" ? await candidate(h) : undefined;
    let denied = false;
    if (mutation === "effective-permission") {
      vi.mocked(fs.accessSync).mockImplementation((path, mode) => {
        const target = String(path);
        if (
          mode !== undefined &&
          (mode & fs.constants.X_OK) !== 0 &&
          target.startsWith(`${join(h.cwd, "builds")}/`) &&
          target.endsWith("/shud") &&
          (nativeFs.lstatSync(target).mode & 0o777) === 0o650
        ) {
          denied = true;
          throw Object.assign(new Error(PRIVATE), { code: "EACCES" });
        }
        return nativeFs.accessSync(path, mode);
      });
    }
    await h.preserve(async () => {
      const message = expectToolError(
        await h.build(id === undefined ? {} : { change_id: id }),
        /binary|executable|publication/iu,
      );
      expect(message).not.toContain(PRIVATE);
      expect(message).not.toContain(".tmp-");
      if (mutation === "effective-permission") expect(denied).toBe(true);
      noBuilds(h);
    });
  },
);

test.each([
  { build: "base", phase: "selection", entry: "make.stdout.log", replacement: "missing" },
  { build: "candidate", phase: "version", entry: "make.stderr.log", replacement: "missing" },
  { build: "base", phase: "version", entry: "shud", replacement: "missing" },
  { build: "candidate", phase: "selection", entry: "make.stdout.log", replacement: "directory" },
  { build: "base", phase: "version", entry: "make.stderr.log", replacement: "symlink" },
  { build: "candidate", phase: "selection", entry: "make.stderr.log", replacement: "fifo" },
] as const)(
  "$build build rejects $replacement $entry after compiler $phase",
  async ({ build, phase, entry, replacement }) => {
    await h.dispose();
    const target = `../${entry}`;
    const action =
      `rm -f ${target}` +
      (replacement === "missing"
        ? ""
        : replacement === "directory"
          ? `; mkdir ${target}`
          : replacement === "symlink"
            ? `; ln -s shud ${target}`
            : `; mkfifo ${target}`);
    h = await buildFixture({ files: compilerProbeFiles(action, phase) });
    const id = build === "candidate" ? await candidate(h) : undefined;
    await h.preserve(async () => {
      // A real FIFO has no writer: completion proves rejected log diagnostics
      // cannot block while opening a nonordinary producer entry.
      const message = expectToolError(
        await h.build(id === undefined ? {} : { change_id: id }),
        /publication|inventory/iu,
      );
      expect(message).not.toContain(".tmp-");
      noBuilds(h);
    });
  },
);

test.each(["PATH", "HOME"])("missing host %s fails before output effects", async (key) => {
  vi.stubEnv(key, undefined);
  await h.preserve(async () => {
    vi.clearAllMocks();
    expectToolError(await h.build(), /PATH|HOME/u);
    expect(childProcess.execFile).not.toHaveBeenCalled();
    expect(childProcess.spawnSync).not.toHaveBeenCalled();
    expect(fs.existsSync(join(h.cwd, "builds"))).toBe(false);
  });
});

test.each(["git", "tar", "make", "compiler"])(
  "missing system %s never falls back to a working-tree build",
  async (command) => {
    if (command === "git") {
      vi.mocked(childProcess.execFile).mockImplementation((...args) =>
        native.execFile(join(h.root, "missing-git"), args[1], args[2], args[3]),
      );
    } else {
      vi.mocked(childProcess.spawnSync).mockImplementation((...args) => {
        if (args[0] === (command === "compiler" ? "cc" : command)) {
          return native.spawnSync(join(h.root, "missing-command"), args[1], args[2]);
        }
        return native.spawnSync(...args);
      });
    }
    await h.preserve(async () => {
      expectToolError(await h.build(), /failed|checkout/iu);
      noBuilds(h);
    });
  },
);

test.each(["archive", "ls-tree", "hash-object", "apply"])(
  "Git %s failures preserve controlled stage/exit without stderr leakage",
  async (command) => {
    const id = command === "apply" ? await candidate(h) : undefined;
    vi.mocked(childProcess.execFile).mockImplementation((...args) => {
      if (Array.isArray(args[1]) && args[1].includes(command)) {
        return native.execFile(
          process.execPath,
          ["-e", `process.stderr.write('${PRIVATE}');process.exit(23)`],
          args[2],
          args[3],
        );
      }
      return native.execFile(...args);
    });
    await h.preserve(async () => {
      const message = expectToolError(await h.build(id ? { change_id: id } : {}), /exit 23/u);
      expect(message).not.toContain(PRIVATE);
      expect(message).not.toContain(".tmp-");
      noBuilds(h);
    });
  },
);

test("actual Git, tar, make and compiler receive only their permitted environments", async () => {
  await h.dispose();
  h = await buildFixture({
    files: {
      ...BASE_FILES,
      Makefile: MAKEFILE.replace("\tchmod 755 shud", "\tchmod 755 shud\n\tenv"),
    },
  });
  const id = await candidate(h);
  vi.stubEnv("DMXAPI_KEY", PRIVATE);
  vi.stubEnv("SHUD_PRIVATE", PRIVATE);
  await h.preserve(async () => {
    vi.clearAllMocks();
    const result = valueOf(await h.build({ change_id: id }));
    const record = readWorkspaceRecord(h.cwd, "build", BuildIdSchema.parse(result.build_id), {
      readonly: true,
    });
    const calls = vi.mocked(childProcess.execFile).mock.calls;
    expect(calls.some((call) => Array.isArray(call[1]) && call[1].includes("archive"))).toBe(true);
    expect(calls.some((call) => Array.isArray(call[1]) && call[1].includes("apply"))).toBe(true);
    for (const call of calls) {
      const options = call[2];
      if (typeof options !== "object" || options === null) throw new Error("Missing Git options");
      const apply = Array.isArray(call[1]) && call[1].includes("apply");
      expect(Object.keys(options.env ?? {}).sort()).toEqual(
        [
          ...(apply ? ["GIT_CEILING_DIRECTORIES"] : []),
          "GIT_CONFIG_GLOBAL",
          "GIT_CONFIG_NOSYSTEM",
          "GIT_OPTIONAL_LOCKS",
          "GIT_TERMINAL_PROMPT",
          "HOME",
          "LC_ALL",
          "PATH",
        ].sort(),
      );
    }
    const sync = vi.mocked(childProcess.spawnSync).mock.calls;
    expect(sync.map(([command]) => command)).toEqual(["tar", "make", "make", "cc"]);
    for (const call of sync) {
      const options = call[2];
      expect(Object.keys(options?.env ?? {}).sort()).toEqual(["HOME", "PATH", "SUNDIALS_DIR"]);
      expect(JSON.stringify(options?.env)).not.toContain(PRIVATE);
    }
    const stdout = fs.readFileSync(join(h.cwd, record.stdout_path), "utf8");
    expect(stdout).toContain("SUNDIALS_DIR=");
    expect(stdout).not.toContain("DMXAPI_KEY");
    expect(stdout).not.toContain("SHUD_PRIVATE");
    expect(stdout).not.toContain(PRIVATE);
    expect(JSON.stringify(record)).not.toContain(PRIVATE);
  });
});

test("large stdout and stderr yield at most forty total diagnostic lines with secrets and deleted paths removed", async () => {
  await h.dispose();
  h = await buildFixture({
    files: {
      Makefile:
        "CXX := cc\nshud:\n\t@printf '%0200000d\\n' 0\n\t@printf '%s\\n' old-stdout-evidence\n\t@i=0; while test $$i -lt 60; do printf 'stdout-%s\\n' $$i; printf 'stderr-%s\\n' $$i >&2; i=$$((i+1)); done\n\t@printf '%s\\n' \"$$HOME\" \"$$PWD\" 'PRIVATE_BUILD_MATRIX_537' >&2\n\t@printf '%s\\n' latest-stderr-evidence >&2\n\t@exit 2\n",
    },
  });
  await h.preserve(async () => {
    // Only explicit diagnostic fixtures and required process paths participate in
    // redaction; unrelated ambient values must not redefine the evidence markers.
    for (const key of Object.keys(process.env)) {
      if (key !== "PATH" && key !== "HOME") vi.stubEnv(key, undefined);
    }
    vi.stubEnv("SHUD_PRIVATE", PRIVATE);
    vi.stubEnv("SHUD_NUMERIC_ENV_FIXTURE", "9");
    let result;
    try {
      result = await h.build();
    } finally {
      vi.unstubAllEnvs();
    }
    const message = expectToolError(result, /make failed \(exit 2\)/u);
    expect(message.split("\n").slice(1).length).toBeLessThanOrEqual(40);
    expect(message).toContain("latest-stderr-evidence");
    expect(message).not.toContain("old-stdout-evidence");
    expect(message).not.toContain(PRIVATE);
    expect(message).not.toContain(h.cwd);
    expect(message).not.toContain(".tmp-");
    expect(message.length).toBeLessThan(20_000);
    noBuilds(h);
  });
});

test("a large produced executable retains its exact bytes and digest without truncation", async () => {
  await h.dispose();
  h = await buildFixture({
    files: {
      Makefile:
        "CXX := cc\nshud:\n\tprintf '%s\\n' '#!/bin/sh' '#padding' > shud\n\tdd if=/dev/zero bs=65536 count=32 2>/dev/null | tr '\\000' '#' >> shud\n\tprintf '\\nprintf \"large-binary\\\\n\"\\n' >> shud\n\tchmod 755 shud\n",
    },
  });
  await h.preserve(async () => {
    const result = valueOf(await h.build());
    const record = readWorkspaceRecord(h.cwd, "build", BuildIdSchema.parse(result.build_id), {
      readonly: true,
    });
    const binary = join(h.cwd, record.binary_path);
    expect(fs.statSync(binary).size).toBeGreaterThan(2 * 1024 * 1024);
    expect(childProcess.execFileSync(binary, [], { encoding: "utf8" })).toBe("large-binary\n");
    expect(createHash("sha256").update(fs.readFileSync(binary)).digest("hex")).toBe(
      record.binary_sha256,
    );
  });
});

test("tar failure is controlled and cannot reach make or leave a build", async () => {
  vi.mocked(childProcess.spawnSync).mockImplementation((...args) => {
    if (args[0] === "tar") {
      return native.spawnSync(
        process.execPath,
        ["-e", `process.stderr.write('${PRIVATE}');process.exit(24)`],
        args[2],
      );
    }
    return native.spawnSync(...args);
  });
  await h.preserve(async () => {
    vi.clearAllMocks();
    const message = expectToolError(await h.build(), /archive extraction failed \(exit 24\)/u);
    expect(message).not.toContain(PRIVATE);
    expect(vi.mocked(childProcess.spawnSync).mock.calls.some(([name]) => name === "make")).toBe(
      false,
    );
    noBuilds(h);
  });
});

test("configured child SUNDIALS_DIR is redacted from failure logs even when absent from the host environment", async () => {
  await h.dispose();
  h = await buildFixture({
    files: {
      Makefile: "CXX := cc\nshud:\n\tprintf 'child-root=%s\\n' '$(SUNDIALS_DIR)' >&2\n\texit 2\n",
    },
  });
  const home = join(h.root, "minimal-home");
  fs.mkdirSync(home);
  await h.preserve(async () => {
    // Remove incidental prefix matches (TMPDIR, OLDPWD, etc.) so only the child
    // configuration can identify the printed value as an environment value.
    for (const key of Object.keys(process.env)) {
      if (key !== "PATH") vi.stubEnv(key, undefined);
    }
    vi.stubEnv("HOME", home);
    let result;
    try {
      result = await h.build();
    } finally {
      vi.unstubAllEnvs();
    }
    const message = expectToolError(result, /make failed \(exit 2\)/u);
    expect(message.split("\n")[0]).toBe("make failed (exit 2)");
    expect(message).not.toContain(h.sundialsRoot);
    expect(message).toContain("child-root=[redacted]");
    expect(message).not.toContain(".tmp-");
    noBuilds(h);
  });
});
