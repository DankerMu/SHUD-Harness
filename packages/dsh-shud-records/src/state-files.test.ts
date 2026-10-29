import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as io from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type * as NodeFs from "node:fs";
import type * as NodeIo from "node:fs/promises";
import type * as NodeCrypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readJson, writeJsonSync, writeJson, writeBytes } from "./state-files.ts";

vi.mock("node:crypto", async (original) => {
  const actual = await original<typeof NodeCrypto>();
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof NodeFs>();
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    fsyncSync: vi.fn(actual.fsyncSync),
    closeSync: vi.fn(actual.closeSync),
    renameSync: vi.fn(actual.renameSync),
    rmSync: vi.fn(actual.rmSync),
    readFileSync: vi.fn(actual.readFileSync),
  };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof NodeIo>();
  return {
    ...actual,
    open: vi.fn(actual.open),
    rename: vi.fn(actual.rename),
    rm: vi.fn(actual.rm),
  };
});
const realFs = await vi.importActual<typeof NodeFs>("node:fs");
const realIo = await vi.importActual<typeof NodeIo>("node:fs/promises");
const uuid = "00000000-0000-4000-8000-000000000437";
let root: string;
let target: string;
let temporary: string;
let descriptors: number[];
let handles: NodeIo.FileHandle[];

beforeEach(() => {
  vi.mocked(randomUUID).mockReset().mockReturnValue(uuid);
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
  vi.mocked(fs.renameSync).mockReset().mockImplementation(realFs.renameSync);
  vi.mocked(fs.rmSync).mockReset().mockImplementation(realFs.rmSync);
  vi.mocked(fs.readFileSync).mockReset().mockImplementation(realFs.readFileSync);
  vi.mocked(io.open)
    .mockReset()
    .mockImplementation(async (...args) => {
      const file = await realIo.open(...args);
      handles.push(file);
      return file;
    });
  vi.mocked(io.rename).mockReset().mockImplementation(realIo.rename);
  vi.mocked(io.rm).mockReset().mockImplementation(realIo.rm);
  root = realFs.mkdtempSync(join(tmpdir(), "records-atomic-"));
  target = join(root, "record.json");
  temporary = `${target}.${uuid}.tmp`;
  descriptors = [];
  handles = [];
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const file of handles) if (file.fd !== -1) await file.close();
  for (const fd of descriptors) {
    try {
      realFs.closeSync(fd);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EBADF")) throw error;
    }
  }
  realFs.rmSync(root, { recursive: true, force: true });
});

function expectClosed(): void {
  for (const fd of descriptors) expect(() => realFs.fstatSync(fd)).toThrow();
  for (const file of handles) expect(file.fd).toBe(-1);
}

function expectOriginal(): void {
  expect(realFs.readFileSync(target, "utf8")).toBe("original bytes\n");
  expect(realFs.readdirSync(root)).toEqual(["record.json"]);
  expectClosed();
}

test("readJson distinguishes absence, valid JSON, malformed JSON and IO failure without repair", () => {
  expect(readJson(target)).toBeUndefined();
  expect(realFs.readdirSync(root)).toEqual([]);
  realFs.writeFileSync(target, '{"retained":true}\n');
  expect(readJson(target)).toEqual({ retained: true });
  realFs.writeFileSync(target, "{ broken evidence");
  let parseError: unknown;
  try {
    readJson(target);
  } catch (error) {
    parseError = error;
  }
  expect(parseError).toBeInstanceOf(Error);
  if (!(parseError instanceof Error)) throw new Error("Expected JSON parse failure");
  expect(parseError.cause).toBeInstanceOf(SyntaxError);
  expect(realFs.readFileSync(target, "utf8")).toBe("{ broken evidence");
  const failure = Object.assign(new Error("unreadable"), { code: "EACCES" });
  vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
    throw failure;
  });
  let readError: unknown;
  try {
    readJson(target);
  } catch (error) {
    readError = error;
  }
  expect(readError).toBeInstanceOf(Error);
  if (!(readError instanceof Error)) throw new Error("Expected read failure");
  expect(readError.cause).toBe(failure);
  expect(realFs.readFileSync(target, "utf8")).toBe("{ broken evidence");
});

