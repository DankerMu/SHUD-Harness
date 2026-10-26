import { execFileSync, spawnSync } from "node:child_process";
import { fstatSync } from "node:fs";
import * as io from "node:fs/promises";
import type * as NodeIo from "node:fs/promises";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { readExit } from "./shud-exit.ts";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof NodeIo>();
  return { ...actual, open: vi.fn(actual.open) };
});
const actualIo = await vi.importActual<typeof NodeIo>("node:fs/promises");

let root: string;
let runDir: string;
let path: string;

beforeEach(async () => {
  vi.mocked(io.open).mockReset().mockImplementation(actualIo.open);
  root = await mkdtemp(join(tmpdir(), "shud-exit-test-"));
  runDir = join(root, "run");
  path = join(runDir, "exit_code");
  await mkdir(runDir);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test.each([
  ["0\n", 0],
  ["7\n", 7],
  ["-7\n", -7],
  [" +7 \n", 7],
  ["9007199254740991\n", 9007199254740991],
  ["-9007199254740991\n", -9007199254740991],
])("regular exit evidence %j yields %s without changing its bytes", async (text, code) => {
  await writeFile(path, text);
  expect(await readExit(runDir)).toEqual({ code });
  expect(await readFile(path, "utf8")).toBe(text);
});

test("missing exit evidence is absent", async () => {
  expect(await readExit(runDir)).toBeUndefined();
});

test.each(["", " \n", "7trailing\n", "1.5\n", "9007199254740992\n"])(
  "invalid integer evidence %j stays invalid and unchanged",
  async (text) => {
    await writeFile(path, text);
    const result = await readExit(runDir);
    expect(result?.kind).toBe("invalid");
    expect(result?.error).toBeInstanceOf(Error);
    expect(result).not.toHaveProperty("code");
    expect(await readFile(path, "utf8")).toBe(text);
  },
);

test("a linked external zero is unreadable rather than authoritative exit evidence", async () => {
  const external = join(root, "external-exit-code");
  await writeFile(external, "0\n");
  await symlink(external, path);
  const result = await readExit(runDir);
  expect(await readFile(external, "utf8")).toBe("0\n");
  expect(result?.kind).toBe("unreadable");
  expect(result?.error).toBeInstanceOf(Error);
  expect(result).not.toHaveProperty("code");
});

test("dangling linked exit evidence is unreadable, not absent", async () => {
  await symlink(join(root, "missing-target"), path);
  const result = await readExit(runDir);
  expect(result?.kind).toBe("unreadable");
  expect(result?.error).toBeInstanceOf(Error);
  expect(result).not.toHaveProperty("code");
});

test("a directory cannot supply exit evidence", async () => {
  await mkdir(path);
  const result = await readExit(runDir);
  expect(result?.kind).toBe("unreadable");
  expect(result?.error).toBeInstanceOf(Error);
  expect(result).not.toHaveProperty("code");
});

test.each(["valid", "invalid", "directory"] as const)(
  "%s exit evidence leaves no acquired descriptor open",
  async (kind) => {
    if (kind === "directory") await mkdir(path);
    else await writeFile(path, kind === "valid" ? "7\n" : "invalid\n");
    let fd = -1;
    let close: (() => Promise<void>) | undefined;
    vi.mocked(io.open).mockImplementation(async (...args) => {
      const handle = await actualIo.open(...args);
      if (args[0] === path) {
        fd = handle.fd;
        close = handle.close.bind(handle);
      }
      return handle;
    });
    try {
      const result = await readExit(runDir);
      if (kind === "valid") expect(result).toEqual({ code: 7 });
      else {
        expect(result?.kind).toBe(kind === "invalid" ? "invalid" : "unreadable");
        expect(result?.error).toBeInstanceOf(Error);
        expect(result).not.toHaveProperty("code");
      }
      expect(fd).toBeGreaterThanOrEqual(0);
      expect(() => fstatSync(fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
    } finally {
      await close?.();
    }
  },
);

test.each(["EACCES", "EIO"])("opening exit evidence with %s returns unreadable", async (code) => {
  await writeFile(path, "7\n");
  const failure = Object.assign(new Error("injected open failure"), { code });
  vi.mocked(io.open).mockImplementation(async (...args) => {
    if (args[0] === path) throw failure;
    return actualIo.open(...args);
  });
  const result = await readExit(runDir);
  expect(result?.kind).toBe("unreadable");
  expect(result?.error).toBeInstanceOf(Error);
  expect(result).not.toHaveProperty("code");
  expect(result?.error?.cause).toBe(failure);
  expect(await readFile(path, "utf8")).toBe("7\n");
});

test.each([
  ["stat", "EIO"],
  ["stat", "ENOENT"],
  ["read", "EIO"],
  ["read", "ENOENT"],
  ["close", "EIO"],
  ["close", "ENOENT"],
] as const)("%s failure %s cannot authorize an exit code or absence", async (operation, code) => {
  await writeFile(path, "7\n");
  const failure = Object.assign(new Error("injected descriptor failure"), { code });
  let fd = -1;
  let close: (() => Promise<void>) | undefined;
  vi.mocked(io.open).mockImplementation(async (...args) => {
    const handle = await actualIo.open(...args);
    if (args[0] === path) {
      fd = handle.fd;
      close = handle.close.bind(handle);
      if (operation === "stat") vi.spyOn(handle, "stat").mockRejectedValue(failure);
      else if (operation === "read") vi.spyOn(handle, "readFile").mockRejectedValue(failure);
      else vi.spyOn(handle, "close").mockRejectedValue(failure);
    }
    return handle;
  });
  try {
    const result = await readExit(runDir);
    expect(result?.kind).toBe("unreadable");
    expect(result?.error).toBeInstanceOf(Error);
    expect(result).not.toHaveProperty("code");
    expect(result?.error?.cause).toBe(failure);
    expect(fd).toBeGreaterThanOrEqual(0);
    if (operation !== "close")
      expect(() => fstatSync(fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
    expect(await readFile(path, "utf8")).toBe("7\n");
  } finally {
    // A failed close cannot prove release; explicitly release the real handle after the assertion.
    await close?.();
  }
});

test("a writerless FIFO returns unreadable without waiting for a writer", async () => {
  function readInChild(directory: string) {
    // The native child is killed and reaped on timeout, even if its fs worker blocks.
    return spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
            // Eval has no module-relative base; the parent supplies the reader's file URL.
            const { readExit } = await import(process.argv[1]);
            const result = await readExit(process.argv[2]);
            console.log(JSON.stringify(result === undefined
              ? { absent: true }
              : { ...result, error: result.error?.message }));
          `,
        new URL("./shud-exit.ts", import.meta.url).href,
        directory,
      ],
      { encoding: "utf8", timeout: 2000, killSignal: "SIGKILL" },
    );
  }

  await writeFile(path, "7\n");
  const control = readInChild(runDir);
  expect(control.error, control.stderr).toBeUndefined();
  expect(control.signal, control.stderr).toBeNull();
  expect(control.status, control.stderr).toBe(0);
  expect(JSON.parse(control.stdout)).toEqual({ code: 7 });
  expect(await readFile(path, "utf8")).toBe("7\n");

  await rm(path);
  execFileSync("mkfifo", [path]);
  const result = readInChild(runDir);
  expect(result.error, `FIFO reader must finish before timeout: ${result.stderr}`).toBeUndefined();
  expect(result.signal, result.stderr).toBeNull();
  expect(result.status, result.stderr).toBe(0);
  const evidence: unknown = JSON.parse(result.stdout);
  expect(evidence).toMatchObject({ kind: "unreadable" });
  expect(evidence).not.toHaveProperty("code");
}, 10000);
