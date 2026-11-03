import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { devNull, release, tmpdir, type } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import type * as NodeCrypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  BuildRecordSchema,
  computeStackFingerprint,
  StackLockSchema,
  type BuildRecord,
  type StackLock,
} from "@shud-harness/dsh-shud-core";
import { captureStackLock, readWorkspaceRecord } from "./index.ts";
import { stackCase } from "./test-harness.ts";
import { buildCase } from "./workspace-files-test-harness.ts";

const entropy = vi.hoisted(() => ({ suffixes: [] as string[] }));
vi.mock("node:crypto", async (original) => {
  const actual = await original<typeof NodeCrypto>();
  return {
    ...actual,
    randomBytes(size: number, callback?: (error: Error | null, bytes: Buffer) => void) {
      if (callback) return actual.randomBytes(size, callback);
      const suffix = size === 2 ? entropy.suffixes.shift() : undefined;
      return suffix === undefined ? actual.randomBytes(size) : Buffer.from(suffix, "hex");
    },
  };
});

const repoNames = ["SHUD", "rSHUD", "AutoSHUD"] as const;
const firstId = "STACK-20261027T080005-3f9c";
const secondId = "STACK-20261027T080005-abcd";
const smallestId = "STACK-20261027T080001-a000";
const largerId = "STACK-20261027T080001-b000";
const payload = "private-build-payload-must-not-escape";
const llm = { response_model: "configured-response" };
type CaptureConfig = Parameters<typeof captureStackLock>[0];
let root: string;
let stacks: string;
let config: CaptureConfig;

function git(directory: string, ...args: string[]): string {
  return execFileSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function committedRepo(name: string): string {
  const path = join(root, name);
  git(root, "init", "-q", "-b", "main", path);
  fs.writeFileSync(join(path, "model.txt"), `${name} model bytes\n`);
  git(path, "add", "model.txt");
  git(
    path,
    "-c",
    "user.name=Capture fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgSign=false",
    "commit",
    "-qm",
    "fixture",
  );
  return path;
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "records-build-capture-")));
  const cwd = join(root, "workspace");
  fs.mkdirSync(cwd);
  stacks = join(cwd, "stacks");
  vi.stubEnv("GIT_CONFIG_GLOBAL", devNull);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("XDG_CONFIG_HOME", join(root, "no-xdg-config"));
  vi.stubEnv("GIT_AUTHOR_DATE", "2026-10-27T08:00:00Z");
  vi.stubEnv("GIT_COMMITTER_DATE", "2026-10-27T08:00:00Z");
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_NAMESPACE",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_PARAMETERS",
  ])
    vi.stubEnv(key, undefined);
  config = {
    cwd,
    stackRepos: {
      SHUD: committedRepo("SHUD"),
      rSHUD: committedRepo("rSHUD"),
      AutoSHUD: committedRepo("AutoSHUD"),
    },
    hostVersion: "fixture-host-0.2.1",
    llm: { base_url: "https://capture.example.invalid/v1", request_alias: "requested-alias" },
  };
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-27T08:00:05.987Z"));
  entropy.suffixes = ["3f9c", "abcd", "1234", "ffff"];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function snapshot(path: string) {
  const stat = fs.statSync(path, { bigint: true });
  return { bytes: fs.readFileSync(path), mtimeNs: stat.mtimeNs, ino: stat.ino };
}

function existingFiles(): string[] {
  return fs.existsSync(stacks) ? fs.readdirSync(stacks).sort() : [];
}

function inventory() {
  return existingFiles().map((file) => [file, snapshot(join(stacks, file))]);
}