describe.each(["sync", "async"] as const)("%s atomic JSON writer", (mode) => {
  function write(value: unknown): void | Promise<void> {
    return mode === "sync" ? writeJsonSync(target, value) : writeJson(target, value);
  }

  test("publishes newline-terminated UTF-8 JSON with private permissions and no open resources", async () => {
    await write({ text: "流域", count: 2 });
    expect(realFs.readFileSync(target, "utf8")).toBe('{"text":"流域","count":2}\n');
    expect(realFs.statSync(target).mode & 0o777).toBe(0o600);
    expect(realFs.readdirSync(root)).toEqual(["record.json"]);
    expectClosed();
  });

  test("a colliding temporary file retains both its sentinel and the original target", async () => {
    realFs.writeFileSync(target, "original bytes\n");
    realFs.writeFileSync(temporary, "another writer owns this temporary\n");
    const before = realFs.statSync(temporary, { bigint: true });
    await expect(Promise.resolve().then(() => write({ next: true }))).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(realFs.readFileSync(temporary, "utf8")).toBe("another writer owns this temporary\n");
    expect(realFs.statSync(temporary, { bigint: true }).ino).toBe(before.ino);
    expect(realFs.statSync(temporary, { bigint: true }).mtimeNs).toBe(before.mtimeNs);
    expect(realFs.readFileSync(target, "utf8")).toBe("original bytes\n");
    expectClosed();
  });

  test("rename failure sees the real complete temporary, preserves the target and closes resources", async () => {
    realFs.writeFileSync(target, "original bytes\n");
    const failure = Object.assign(new Error("publication failure"), { code: "EIO" });
    let observed = false;
    const beforeRename = () => {
      expect(realFs.readFileSync(temporary, "utf8")).toBe('{"next":true}\n');
      expect(realFs.readFileSync(target, "utf8")).toBe("original bytes\n");
      expectClosed();
      observed = true;
      throw failure;
    };
    if (mode === "sync") vi.mocked(fs.renameSync).mockImplementationOnce(beforeRename);
    else vi.mocked(io.rename).mockImplementationOnce(beforeRename);
    await expect(Promise.resolve().then(() => write({ next: true }))).rejects.toBe(failure);
    expect(observed).toBe(true);
    expectOriginal();
  });

  test("a publication error and failed removal retain both failures and the original cause", async () => {
    realFs.writeFileSync(target, "original bytes\n");
    const primary = new Error("rename failed");
    const removal = new Error("temporary removal failed");
    if (mode === "sync") {
      vi.mocked(fs.renameSync).mockImplementationOnce(() => {
        throw primary;
      });
      vi.mocked(fs.rmSync).mockImplementationOnce(() => {
        throw removal;
      });
    } else {
      vi.mocked(io.rename).mockRejectedValueOnce(primary);
      vi.mocked(io.rm).mockRejectedValueOnce(removal);
    }
    const error: unknown = await Promise.resolve()
      .then(() => write({ next: true }))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw new Error("Expected cleanup aggregate");
    expect(error.errors).toEqual([primary, removal]);
    expect(error.cause).toBe(primary);
    expect(realFs.readFileSync(target, "utf8")).toBe("original bytes\n");
    expect(realFs.readFileSync(temporary, "utf8")).toBe('{"next":true}\n');
    expectClosed();
  });

  test("write failure plus close and removal failures preserve every cleanup error", async () => {
    realFs.writeFileSync(target, "original bytes\n");
    const primary = new Error("write failed");
    const closing = new Error("close failed");
    const removal = new Error("removal failed");
    if (mode === "sync") {
      vi.mocked(fs.writeFileSync).mockImplementationOnce(() => {
        throw primary;
      });
      vi.mocked(fs.closeSync).mockImplementationOnce(() => {
        throw closing;
      });
      vi.mocked(fs.rmSync).mockImplementationOnce(() => {
        throw removal;
      });
    } else {
      vi.mocked(io.open).mockImplementationOnce(async (...args) => {
        const file = await realIo.open(...args);
        handles.push(file);
        vi.spyOn(file, "writeFile").mockRejectedValueOnce(primary);
        vi.spyOn(file, "close").mockRejectedValueOnce(closing);
        return file;
      });
      vi.mocked(io.rm).mockRejectedValueOnce(removal);
    }
    const error: unknown = await Promise.resolve()
      .then(() => write({ next: true }))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw new Error("Expected cleanup aggregate");
    expect(error.errors).toEqual([primary, closing, removal]);
    expect(error.cause).toBe(primary);
    expect(realFs.readFileSync(target, "utf8")).toBe("original bytes\n");
    expect(realFs.existsSync(temporary)).toBe(true);
  });
});

test.each(["open", "write", "flush", "close"] as const)(
  "synchronous %s failure retains the original error, cleans the temporary and closes its descriptor",
  (phase) => {
    realFs.writeFileSync(target, "original bytes\n");
    const failure = new Error(`injected ${phase}`);
    const fail = () => {
      throw failure;
    };
    if (phase === "open") vi.mocked(fs.openSync).mockImplementationOnce(fail);
    if (phase === "write") vi.mocked(fs.writeFileSync).mockImplementationOnce(fail);
    if (phase === "flush") vi.mocked(fs.fsyncSync).mockImplementationOnce(fail);
    if (phase === "close") vi.mocked(fs.closeSync).mockImplementationOnce(fail);
    let caught: unknown;
    try {
      writeJsonSync(target, { next: true });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expectOriginal();
  },
);

test.each(["open", "writeFile", "sync", "close"] as const)(
  "asynchronous %s failure retains the original error, cleans the temporary and closes its handle",
  async (phase) => {
    realFs.writeFileSync(target, "original bytes\n");
    const failure = new Error(`injected ${phase}`);
    if (phase === "open") vi.mocked(io.open).mockRejectedValueOnce(failure);
    else {
      vi.mocked(io.open).mockImplementationOnce(async (...args) => {
        const file = await realIo.open(...args);
        handles.push(file);
        vi.spyOn(file, phase).mockRejectedValueOnce(failure);
        return file;
      });
    }
    await expect(writeBytes(target, new Uint8Array([0, 255, 13, 10]))).rejects.toBe(failure);
    expectOriginal();
  },
);

test("byte writes preserve Uint8Array view bounds, NUL, latin1 and mixed line endings", async () => {
  const backing = new Uint8Array([99, 0, 255, 233, 13, 10, 10, 88]);
  await writeBytes(target, backing.subarray(1, 7));
  expect([...realFs.readFileSync(target)]).toEqual([0, 255, 233, 13, 10, 10]);
  await writeBytes(target, Buffer.from("\xff\0END\r\n\t", "latin1"));
  expect([...realFs.readFileSync(target)]).toEqual([255, 0, 69, 78, 68, 13, 10, 9]);
  expect(realFs.readdirSync(root)).toEqual(["record.json"]);
  expectClosed();
});

test("string byte writes use UTF-8 without adding a JSON newline", async () => {
  await writeBytes(target, "é\0\r\n");
  expect([...realFs.readFileSync(target)]).toEqual([195, 169, 0, 13, 10]);
  expectClosed();
});
