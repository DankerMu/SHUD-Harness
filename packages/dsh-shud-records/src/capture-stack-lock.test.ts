import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import { basename, dirname, join } from "node:path";
import { devNull, release, tmpdir, type } from "node:os";
import { inspect } from "node:util";
import type * as NodeCrypto from "node:crypto";
import type * as NodeFs from "node:fs";
import type * as NodeChildProcess from "node:child_process";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { StackLockSchema, type StackLock } from "@shud-harness/dsh-shud-core";
import { captureStackLock, readWorkspaceRecord } from "./index.ts";
import { installUnsafe, stackCase, unsafeKinds } from "./test-harness.ts";

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
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof NodeFs>();
  return {
    ...actual,
    lstatSync: vi.fn(actual.lstatSync),
    openSync: vi.fn(actual.openSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    fsyncSync: vi.fn(actual.fsyncSync),
    closeSync: vi.fn(actual.closeSync),
    readFileSync: vi.fn(actual.readFileSync),
    rmSync: vi.fn(actual.rmSync),
  };
});
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof NodeChildProcess>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

const realFs = await vi.importActual<typeof NodeFs>("node:fs");
const realChildProcess = await vi.importActual<typeof NodeChildProcess>("node:child_process");
const repoNames = ["SHUD", "rSHUD", "AutoSHUD"] as const;
const firstId = "STACK-20261027T080005-3f9c";
const secondId = "STACK-20261027T080005-abcd";
const thirdId = "STACK-20261027T080005-1234";
const smallestId = "STACK-20261027T080001-a000";
const largerId = "STACK-20261027T080001-b000";
const payload = "private-fixture-payload-must-not-escape";
const llm = { response_model: "configured-response", response_model_source: "configured" as const };
type CaptureConfig = Parameters<typeof captureStackLock>[0];
let root: string;
let cwd: string;
let stacks: string;
let config: CaptureConfig;
let descriptors: number[];