function caught(action: () => unknown): Error {
  let failure: unknown;
  try {
    action();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  if (!(failure instanceof Error)) throw new Error("Expected capture failure");
  return failure;
}

function cleanRevision(name: (typeof repoNames)[number]) {
  return {
    commit: git(config.stackRepos[name], "rev-parse", "HEAD"),
    branch: "main",
    dirty: false,
    dirty_paths: [],
    dirty_paths_truncated: false,
  };
}

function persist(lock: StackLock, id: string): void {
  const value = StackLockSchema.parse({ ...lock, stack_id: id });
  const path = join(stacks, `${id}.json`);
  fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  fs.utimesSync(path, 1_600_000_000, 1_600_000_000);
}

describe("captureStackLock BuildRecord source", () => {
  test.each(["base", "candidate"] as const)(
    "%s projects only build identity and source metadata, retaining the other capture fields",
    (kind) => {
      const build = BuildRecordSchema.parse({
        ...buildCase.value,
        ...(kind === "base" ? { change_id: null, patch_sha256: null, dirty_paths: [] } : {}),
        compiler: payload,
      });
      const before = structuredClone(build);
      fs.writeFileSync(join(config.stackRepos.SHUD, "configured-only.txt"), payload);
      fs.writeFileSync(join(config.stackRepos.rSHUD, "r-only.txt"), "rSHUD dirty bytes\n");
      const indexes = repoNames.map((name) =>
        snapshot(join(config.stackRepos[name], ".git", "index")),
      );
      const legacy = captureStackLock(config, llm);
      const result = captureStackLock(config, llm, build);
      expect(result).toEqual({
        ...legacy,
        stack_id: secondId,
        fingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) as unknown,
        build_id: buildCase.id,
        repos: {
          ...legacy.repos,
          SHUD: {
            commit: "1111111111111111111111111111111111111111",
            branch: "work/build-documentation",
            dirty: kind === "candidate",
            dirty_paths: kind === "base" ? [] : ["docs/build.md", "scripts/build.sh"],
            dirty_paths_truncated: false,
          },
        },
      });
      expect(result.fingerprint).not.toBe(legacy.fingerprint);
      expect(result.repos.rSHUD).toEqual({
        ...cleanRevision("rSHUD"),
        dirty: true,
        dirty_paths: ["r-only.txt"],
      });
      expect(result.repos.AutoSHUD).toEqual(cleanRevision("AutoSHUD"));
      expect(StackLockSchema.parse(result)).toEqual(result);
      expect(readWorkspaceRecord(config.cwd, "stack", result.stack_id)).toEqual(result);
      expect(JSON.parse(fs.readFileSync(join(stacks, `${result.stack_id}.json`), "utf8"))).toEqual(
        result,
      );
      expect(fs.readFileSync(join(stacks, `${result.stack_id}.json`), "utf8")).not.toContain(
        payload,
      );
      expect(fs.existsSync(join(config.cwd, "builds"))).toBe(false);
      expect(build).toEqual(before);
      expect(
        repoNames.map((name) => snapshot(join(config.stackRepos[name], ".git", "index"))),
      ).toEqual(indexes);
    },
  );

  test("same-source build IDs distinguish locks, and each repeat retains bytes, time and model", () => {
    const firstBuild = BuildRecordSchema.parse(buildCase.value);
    const id = "BUILD-20261102T090000-f6a7";
    const secondBuild = BuildRecordSchema.parse({
      ...buildCase.value,
      build_id: id,
      binary_path: `builds/${id}/shud`,
      stdout_path: `builds/${id}/make.stdout.log`,
      stderr_path: `builds/${id}/make.stderr.log`,
    });
    const first = captureStackLock(config, llm, firstBuild);
    const second = captureStackLock(config, llm, secondBuild);
    expect(first.build_id).toBe(firstBuild.build_id);
    expect(second.build_id).toBe(secondBuild.build_id);
    expect(first.stack_id).toBe(firstId);
    expect(second.stack_id).toBe(secondId);
    expect(second.repos).toEqual(first.repos);
    expect(second.fingerprint).not.toBe(first.fingerprint);
    const before = inventory();
    vi.setSystemTime(new Date("2026-10-28T12:00:00Z"));
    // The configured checkout is irrelevant even after it changes between captures.
    fs.writeFileSync(join(config.stackRepos.SHUD, "later.txt"), "not the build source\n");
    expect(captureStackLock(config, { response_model: "new-model" }, firstBuild)).toEqual(first);
    expect(captureStackLock(config, { response_model: "new-model" }, secondBuild)).toEqual(second);
    expect(inventory()).toEqual(before);
  });

  test.each(["missing", "empty repository", "non-Git directory"] as const)(
    "%s configured SHUD is bypassed only when a build is supplied",
    (kind) => {
      const path = join(root, "unavailable-SHUD");
      if (kind === "empty repository") git(root, "init", "-q", "-b", "main", path);
      if (kind === "non-Git directory") {
        fs.mkdirSync(path);
        fs.writeFileSync(join(path, "not-a-repository.txt"), payload);
      }
      config.stackRepos.SHUD = path;
      const build = BuildRecordSchema.parse(buildCase.value);
      const result = captureStackLock(config, llm, build);
      expect(result.build_id).toBe(build.build_id);
      expect(result.repos.SHUD.commit).toBe(build.source_commit);
      const before = inventory();
      expect(caught(() => captureStackLock(config, llm)).message).toContain(path);
      expect(inventory()).toEqual(before);
      expect(fs.existsSync(join(config.cwd, "builds"))).toBe(false);
    },
  );

  test.each([undefined, "", "relative/SHUD"])(
    "build mode still rejects malformed configured SHUD path %j",
    (path) => {
      if (path === undefined) Reflect.deleteProperty(config.stackRepos, "SHUD");
      else config.stackRepos.SHUD = path;
      const build = BuildRecordSchema.parse(buildCase.value);
      expect(() => captureStackLock(config, llm, build)).toThrow();
      expect(existingFiles()).toEqual([]);
    },
  );

  test.each(["rSHUD", "AutoSHUD"] as const)(
    "build mode still fails closed for an empty %s repository",
    (name) => {
      const path = join(root, `empty-${name}`);
      git(root, "init", "-q", "-b", "main", path);
      config.stackRepos[name] = path;
      config.stackRepos.SHUD = join(root, "missing-SHUD");
      const build = BuildRecordSchema.parse({ ...buildCase.value, compiler: payload });
      const error = caught(() => captureStackLock(config, llm, build));
      expect(error.message).toContain(path);
      expect(inspect(error, { depth: 10 })).not.toContain(payload);
      expect(existingFiles()).toEqual([]);
      expect(fs.existsSync(stacks)).toBe(false);
    },
  );

  test("all dirty paths retain code-point order and the returned lock is detached from the build", () => {
    const paths = [
      ...Array.from(
        { length: 130 },
        (_, index) => `src/file-${String(index).padStart(3, "0")}.cpp`,
      ),
      "src/\ue000.cpp",
      "src/\u{10000}.cpp",
    ];
    // The last pair is code-point sorted but reverses under Array.prototype.sort().
    const build = BuildRecordSchema.parse({ ...buildCase.value, dirty_paths: paths });
    const before = structuredClone(build);
    Object.freeze(build.dirty_paths);
    Object.freeze(build);
    const result = captureStackLock(config, llm, build);
    expect(result.build_id).toBe(build.build_id);
    expect(result.repos.SHUD.dirty_paths).toEqual(paths);
    expect(result.repos.SHUD.dirty_paths_truncated).toBe(false);
    expect(result.repos.SHUD.dirty).toBe(true);
    expect(result.repos.SHUD.dirty_paths).not.toBe(build.dirty_paths);
    expect(build).toEqual(before);
    const disk = snapshot(join(stacks, `${result.stack_id}.json`));
    result.repos.SHUD.dirty_paths.push("zz-output-only.txt");
    expect(build).toEqual(before);
    expect(snapshot(join(stacks, `${result.stack_id}.json`))).toEqual(disk);
    expect(
      readWorkspaceRecord(config.cwd, "stack", result.stack_id).repos.SHUD.dirty_paths,
    ).toEqual(paths);
  });

  test.each(["build_id", "dirty_paths"] as const)(
    "invalid projected %s fails output validation without publication or payload disclosure",
    (field) => {
      const valid = BuildRecordSchema.parse(buildCase.value);
      // Deliberately violate only a projected field, not the caller's full BuildRecord contract.
      const invalid = {
        ...valid,
        [field]: field === "build_id" ? payload : [`../${payload}`],
      } as BuildRecord;
      const error = caught(() => captureStackLock(config, llm, invalid));
      expect(inspect(error, { depth: 10 })).not.toContain(payload);
      expect(existingFiles()).toEqual([]);
    },
  );

  test("build mode rejects corrupt existing evidence even when a matching lock exists", () => {
    const build = BuildRecordSchema.parse(buildCase.value);
    const original = captureStackLock(config, llm, build);
    expect(original.build_id).toBe(build.build_id);
    fs.writeFileSync(join(stacks, "STACK-20261027T080006-ffff.json"), `{${payload}`);
    const before = inventory();
    const error = caught(() => captureStackLock(config, llm, build));
    expect(inspect(error, { depth: 10 })).not.toContain(payload);
    expect(inventory()).toEqual(before);
  });

  test("build mode selects the smallest matching ID without rewriting any duplicate", () => {
    const build = BuildRecordSchema.parse(buildCase.value);
    const original = captureStackLock(config, llm, build);
    expect(original.build_id).toBe(build.build_id);
    persist(original, largerId);
    persist(
      { ...original, llm: { ...original.llm, response_model: "retained-model" } },
      smallestId,
    );
    const before = inventory();
    const selected = captureStackLock(config, { response_model: "new-model" }, build);
    expect(selected.stack_id).toBe(smallestId);
    expect(selected.llm.response_model).toBe("retained-model");
    expect(selected).toEqual(readWorkspaceRecord(config.cwd, "stack", smallestId));
    expect(inventory()).toEqual(before);
  });

  test("no build retains exact capture fields and reuses an M3 file without adding build_id", () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    const original = captureStackLock(config, llm);
    expect(original).toEqual({
      stack_id: firstId,
      repos: {
        SHUD: cleanRevision("SHUD"),
        rSHUD: cleanRevision("rSHUD"),
        AutoSHUD: cleanRevision("AutoSHUD"),
      },
      runtime: {
        os: `${type()} ${release()}`,
        sundials_version: null,
        host_version: config.hostVersion,
      },
      harness: { version: manifest.version },
      llm: { ...config.llm, response_model: llm.response_model },
      build_id: null,
      fingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) as unknown,
      created_at: "2026-10-27T08:00:05.987Z",
    });
    const { build_id, ...legacy } = original;
    expect(build_id).toBeNull();
    const path = join(stacks, `${original.stack_id}.json`);
    fs.writeFileSync(path, `${JSON.stringify(legacy, null, 2)}\n`);
    fs.utimesSync(path, 1_600_000_000, 1_600_000_000);
    const before = inventory();
    vi.setSystemTime(new Date("2026-10-28T12:00:00Z"));
    expect(readWorkspaceRecord(config.cwd, "stack", original.stack_id)).toEqual(original);
    expect(captureStackLock(config, { response_model: "new-model" })).toEqual(original);
    expect(inventory()).toEqual(before);
    expect(JSON.parse(fs.readFileSync(path, "utf8"))).not.toHaveProperty("build_id");
  });

  test("the independently frozen no-build canonical fingerprint remains unchanged", () => {
    // Frozen old-built capture, independently hashed before this change; no local evidence dependency.
    const legacy = {
      ...stackCase.value,
      repos: {
        SHUD: { ...stackCase.value.repos.SHUD, commit: "255ec82727b38b90f41f915288ae795e7433785d" },
        rSHUD: {
          ...stackCase.value.repos.rSHUD,
          commit: "85a60e24ce8529cec4f6fdad8a643b5f305f77a7",
        },
        AutoSHUD: {
          ...stackCase.value.repos.AutoSHUD,
          commit: "f4339f908ed03264d13ba1e26a279c3549dbf2f7",
        },
      },
      llm: {
        base_url: "https://www.dmxapi.cn",
        request_alias: "deepseek-flash-guan",
        response_model: "deepseek-flash-guan",
      },
    };
    expect(legacy).not.toHaveProperty("build_id");
    expect(computeStackFingerprint(StackLockSchema.parse(legacy))).toBe(
      "sha256:930a305a90cc3deba7bbb73059b28d1c7d1087926c2c99e45132d14d3a896e61",
    );
  });
});
