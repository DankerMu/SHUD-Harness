import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readShudDat } from "./index.ts";
import { buildShudDat, datOracle } from "./shud-dat-test-harness.ts";
import { expectInputError, privateNative, privatePayload } from "./shud-text-test-harness.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    readSync: vi.fn(actual.readSync),
    readFileSync: vi.fn(actual.readFileSync),
    createReadStream: vi.fn(actual.createReadStream),
    closeSync: vi.fn(actual.closeSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    appendFileSync: vi.fn(actual.appendFileSync),
    renameSync: vi.fn(actual.renameSync),
    unlinkSync: vi.fn(actual.unlinkSync),
    truncateSync: vi.fn(actual.truncateSync),
    ftruncateSync: vi.fn(actual.ftruncateSync),
  };
});

const native = await vi.importActual<typeof fs>("node:fs");
const relative = "nested/mini.rivqdown.dat";
let root: string;
let base: string;
let file: string;
let outside: string;
let active: Set<number>;
let opened: number[];

function openOwned(...args: Parameters<typeof fs.openSync>): number {
  const fd = native.openSync(...args);
  active.add(fd);
  opened.push(fd);
  return fd;
}
function closeOwned(fd: number): void {
  native.closeSync(fd);
  active.delete(fd);
}
function snapshot(path: string) {
  const { dev, ino, mode, size, mtimeNs } = native.lstatSync(path, { bigint: true });
  return { dev, ino, mode, size, mtimeNs, bytes: native.readFileSync(path) };
}
function fault(code = "EIO"): never {
  throw Object.assign(new Error(privateNative, { cause: new Error(privatePayload) }), { code });
}
function read() {
  return readShudDat(base, relative);
}
function expectClosed(): void {
  expect(active.size).toBe(0);
  expect(fs.closeSync).toHaveBeenCalledTimes(opened.length);
  for (const fd of opened)
    expect(() => native.fstatSync(fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
}
function replaceBytes(bytes: Buffer): void {
  native.chmodSync(file, 0o600);
  native.writeFileSync(file, bytes);
}

beforeEach(() => {
  active = new Set();
  opened = [];
  vi.mocked(fs.openSync).mockReset().mockImplementation(openOwned);
  vi.mocked(fs.closeSync).mockReset().mockImplementation(closeOwned);
  vi.mocked(fs.readSync).mockReset().mockImplementation(native.readSync);
  root = native.realpathSync(native.mkdtempSync(`${tmpdir()}/shud-dat-io-`));
  base = `${root}/output`;
  file = `${base}/${relative}`;
  outside = `${root}/outside.dat`;
  native.mkdirSync(`${base}/nested`, { recursive: true });
  native.writeFileSync(file, buildShudDat(), { mode: 0o400 });
  native.writeFileSync(outside, "outside bytes must remain untouched");
  vi.clearAllMocks();
});
afterEach(() => {
  // Recovery after an injected close failure is not evidence of production closure.
  for (const fd of active) native.closeSync(fd);
  vi.restoreAllMocks();
  native.rmSync(root, { recursive: true, force: true });
});

describe("public .dat reader filesystem integration", () => {
  test("normalizes the relative path and binds decoded bytes, digest and size to one readonly pass", () => {
    const before = [snapshot(file), snapshot(outside)];
    let observed = 0;
    let eof = 0;
    vi.mocked(fs.readSync).mockImplementation((...args) => {
      const count = native.readSync(...args);
      observed += count;
      if (count === 0) eof += 1;
      return count;
    });
    const result = readShudDat(base, "./nested/../nested//mini.rivqdown.dat");
    expect(result.path).toBe(relative);
    expect(result.start_date).toBe(20000101);
    expect(result.rows.map((row) => [row.t_min, ...row.values])).toEqual([
      [0, 1.25, -2.5],
      [1440, 3, 4.5],
      [2880, -0, 6],
    ]);
    expect(result.sha256).toBe(datOracle.sha256);
    expect(result.size_bytes).toBe(1128);
    expect(observed).toBe(1128);
    expect(eof).toBe(1);
    expect(fs.openSync).toHaveBeenCalledExactlyOnceWith(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(fs.createReadStream).not.toHaveBeenCalled();
    for (const operation of [
      fs.writeFileSync,
      fs.appendFileSync,
      fs.renameSync,
      fs.unlinkSync,
      fs.truncateSync,
      fs.ftruncateSync,
    ])
      expect(operation).not.toHaveBeenCalled();
    expect([snapshot(file), snapshot(outside)]).toEqual(before);
    expectClosed();
  });

  test("keeps short multi-chunk reads complete without hashing slack or reading a second pass", () => {
    const rows = Array.from({ length: 3000 }, (_, i) => ({ t_min: i * 1440, values: [i, -i] }));
    const bytes = buildShudDat({ rows });
    replaceBytes(bytes);
    const before = snapshot(file);
    let observed = 0;
    let eof = 0;
    vi.mocked(fs.readSync).mockImplementation((...args) => {
      const count = native.readSync(args[0], args[1], {
        offset: 0,
        length: Math.min(4093, args[1].byteLength),
        position: null,
      });
      observed += count;
      if (count === 0) eof += 1;
      return count;
    });
    const result = read();
    expect(result.rows.map(({ t_min, values }) => ({ t_min, values: Array.from(values) }))).toEqual(
      rows,
    );
    expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(result.size_bytes).toBe(bytes.length);
    expect(observed).toBe(bytes.length);
    expect(eof).toBe(1);
    expect(fs.openSync).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fs.readSync).mock.calls.length).toBeGreaterThan(2);
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(fs.createReadStream).not.toHaveBeenCalled();
    expect(snapshot(file)).toEqual(before);
    expectClosed();
  });

  test("distinguishes absent output from unsafe and malformed present output", () => {
    native.unlinkSync(file);
    expectInputError(read, relative, "missing");
    native.mkdirSync(file);
    expectInputError(read, relative, "unsafe");
    native.rmdirSync(file);
    native.writeFileSync(file, buildShudDat().subarray(0, 1120));
    expectInputError(read, relative, "parse");
    expectClosed();
  });

  test("rejects escape, final symlink and ancestor symlink without following outside bytes", () => {
    const before = snapshot(outside);
    expectInputError(() => readShudDat(base, "../outside.dat"), "../outside.dat", "unsafe");
    native.unlinkSync(file);
    native.symlinkSync(outside, file);
    expectInputError(read, relative, "unsafe");
    native.symlinkSync(root, `${base}/linked`);
    expectInputError(() => readShudDat(base, "linked/outside.dat"), "linked/outside.dat", "unsafe");
    expect(fs.openSync).not.toHaveBeenCalled();
    expect(fs.readSync).not.toHaveBeenCalled();
    expect(native.readlinkSync(file)).toBe(outside);
    expect(native.readlinkSync(`${base}/linked`)).toBe(root);
    expect(snapshot(outside)).toEqual(before);
    expectClosed();
  });

  test("rejects a genuine writerless FIFO within a killed-and-reaped bound, with a regular control", () => {
    const child = () =>
      spawnSync(
        process.execPath,
        [
          "--experimental-transform-types",
          "--input-type=module",
          "-e",
          `
            // Eval has no module-relative base; the parent supplies the runtime module URL.
            const { readShudDat, ShudInputError } = await import(process.argv[1]);
            try {
              const result = readShudDat(process.argv[2], process.argv[3]);
              console.log(JSON.stringify({ sha256: result.sha256, rows: result.rows.length }));
            } catch (error) {
              if (!(error instanceof ShudInputError)) throw error;
              console.log(JSON.stringify({ stage: error.stage, path: error.path, cause: error.cause }));
            }
          `,
          new URL("./index.ts", import.meta.url).href,
          base,
          relative,
        ],
        { encoding: "utf8", timeout: 3000, killSignal: "SIGKILL" },
      );
    const control = child();
    expect(control.error, control.stderr).toBeUndefined();
    expect(control.status, control.stderr).toBe(0);
    expect(JSON.parse(control.stdout)).toEqual({ sha256: datOracle.sha256, rows: 3 });
    native.unlinkSync(file);
    execFileSync("mkfifo", [file]);
    const before = native.lstatSync(file, { bigint: true });
    const outsideBefore = snapshot(outside);
    expect(before.isFIFO()).toBe(true);
    const result = child();
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.signal, result.stderr).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ stage: "unsafe", path: relative });
    expect(native.lstatSync(file, { bigint: true }).ino).toBe(before.ino);
    expect(native.lstatSync(file).isFIFO()).toBe(true);
    expect(snapshot(outside)).toEqual(outsideBefore);
  }, 10000);
});