function git(directory: string, ...args: string[]): string {
  return realChildProcess
    .execFileSync("git", ["-C", directory, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    .trim();
}

function committedRepo(name: string, gitfile = false): string {
  const repo = join(root, name);
  git(
    root,
    "init",
    "-q",
    "-b",
    "main",
    ...(gitfile ? ["--separate-git-dir", join(root, `${name}.git`)] : []),
    repo,
  );
  realFs.writeFileSync(join(repo, "model.txt"), `${name} model bytes\n`);
  git(repo, "add", "model.txt");
  git(
    repo,
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
  return repo;
}

beforeEach(() => {
  root = realFs.realpathSync(realFs.mkdtempSync(join(tmpdir(), "records-capture-")));
  cwd = join(root, "workspace");
  stacks = join(cwd, "stacks");
  realFs.mkdirSync(cwd);
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
  descriptors = [];
  vi.mocked(fs.lstatSync).mockReset().mockImplementation(realFs.lstatSync);
  vi.mocked(fs.openSync)
    .mockReset()
    .mockImplementation((...args) => {
      const fd = realFs.openSync(...args);
      descriptors.push(fd);
      return fd;
    });
  vi.mocked(fs.writeFileSync).mockReset().mockImplementation(realFs.writeFileSync);
  vi.mocked(fs.fsyncSync).mockReset().mockImplementation(realFs.fsyncSync);
  vi.mocked(fs.closeSync).mockReset().mockImplementation(realFs.closeSync);
  vi.mocked(fs.readFileSync).mockReset().mockImplementation(realFs.readFileSync);
  vi.mocked(fs.rmSync).mockReset().mockImplementation(realFs.rmSync);
  vi.mocked(childProcess.execFileSync)
    .mockReset()
    .mockImplementation(realChildProcess.execFileSync);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-27T08:00:05.987Z"));
  entropy.suffixes = ["3f9c", "abcd", "1234", "ffff"];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const fd of descriptors) {
    try {
      realFs.closeSync(fd);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EBADF")) throw error;
    }
  }
  realFs.rmSync(root, { recursive: true, force: true });
});

interface FileSnapshot {
  bytes: Buffer;
  mtimeNs: bigint;
  ino: bigint;
}

function snapshot(path: string): FileSnapshot {
  return {
    bytes: realFs.readFileSync(path),
    mtimeNs: realFs.statSync(path, { bigint: true }).mtimeNs,
    ino: realFs.statSync(path, { bigint: true }).ino,
  };
}

function existingFiles(): string[] {
  return realFs.existsSync(stacks) ? realFs.readdirSync(stacks).sort() : [];
}

function expectClosed(): void {
  expect(descriptors.length).toBeGreaterThan(0);
  for (const fd of descriptors) expect(() => realFs.fstatSync(fd)).toThrow();
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

function persist(lock: StackLock, id: string): string {
  const value = StackLockSchema.parse({ ...lock, stack_id: id });
  const path = join(stacks, `${id}.json`);
  realFs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  realFs.utimesSync(path, 1_600_000_000, 1_600_000_000);
  return path;
}

function headerPath(): string {
  const sundialsRoot = join(root, "sundials");
  config = { ...config, sundialsRoot };
  const header = join(sundialsRoot, "include", "sundials", "sundials_config.h");
  realFs.mkdirSync(dirname(header), { recursive: true });
  return header;
}

describe("captureStackLock", () => {
  test("captures three real repositories and exact configured, OS and root-manifest fields", () => {
    realFs.writeFileSync(join(cwd, "package.json"), '{"version":"not-the-harness"}\n');
    const indexes = repoNames.map((name) =>
      snapshot(join(config.stackRepos[name], ".git", "index")),
    );
    const manifest = JSON.parse(
      realFs.readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    const supplied = {
      ...config,
      apiKey: payload,
      llm: { ...config.llm, api_key: payload },
    };
    const suppliedLlm = { ...llm, api_key: payload };
    const result: StackLock = captureStackLock(supplied, suppliedLlm);
    expect(StackLockSchema.parse(result)).toEqual(result);
    expect(result.stack_id).toBe(firstId);
    expect(result.created_at).toBe("2026-10-27T08:00:05.987Z");
    expect(result.runtime).toEqual({
      os: `${type()} ${release()}`,
      sundials_version: null,
      host_version: config.hostVersion,
    });
    expect(result.harness).toEqual({ version: manifest.version });
    expect(result.llm).toEqual({ ...config.llm, response_model: llm.response_model });
    for (const [index, name] of repoNames.entries()) {
      expect(result.repos[name]).toEqual({
        commit: git(config.stackRepos[name], "rev-parse", "HEAD"),
        branch: "main",
        dirty: false,
        dirty_paths: [],
        dirty_paths_truncated: false,
      });
      expect(snapshot(join(config.stackRepos[name], ".git", "index"))).toEqual(indexes[index]);
    }
    expect(result.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
    const path = join(stacks, `${result.stack_id}.json`);
    const bytes = realFs.readFileSync(path, "utf8");
    expect(bytes.endsWith("\n")).toBe(true);
    expect(JSON.parse(bytes)).toEqual(result);
    expect(bytes).not.toContain(payload);
    expect(bytes).not.toContain("response_model_source");
    expect(realFs.statSync(path).mode & 0o777).toBe(0o600);
    expect(readWorkspaceRecord(cwd, "stack", result.stack_id)).toEqual(result);
    expect(existingFiles()).toEqual([`${firstId}.json`]);
    expectClosed();
  });

  test("unchanged and response-only captures reuse all original bytes, timestamp and model", () => {
    const original = captureStackLock(config, llm);
    const path = join(stacks, `${original.stack_id}.json`);
    const before = snapshot(path);
    vi.setSystemTime(new Date("2026-10-28T12:00:00Z"));
    expect(captureStackLock(config, llm)).toEqual(original);
    expect(captureStackLock(config, { ...llm, response_model: "different-response" })).toEqual(
      original,
    );
    expect(snapshot(path)).toEqual(before);
    expect(existingFiles()).toEqual([`${original.stack_id}.json`]);
  });

  test("an untracked path creates a new lock, but changing its bytes alone does not", () => {
    const clean = captureStackLock(config, llm);
    const before = snapshot(join(stacks, `${clean.stack_id}.json`));
    const dirtyPath = join(config.stackRepos.rSHUD, "new input.txt");
    realFs.writeFileSync(dirtyPath, "first dirty bytes\n");
    const dirty = captureStackLock(config, llm);
    expect(dirty.stack_id).toBe(secondId);
    expect(dirty.fingerprint).not.toBe(clean.fingerprint);
    expect(dirty.repos.rSHUD).toEqual({
      ...clean.repos.rSHUD,
      dirty: true,
      dirty_paths: ["new input.txt"],
    });
    realFs.writeFileSync(dirtyPath, "different dirty bytes\n");
    expect(captureStackLock(config, llm)).toEqual(dirty);
    expect(snapshot(join(stacks, `${clean.stack_id}.json`))).toEqual(before);
    expect(existingFiles()).toEqual([`${firstId}.json`, `${secondId}.json`].sort());
  });

  test("accepts a real gitfile checkout without changing its index", () => {
    const repo = committedRepo("gitfile", true);
    config.stackRepos.rSHUD = repo;
    const index = join(root, "gitfile.git", "index");
    const before = snapshot(index);
    expect(realFs.lstatSync(join(repo, ".git")).isFile()).toBe(true);
    expect(captureStackLock(config, llm).repos.rSHUD).toEqual({
      commit: git(repo, "rev-parse", "HEAD"),
      branch: "main",
      dirty: false,
      dirty_paths: [],
      dirty_paths_truncated: false,
    });
    expect(snapshot(index)).toEqual(before);
  });

  test("matching duplicates select the smallest id, not creation or enumeration order", () => {
    const original = captureStackLock(config, llm);
    const larger = persist(original, largerId);
    const smaller = persist(
      { ...original, llm: { ...original.llm, response_model: "retained-model" } },
      smallestId,
    );
    const before = existingFiles().map((file) => [file, snapshot(join(stacks, file))]);
    const selected = captureStackLock(config, { ...llm, response_model: "new-model" });
    expect(selected.stack_id).toBe(smallestId);
    expect(selected.llm.response_model).toBe("retained-model");
    expect(selected).toEqual(readWorkspaceRecord(cwd, "stack", smallestId));
    expect(existingFiles().map((file) => [file, snapshot(join(stacks, file))])).toEqual(before);
    expect(realFs.existsSync(larger)).toBe(true);
    expect(realFs.existsSync(smaller)).toBe(true);
  });

  test.each(["plain directory", "unborn repository", "uninitialized submodule"] as const)(
    "%s fails with the affected configured path and no published lock",
    (kind) => {
      const invalid =
        kind === "uninitialized submodule"
          ? join(config.stackRepos.SHUD, "uninitialized")
          : join(root, "invalid-repo");
      if (kind === "unborn repository") git(root, "init", "-q", "-b", "main", invalid);
      else realFs.mkdirSync(invalid);
      config.stackRepos.rSHUD = invalid;
      expect(caught(() => captureStackLock(config, llm)).message).toContain(invalid);
      expect(existingFiles()).toEqual([]);
    },
  );

  test("repository subprocess payloads cannot escape in errors or logging", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(childProcess.execFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error(payload), { stderr: payload, stdout: payload, status: 128 });
    });
    const error = caught(() => captureStackLock(config, llm));
    expect(error.message).toContain(config.stackRepos.SHUD);
    expect(inspect(error, { depth: 10 })).not.toContain(payload);
    expect(inspect([log.mock.calls, warn.mock.calls, errorLog.mock.calls])).not.toContain(payload);
    expect(existingFiles()).toEqual([]);
  });

  test.each([
    "cwd",
    "hostVersion",
    "stackRepos.SHUD",
    "stackRepos.rSHUD",
    "stackRepos.AutoSHUD",
    "llm.base_url",
    "llm.request_alias",
  ])("missing or empty %s fails with a key diagnostic and no publication", (key) => {
    for (const value of [undefined, ""]) {
      const invalid = structuredClone(config);
      const [group, field] = key.split(".");
      const target: object =
        group === "stackRepos" ? invalid.stackRepos : group === "llm" ? invalid.llm : invalid;
      const property = field ?? key;
      if (value === undefined) Reflect.deleteProperty(target, property);
      else Reflect.set(target, property, value);
      expect(caught(() => captureStackLock(invalid, llm)).message).toContain(key);
      expect(existingFiles()).toEqual([]);
    }
  });

  test.each(["cwd", "SHUD", "rSHUD", "AutoSHUD"] as const)(
    "relative %s is not resolved against process cwd",
    (key) => {
      if (key === "cwd") config.cwd = "relative-workspace";
      else config.stackRepos[key] = "relative-repository";
      expect(() => captureStackLock(config, llm)).toThrow();
      expect(existingFiles()).toEqual([]);
    },
  );

  test.each(["stackRepos", "llm"] as const)(
    "missing %s group fails with a controlled key diagnostic",
    (key) => {
      const invalid = structuredClone(config);
      Reflect.deleteProperty(invalid, key);
      const error = caught(() => captureStackLock(invalid, llm));
      expect(error.message).toContain(key);
      expect(existingFiles()).toEqual([]);
    },
  );

  test("missing or empty response_model fails before publication", () => {
    for (const supplied of [{}, { response_model: "" }]) {
      expect(caught(() => captureStackLock(config, supplied as typeof llm)).message).toContain(
        "response_model",
      );
      expect(existingFiles()).toEqual([]);
    }
  });

  test("a configured but absent SUNDIALS header produces null", () => {
    headerPath();
    expect(captureStackLock(config, llm).runtime.sundials_version).toBeNull();
  });

  test("a quoted SUNDIALS version is captured, and changing it creates a new lock", () => {
    const header = headerPath();
    realFs.writeFileSync(header, '#define SUNDIALS_VERSION "6.0.0"\n');
    const first = captureStackLock(config, llm);
    expect(first.runtime.sundials_version).toBe("6.0.0");
    realFs.writeFileSync(header, '#define SUNDIALS_VERSION "7.1.2"\n');
    const second = captureStackLock(config, llm);
    expect(second.runtime.sundials_version).toBe("7.1.2");
    expect(second.stack_id).not.toBe(first.stack_id);
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  test.each(["", "#define OTHER_VERSION 6\n", "#define SUNDIALS_VERSION 6.0.0\n"])(
    "an existing malformed header %j cannot become null",
    (text) => {
      const header = headerPath();
      realFs.writeFileSync(header, text);
      const before = snapshot(header);
      expect(() => captureStackLock(config, llm)).toThrow();
      expect(existingFiles()).toEqual([]);
      expect(snapshot(header)).toEqual(before);
    },
  );

  test("an unreadable existing header fails without exposing its raw error", () => {
    const header = headerPath();
    realFs.writeFileSync(header, '#define SUNDIALS_VERSION "6.0.0"\n');
    const before = snapshot(header);
    vi.mocked(fs.readFileSync).mockImplementation((...args) => {
      if (args[0] === header) throw Object.assign(new Error(payload), { code: "EACCES" });
      return realFs.readFileSync(...args);
    });
    const error = caught(() => captureStackLock(config, llm));
    expect(inspect(error, { depth: 10 })).not.toContain(payload);
    expect(snapshot(header)).toEqual(before);
    expect(existingFiles()).toEqual([]);
  });

  test.each(["corrupt JSON", "invalid schema", "unreadable", "mismatched id"] as const)(
    "a matching lock cannot hide a later %s entry",
    (kind) => {
      const original = captureStackLock(config, llm);
      const matching = persist(original, smallestId);
      const later = persist(original, largerId);
      if (kind === "corrupt JSON") realFs.writeFileSync(later, `{ ${payload}`);
      if (kind === "invalid schema")
        realFs.writeFileSync(later, JSON.stringify({ stack_id: largerId, secret: payload }));
      if (kind === "mismatched id") {
        const mismatched = StackLockSchema.parse({ ...original, stack_id: secondId });
        realFs.writeFileSync(later, `${JSON.stringify(mismatched)}\n`);
      }
      const before = existingFiles().map((file) => [file, snapshot(join(stacks, file))]);
      if (kind === "unreadable") {
        vi.mocked(fs.readFileSync).mockImplementation((...args) => {
          if (args[0] === later) throw Object.assign(new Error(payload), { code: "EACCES" });
          return realFs.readFileSync(...args);
        });
      }
      const error = caught(() => captureStackLock(config, llm));
      expect(inspect(error, { depth: 10 })).not.toContain(payload);
      expect(existingFiles().map((file) => [file, snapshot(join(stacks, file))])).toEqual(before);
      expect(realFs.existsSync(matching)).toBe(true);
    },
  );

  test.each(["notes.txt", "not-a-stack.json", "STACK-20261027T080001-a000.txt"])(
    "a non-record entry %s is not silently skipped after a match",
    (name) => {
      captureStackLock(config, llm);
      const path = join(stacks, name);
      realFs.writeFileSync(path, "unrecognized evidence\n");
      const before = snapshot(path);
      const files = existingFiles();
      expect(() => captureStackLock(config, llm)).toThrow();
      expect(existingFiles()).toEqual(files);
      expect(snapshot(path)).toEqual(before);
    },
  );

  test.each(unsafeKinds)("a %s stacks root fails without following or replacing it", (kind) => {
    const outside = join(root, "outside");
    realFs.mkdirSync(outside);
    const sentinel = join(outside, "sentinel");
    realFs.writeFileSync(sentinel, "foreign evidence\n");
    installUnsafe(stacks, kind, outside);
    const before = realFs.lstatSync(stacks, { bigint: true });
    const original = snapshot(sentinel);
    expect(() => captureStackLock(config, llm)).toThrow();
    expect(realFs.lstatSync(stacks, { bigint: true }).ino).toBe(before.ino);
    expect(snapshot(sentinel)).toEqual(original);
    expect(realFs.readdirSync(outside)).toEqual(["sentinel"]);
  });

  test.each(["symlink", "dangling-link", "directory", "fifo"] as const)(
    "a %s existing lock fails even after a valid match",
    (kind) => {
      const original = captureStackLock(config, llm);
      const prior = snapshot(join(stacks, `${original.stack_id}.json`));
      const outside = join(root, "outside.json");
      realFs.writeFileSync(outside, "foreign evidence\n");
      const foreign = snapshot(outside);
      const target = join(stacks, `${largerId}.json`);
      installUnsafe(target, kind, outside);
      const inode = realFs.lstatSync(target, { bigint: true }).ino;
      const files = existingFiles();
      expect(() => captureStackLock(config, llm)).toThrow();
      expect(existingFiles()).toEqual(files);
      expect(realFs.lstatSync(target, { bigint: true }).ino).toBe(inode);
      expect(snapshot(outside)).toEqual(foreign);
      expect(snapshot(join(stacks, `${original.stack_id}.json`))).toEqual(prior);
    },
  );

  test.each(["symlink", "dangling-link", "directory", "fifo"] as const)(
    "a newly allocated %s target is unsafe, not a retryable id collision",
    (kind) => {
      const outside = join(root, "outside.json");
      realFs.writeFileSync(outside, "foreign evidence\n");
      const foreign = snapshot(outside);
      const target = join(stacks, `${firstId}.json`);
      let installed = false;
      vi.mocked(fs.lstatSync).mockImplementation((...args) => {
        if (args[0] === target && !installed) {
          installUnsafe(target, kind, outside);
          installed = true;
        }
        return realFs.lstatSync(...args);
      });
      expect(() => captureStackLock(config, llm)).toThrow();
      expect(installed).toBe(true);
      expect(existingFiles()).toEqual([`${firstId}.json`]);
      expect(snapshot(outside)).toEqual(foreign);
      expect(entropy.suffixes).toEqual(["abcd", "1234", "ffff"]);
    },
  );

  test.each([1, 2, 3])(
    "%i genuine exclusive-open collisions preserve foreign files and obey the three-attempt budget",
    (collisions) => {
      const foreign = new Map<string, FileSnapshot>();
      realFs.mkdirSync(stacks);
      for (const id of [firstId, secondId, thirdId].slice(0, collisions)) {
        const path = persist(StackLockSchema.parse(stackCase.value), id);
        foreign.set(path, snapshot(path));
      }
      const attempted: string[] = [];
      vi.mocked(fs.openSync).mockImplementation((path, flags, mode) => {
        if (typeof path === "string" && dirname(path) === stacks) {
          attempted.push(basename(path));
        }
        const fd = realFs.openSync(path, flags, mode);
        descriptors.push(fd);
        return fd;
      });
      if (collisions === 3) {
        expect(caught(() => captureStackLock(config, llm)).message).toContain(stacks);
        expect(existingFiles()).toEqual(
          [firstId, secondId, thirdId].map((id) => `${id}.json`).sort(),
        );
      } else {
        const result = captureStackLock(config, llm);
        expect(result.stack_id).toBe(collisions === 1 ? secondId : thirdId);
        expect(readWorkspaceRecord(cwd, "stack", result.stack_id)).toEqual(result);
        expect(existingFiles()).toHaveLength(collisions + 1);
        expectClosed();
      }
      expect(attempted).toEqual(
        [firstId, secondId, thirdId]
          .slice(0, Math.min(collisions + 1, 3))
          .map((id) => `${id}.json`),
      );
      expect(entropy.suffixes).toEqual(collisions === 1 ? ["1234", "ffff"] : ["ffff"]);
      for (const [path, before] of foreign) expect(snapshot(path)).toEqual(before);
    },
  );

  test.each(["write", "fsync", "close"] as const)(
    "exclusive-create %s failure removes only owned output and closes descriptors",
    (stage) => {
      const original = captureStackLock(config, llm);
      const originalPath = join(stacks, `${original.stack_id}.json`);
      const before = snapshot(originalPath);
      realFs.writeFileSync(join(config.stackRepos.AutoSHUD, "changed.txt"), "new environment\n");
      descriptors = [];
      const target = join(stacks, `${secondId}.json`);
      let observed = false;
      const fail = () => {
        expect(realFs.existsSync(target)).toBe(true);
        expect(realFs.readFileSync(target).length).toBeGreaterThan(0);
        observed = true;
        throw Object.assign(new Error(payload), { code: "EIO" });
      };
      if (stage === "write") {
        vi.mocked(fs.writeFileSync).mockImplementationOnce((file) => {
          realFs.writeFileSync(file, "partial-owned-lock");
          fail();
        });
      } else if (stage === "fsync") vi.mocked(fs.fsyncSync).mockImplementationOnce(fail);
      else vi.mocked(fs.closeSync).mockImplementationOnce(fail);
      const error = caught(() => captureStackLock(config, llm));
      expect(observed).toBe(true);
      expect(inspect(error, { depth: 10 })).not.toContain(payload);
      expectClosed();
      expect(existingFiles()).toEqual([`${original.stack_id}.json`]);
      expect(snapshot(originalPath)).toEqual(before);
    },
  );

  test("failed removal retains owned partial bytes and controlled primary and cleanup errors", () => {
    const original = captureStackLock(config, llm);
    const originalPath = join(stacks, `${original.stack_id}.json`);
    const before = snapshot(originalPath);
    realFs.writeFileSync(join(config.stackRepos.AutoSHUD, "changed.txt"), "new environment\n");
    descriptors = [];
    const target = join(stacks, `${secondId}.json`);
    vi.mocked(fs.writeFileSync).mockImplementationOnce((file) => {
      realFs.writeFileSync(file, "partial-owned-lock");
      throw Object.assign(new Error(`${payload}-write`), { code: "EIO" });
    });
    vi.mocked(fs.rmSync).mockImplementation((path, options) => {
      if (path === target) {
        expect(realFs.readFileSync(target, "utf8")).toBe("partial-owned-lock");
        expectClosed();
        throw Object.assign(new Error(`${payload}-remove`), { code: "EACCES" });
      }
      realFs.rmSync(path, options);
    });
    const error = caught(() => captureStackLock(config, llm));
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw new Error("Expected cleanup aggregate");
    const failures: unknown[] = error.errors;
    expect(failures).toHaveLength(2);
    const [primary, cleanup] = failures;
    if (!(primary instanceof Error) || !(cleanup instanceof Error)) {
      throw new Error("Expected controlled primary and cleanup errors");
    }
    expect(primary.name).toBe("StackCaptureError");
    expect(primary.message).toContain("write");
    expect(cleanup.name).toBe("StackCaptureError");
    expect(cleanup.message).toContain("cleanup remove");
    expect(error.cause).toBe(failures[0]);
    expect(inspect(error, { depth: 10 })).not.toContain(payload);
    expectClosed();
    expect(realFs.readFileSync(target, "utf8")).toBe("partial-owned-lock");
    expect(existingFiles()).toEqual([`${firstId}.json`, `${secondId}.json`].sort());
    expect(snapshot(originalPath)).toEqual(before);
  });
});
