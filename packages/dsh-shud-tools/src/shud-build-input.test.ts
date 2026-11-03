import * as childProcess from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";
import { BuildIdSchema } from "@shud-harness/dsh-shud-core";
import { readWorkspaceRecord, verifyBuildBinary } from "@shud-harness/dsh-shud-records";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fileSnapshot, valueOf } from "./change-create/test-harness.ts";
import { expectToolError } from "./task-linked/test-harness.ts";
import {
  BASE_FILES,
  buildFixture,
  candidate,
  noBuilds,
  type BuildFixture,
} from "./shud-build/matrix/test-harness.ts";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof childProcess>();
  return { ...actual, execFile: vi.fn(actual.execFile), spawnSync: vi.fn(actual.spawnSync) };
});
const native = await vi.importActual<typeof childProcess>("node:child_process");
let h: BuildFixture;
beforeEach(async () => {
  h = await buildFixture();
});
afterEach(async () => {
  vi.mocked(childProcess.execFile).mockImplementation(native.execFile);
  vi.mocked(childProcess.spawnSync).mockImplementation(native.spawnSync);
  await h.dispose();
});
function noMake() {
  expect(vi.mocked(childProcess.spawnSync).mock.calls.some(([command]) => command === "make")).toBe(
    false,
  );
}

test.each([false, true])(
  "ignored glob source and stale binary never enter candidate=%s",
  async (isCandidate) => {
    const id = isCandidate ? await candidate(h) : undefined;
    fs.writeFileSync(
      join(h.source, "src/Model/shud.extra.cpp"),
      'printf "IGNORED-CONTAMINATION\\n"\n',
    );
    const staleHash = createHash("sha256")
      .update(fs.readFileSync(join(h.source, "shud")))
      .digest("hex");
    await h.preserve(async () => {
      const result = valueOf(await h.build(id ? { change_id: id } : {}));
      const record = readWorkspaceRecord(h.cwd, "build", BuildIdSchema.parse(result.build_id), {
        readonly: true,
      });
      const binary = join(h.cwd, record.binary_path);
      expect(childProcess.execFileSync(binary, [], { encoding: "utf8" })).toBe(
        isCandidate ? "candidate-matrix\n" : "base-matrix\n",
      );
      expect(record.binary_sha256).not.toBe(staleHash);
      expect(fs.readFileSync(binary, "utf8")).not.toContain("IGNORED-CONTAMINATION");
      const stdout = fs.readFileSync(join(h.cwd, record.stdout_path), "utf8");
      expect(stdout).toContain("cat src/Model/f.cpp >> shud");
      expect(stdout).not.toContain("shud.extra.cpp");
    });
  },
);

test.each(["committed-ignore", "committed-subst", "info-ignore", "info-subst"])(
  "archive %s attributes are rejected with the changed path before make",
  async (kind) => {
    await h.dispose();
    const attribute = kind.endsWith("ignore") ? "export-ignore" : "export-subst";
    h = await buildFixture({
      files: {
        ...BASE_FILES,
        "docs/marker.txt": "$Format:%H$\n",
        ...(kind.startsWith("committed")
          ? { ".gitattributes": `docs/marker.txt ${attribute}\n` }
          : {}),
      },
    });
    if (kind.startsWith("info")) {
      fs.mkdirSync(join(h.source, ".git/info"), { recursive: true });
      fs.writeFileSync(join(h.source, ".git/info/attributes"), `docs/marker.txt ${attribute}\n`);
    }
    await h.preserve(async () => {
      vi.clearAllMocks();
      const message = expectToolError(await h.build(), /archive|tree/iu);
      expect(message).toContain("docs/marker.txt");
      noMake();
      noBuilds(h);
    });
  },
);

test("approved patch applies inside an enclosing repository and respects literal special paths", async () => {
  await h.dispose();
  const special = "docs/:(glob)* [literal].txt";
  h = await buildFixture({ outer: true, files: { ...BASE_FILES, [special]: "base literal\n" } });
  const id = await candidate(h, ["src/Model/f.cpp", special]);
  await h.preserve(async () => {
    const result = valueOf(await h.build({ change_id: id }));
    const record = readWorkspaceRecord(h.cwd, "build", BuildIdSchema.parse(result.build_id), {
      readonly: true,
    });
    expect(record.dirty_paths).toEqual([special, "src/Model/f.cpp"]);
    expect(
      childProcess.execFileSync(join(h.cwd, record.binary_path), [], { encoding: "utf8" }),
    ).toBe("candidate-matrix\n");
    expect(record.change_id).toBe(id);
  });
});