describe("binary reader failures retain descriptor and byte safety", () => {
  test.each(["before open", "during read"] as const)(
    "rejects observed pathname replacement %s, preserving both real byte sets",
    (when) => {
      const original = snapshot(file);
      const replacement = buildShudDat({ start_date: 19991231 });
      let replaced = false;
      const replace = () => {
        native.renameSync(file, `${root}/detached.dat`);
        native.writeFileSync(file, replacement);
        replaced = true;
      };
      if (when === "before open")
        vi.mocked(fs.openSync).mockImplementation((...args) => {
          replace();
          return openOwned(...args);
        });
      else
        vi.mocked(fs.readSync).mockImplementation((...args) => {
          const count = native.readSync(...args);
          if (!replaced && count > 0) replace();
          return count;
        });
      expectInputError(read, relative, "unsafe");
      expect(replaced).toBe(true);
      if (when === "before open") expect(fs.readSync).not.toHaveBeenCalled();
      expect(snapshot(`${root}/detached.dat`)).toEqual(original);
      expect(native.readFileSync(file)).toEqual(replacement);
      expectClosed();
    },
  );

  test.each(["EIO", "ENOENT"])("sanitizes a %s read fault and closes the descriptor", (code) => {
    const before = snapshot(file);
    vi.mocked(fs.readSync).mockImplementation(() => fault(code));
    expectInputError(read, relative, "read");
    expect(opened).toHaveLength(1);
    expect(snapshot(file)).toEqual(before);
    expectClosed();
  });

  test("closes before a controlled parse error without exposing header payload", () => {
    const bytes = buildShudDat().subarray(0, 1120);
    bytes.write(privatePayload, 0, "utf8");
    replaceBytes(bytes);
    expectInputError(read, relative, "parse");
    expect(opened).toHaveLength(1);
    expectClosed();
  });

  test("does not return parsed data or retry when close fails and ownership is unknown", () => {
    const before = snapshot(file);
    vi.mocked(fs.closeSync).mockImplementation(() => fault());
    const error = expectInputError(read, relative, "read");
    expect(error.message).toMatch(/descriptor state unknown/iu);
    expect(error).not.toHaveProperty("rows");
    expect(fs.closeSync).toHaveBeenCalledTimes(1);
    expect(opened).toHaveLength(1);
    expect(native.fstatSync(opened[0]).isFile()).toBe(true);
    expect(snapshot(file)).toEqual(before);
  });
});