test.each(["all", "one-of-two"])(
  "successful apply that changes %s expected files ineffectively is rejected",
  async (kind) => {
    await h.dispose();
    h = await buildFixture({
      files: { ...BASE_FILES, "src/Model/g.cpp": 'printf "second-base\\n"\n' },
    });
    const id = await candidate(h, ["src/Model/f.cpp", "src/Model/g.cpp"]);
    vi.mocked(childProcess.execFile).mockImplementation((...args) => {
      const argv = args[1];
      if (Array.isArray(argv) && argv.includes("apply") && !argv.includes("--check")) {
        if (kind === "all") return native.execFile(args[0], ["--version"], args[2], args[3]);
        return native.execFile(args[0], argv, args[2], (error, stdout, stderr) => {
          const source: unknown = argv[argv.indexOf("-C") + 1];
          if (typeof source !== "string" || source.length === 0) {
            throw new Error("Missing Git cwd in fault fixture");
          }
          fs.writeFileSync(join(source, "src/Model/g.cpp"), 'printf "second-base\\n"\n');
          args[3]?.(error, stdout, stderr);
        });
      }
      return native.execFile(...args);
    });
    await h.preserve(async () => {
      vi.clearAllMocks();
      const message = expectToolError(
        await h.build({ change_id: id }),
        /patch.*effect|patch.*生效/iu,
      );
      expect(message).toContain(kind === "all" ? "src/Model/f.cpp" : "src/Model/g.cpp");
      noMake();
      noBuilds(h);
    });
  },
);

test.each(["extra-path", "missing-path", "executable-mode", "symlink-type"])(
  "tar extraction %s mismatch cannot become a build input",
  async (kind) => {
    vi.mocked(childProcess.spawnSync).mockImplementation((...args) => {
      const result = native.spawnSync(...args);
      if (args[0] === "tar" && Array.isArray(args[1]) && result.status === 0) {
        const source: unknown = args[1][args[1].indexOf("-C") + 1];
        if (typeof source !== "string" || source.length === 0) {
          throw new Error("Missing tar destination in fault fixture");
        }
        const file = join(source, "docs/note.txt");
        if (kind === "extra-path") fs.writeFileSync(join(source, "foreign"), "injected\n");
        if (kind === "missing-path") fs.unlinkSync(file);
        if (kind === "executable-mode") fs.chmodSync(file, 0o755);
        if (kind === "symlink-type") {
          fs.unlinkSync(file);
          fs.symlinkSync("../Makefile", file);
        }
      }
      return result;
    });
    await h.preserve(async () => {
      vi.clearAllMocks();
      expectToolError(await h.build(), /archive|tree/iu);
      noMake();
      noBuilds(h);
    });
  },
);

test("canonical consumers accept a real publication and reject later binary tampering without repair", async () => {
  await h.preserve(async () => {
    const result = valueOf(await h.build());
    const record = readWorkspaceRecord(h.cwd, "build", BuildIdSchema.parse(result.build_id), {
      readonly: true,
    });
    expect(() => verifyBuildBinary(h.cwd, record)).not.toThrow();
    const binary = join(h.cwd, record.binary_path);
    fs.appendFileSync(binary, "#tampered\n");
    const before = fileSnapshot(binary);
    expect(() => verifyBuildBinary(h.cwd, record)).toThrow();
    expect(fileSnapshot(binary)).toEqual(before);
    expect(readWorkspaceRecord(h.cwd, "build", record.build_id, { readonly: true })).toEqual(
      record,
    );
  });
});

test("candidate builds consume admitted patch bytes despite later replacement of the workspace patch", async () => {
  const id = await candidate(h);
  const change = readWorkspaceRecord(h.cwd, "change", id, { readonly: true });
  const path = join(h.cwd, change.patch_path);
  let replaced = false;
  let replacement: { bytes: Buffer; mtime: bigint } | undefined;
  vi.mocked(childProcess.execFile).mockImplementation((...args) => {
    if (Array.isArray(args[1]) && args[1].includes("archive") && !replaced) {
      replaced = true;
      fs.writeFileSync(path, "late external patch replacement\n");
      replacement = fileSnapshot(path);
    }
    return native.execFile(...args);
  });
  await h.preserve(async () => {
    const result = valueOf(await h.build({ change_id: id }));
    const record = readWorkspaceRecord(h.cwd, "build", BuildIdSchema.parse(result.build_id), {
      readonly: true,
    });
    expect(replaced).toBe(true);
    expect(record.patch_sha256).toBe(change.patch_sha256);
    expect(
      childProcess.execFileSync(join(h.cwd, record.binary_path), [], { encoding: "utf8" }),
    ).toBe("candidate-matrix\n");
    expect(fileSnapshot(path)).toEqual(replacement);
  });
});
