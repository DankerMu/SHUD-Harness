import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parseShudTextInput, readShudTextInput } from "./index.ts";
import {
  expectInputError,
  privateNative,
  privatePayload,
  smallInputs,
} from "./shud-text-test-harness.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    lstatSync: vi.fn(actual.lstatSync),
    statSync: vi.fn(actual.statSync),
    realpathSync: Object.assign(vi.fn(actual.realpathSync), {
      native: vi.fn(actual.realpathSync.native),
    }),
    openSync: vi.fn(actual.openSync),
    fstatSync: vi.fn(actual.fstatSync),
    readSync: vi.fn(actual.readSync),
    readFileSync: vi.fn(actual.readFileSync),
    createReadStream: vi.fn(actual.createReadStream),
    closeSync: vi.fn(actual.closeSync),
    mkdirSync: vi.fn(actual.mkdirSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    appendFileSync: vi.fn(actual.appendFileSync),
    renameSync: vi.fn(actual.renameSync),
    unlinkSync: vi.fn(actual.unlinkSync),
    rmSync: vi.fn(actual.rmSync),
    truncateSync: vi.fn(actual.truncateSync),
    ftruncateSync: vi.fn(actual.ftruncateSync),
    chmodSync: vi.fn(actual.chmodSync),
    utimesSync: vi.fn(actual.utimesSync),
    linkSync: vi.fn(actual.linkSync),
    symlinkSync: vi.fn(actual.symlinkSync),
  };
});

const native = await vi.importActual<typeof fs>("node:fs");
const relative = "nested/mini.cfg.calib";
const text = smallInputs["cfg.calib"];
let root: string;
let base: string;
let file: string;
let outside: string;
let active: Set<number>;
let opened: number[];

function openOwned(...args: Parameters<typeof fs.openSync>): number {
  const fd = native.openSync(...args);
  opened.push(fd);
  active.add(fd);
  return fd;
}
function closeOwned(fd: number): void {
  native.closeSync(fd);
  active.delete(fd);
}
function snapshot(path: string) {
  const { dev, ino, mode, mtimeNs } = native.lstatSync(path, { bigint: true });
  return { dev, ino, mode, mtimeNs, bytes: native.readFileSync(path) };
}
function fault(code = "EIO"): never {
  throw Object.assign(new Error(privateNative, { cause: new Error(privatePayload) }), {
    code,
    private_data: privatePayload,
  });
}
function read() {
  return readShudTextInput(base, relative, "cfg.calib");
}
function expectClosed(): void {
  expect(active.size).toBe(0);
  for (const fd of opened)
    expect(() => native.fstatSync(fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
  expect(fs.closeSync).toHaveBeenCalledTimes(opened.length);
}
function expectReadOnly(): void {
  for (const [, flags] of vi.mocked(fs.openSync).mock.calls) {
    expect(flags).toBe(fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  }
  for (const operation of [
    fs.mkdirSync,
    fs.writeFileSync,
    fs.appendFileSync,
    fs.renameSync,
    fs.unlinkSync,
    fs.rmSync,
    fs.truncateSync,
    fs.ftruncateSync,
    fs.chmodSync,
    fs.utimesSync,
    fs.linkSync,
    fs.symlinkSync,
  ]) {
    expect(operation).not.toHaveBeenCalled();
  }
}

beforeEach(() => {
  vi.mocked(fs.lstatSync).mockReset().mockImplementation(native.lstatSync);
  vi.mocked(fs.realpathSync).mockReset().mockImplementation(native.realpathSync);
  vi.mocked(fs.realpathSync.native).mockReset().mockImplementation(native.realpathSync.native);
  vi.mocked(fs.fstatSync).mockReset().mockImplementation(native.fstatSync);
  vi.mocked(fs.readSync).mockReset().mockImplementation(native.readSync);
  vi.mocked(fs.openSync).mockReset().mockImplementation(openOwned);
  vi.mocked(fs.closeSync).mockReset().mockImplementation(closeOwned);
  active = new Set();
  opened = [];
  root = native.realpathSync(native.mkdtempSync(`${tmpdir()}/shud-text-`));
  base = `${root}/base`;
  file = `${base}/${relative}`;
  outside = `${root}/outside.cfg.calib`;
  native.mkdirSync(`${base}/nested`, { recursive: true });
  native.writeFileSync(file, text, { mode: 0o400 });
  native.writeFileSync(outside, `#${privatePayload}\nGEOL_KSATV 99\n`);
  vi.clearAllMocks();
});
afterEach(() => {
  // Recovery is not production closure evidence. Persistent-close tests assert unknown
  // ownership and deliberately leave the real descriptor open until this harness cleanup.
  for (const fd of active) {
    try {
      native.closeSync(fd);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EBADF")) throw error;
    }
  }
  vi.restoreAllMocks();
  native.rmSync(root, { recursive: true, force: true });
});

describe("single-pass readonly public input reader", () => {
  test("returns data, digest and observed size from one open and leaves files and metadata unchanged", () => {
    const before = [snapshot(file), snapshot(outside)];
    const result = read();
    expect(result).toEqual({
      path: relative,
      sha256: createHash("sha256").update(text).digest("hex"),
      size_bytes: Buffer.byteLength(text),
      data: [
        { key: "GEOL_KSATV", value: 1, line: 1 },
        { key: "RIV_WDTH+", value: 50, line: 2 },
      ],
    });
    expect(fs.openSync).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(fs.openSync).mock.calls[0][0])).toBe(file);
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(fs.createReadStream).not.toHaveBeenCalled();
    expect([snapshot(file), snapshot(outside)]).toEqual(before);
    expectReadOnly();
    expectClosed();
  });

  test("pure parsing never performs filesystem IO", () => {
    const bytes = Buffer.from(text);
    expect(parseShudTextInput(bytes, relative, "cfg.calib")).toEqual([
      { key: "GEOL_KSATV", value: 1, line: 1 },
      { key: "RIV_WDTH+", value: 50, line: 2 },
    ]);
    for (const operation of [
      fs.lstatSync,
      fs.statSync,
      fs.realpathSync,
      fs.realpathSync.native,
      fs.openSync,
      fs.fstatSync,
      fs.readSync,
      fs.readFileSync,
      fs.createReadStream,
      fs.closeSync,
    ])
      expect(operation).not.toHaveBeenCalled();
    expect(bytes).toEqual(Buffer.from(text));
    expectReadOnly();
  });

  test("normalizes only an in-base relative request", () => {
    const result = readShudTextInput(base, "./nested/../nested//mini.cfg.calib", "cfg.calib");
    expect(result.path).toBe(relative);
    expect(result.data[0]).toEqual({ key: "GEOL_KSATV", value: 1, line: 1 });
    expect(fs.openSync).toHaveBeenCalledTimes(1);
    expectClosed();
  });

  test("resolves caller-owned alias/.. base physically instead of choosing a lexical sibling", () => {
    native.mkdirSync(`${root}/physical/child`, { recursive: true });
    native.writeFileSync(`${root}/physical/input.cfg.calib`, "GEOL_KSATV 7\n");
    native.writeFileSync(`${root}/input.cfg.calib`, "GEOL_KSATV 99\n");
    native.symlinkSync(`${root}/physical/child`, `${root}/alias`);
    const before = snapshot(`${root}/input.cfg.calib`);
    const result = readShudTextInput(`${root}/alias/..`, "input.cfg.calib", "cfg.calib");
    expect(result.data).toEqual([{ key: "GEOL_KSATV", value: 7, line: 1 }]);
    expect(snapshot(`${root}/input.cfg.calib`)).toEqual(before);
    expectClosed();
    expectReadOnly();
  });

  test("handles a multi-chunk payload and short native reads without rereading or hashing buffer slack", () => {
    const payload = Buffer.from(`#${"x".repeat(1_000_000)}\nGEOL_KSATV 0x1.8p2\nRIV_WDTH+ -0\n`);
    native.chmodSync(file, 0o600);
    native.writeFileSync(file, payload);
    const before = snapshot(file);
    let observed = 0;
    let eof = 0;
    vi.mocked(fs.readSync).mockImplementation((...args) => {
      const buffer = args[1];
      const count = native.readSync(args[0], buffer, {
        offset: 0,
        length: Math.min(4093, buffer.byteLength),
        position: null,
      });
      observed += count;
      if (count === 0) eof += 1;
      return count;
    });
    const result = read();
    expect(result.data).toEqual([
      { key: "GEOL_KSATV", value: 6, line: 2 },
      { key: "RIV_WDTH+", value: -0, line: 3 },
    ]);
    expect(result.sha256).toBe(createHash("sha256").update(payload).digest("hex"));
    expect(result.size_bytes).toBe(payload.length);
    expect(observed).toBe(payload.length);
    expect(eof).toBe(1);
    expect(vi.mocked(fs.readSync).mock.calls.length).toBeGreaterThan(2);
    expect(fs.openSync).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(fs.createReadStream).not.toHaveBeenCalled();
    for (const call of vi.mocked(fs.readSync).mock.calls)
      expect(call[1].byteLength).toBeLessThanOrEqual(64 * 1024);
    expect(snapshot(file)).toEqual(before);
    expectClosed();
    expectReadOnly();
  });

  test("reads a zero-byte config with the independent SHA256 empty vector", () => {
    native.chmodSync(file, 0o600);
    native.writeFileSync(file, "");
    expect(read()).toEqual({
      path: relative,
      data: [],
      size_bytes: 0,
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    });
    expect(fs.openSync).toHaveBeenCalledTimes(1);
    expectClosed();
  });

  test("releases its descriptor and exposes no partial data on parse failure", () => {
    native.chmodSync(file, 0o600);
    native.writeFileSync(file, `GEOL_KSATV 1\nRIV_WDTH+ ${privatePayload}\n`);
    const before = snapshot(file);
    expectInputError(read, relative, "parse", { line: 2 });
    expect(snapshot(file)).toEqual(before);
    expectClosed();
    expectReadOnly();
  });
});

describe("path and target safety", () => {
  test.each([
    "../outside.cfg.calib",
    "nested/../../outside.cfg.calib",
    "/absolute.cfg.calib",
    "",
    "bad\0name",
    "nested\\mini.cfg.calib",
  ])("rejects invalid or escaping relative path %j before target IO", (path) => {
    const before = snapshot(outside);
    expectInputError(() => readShudTextInput(base, path, "cfg.calib"), path, "unsafe");
    expect(fs.lstatSync).not.toHaveBeenCalled();
    expect(fs.statSync).not.toHaveBeenCalled();
    expect(fs.openSync).not.toHaveBeenCalled();
    expect(fs.readSync).not.toHaveBeenCalled();
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(snapshot(outside)).toEqual(before);
    expectReadOnly();
    expectClosed();
  });

  test("rejects a relative base before filesystem access", () => {
    expectInputError(
      () => readShudTextInput("relative-base", relative, "cfg.calib"),
      relative,
      "unsafe",
    );
    expect(fs.lstatSync).not.toHaveBeenCalled();
    expect(fs.realpathSync).not.toHaveBeenCalled();
    expect(fs.realpathSync.native).not.toHaveBeenCalled();
    expect(fs.openSync).not.toHaveBeenCalled();
    expectClosed();
  });

  test("distinguishes a missing final file and missing parent from unsafe and read failures", () => {
    native.unlinkSync(file);
    expectInputError(read, relative, "missing");
    expectInputError(
      () => readShudTextInput(base, "absent/mini.cfg.calib", "cfg.calib"),
      "absent/mini.cfg.calib",
      "missing",
    );
    expect(fs.openSync).not.toHaveBeenCalled();
    expectClosed();
  });

  test.each(["symlink", "dangling-link", "directory"] as const)(
    "rejects a final %s without modifying it or following its target",
    (kind) => {
      native.unlinkSync(file);
      if (kind === "directory") native.mkdirSync(file);
      else native.symlinkSync(kind === "symlink" ? outside : `${outside}.missing`, file);
      const before = snapshot(outside);
      const identity = native.lstatSync(file, { bigint: true });
      expectInputError(read, relative, "unsafe");
      expect(fs.openSync).not.toHaveBeenCalled();
      expect(fs.readSync).not.toHaveBeenCalled();
      expect(snapshot(outside)).toEqual(before);
      expect(native.lstatSync(file, { bigint: true }).ino).toBe(identity.ino);
      if (kind !== "directory")
        expect(native.readlinkSync(file)).toBe(kind === "symlink" ? outside : `${outside}.missing`);
      expectClosed();
      expectReadOnly();
    },
  );

  test("rejects an ancestor symlink without opening any outside content", () => {
    native.mkdirSync(`${root}/outside-dir`);
    native.writeFileSync(`${root}/outside-dir/mini.cfg.calib`, text);
    native.symlinkSync(`${root}/outside-dir`, `${base}/linked`);
    const target = `${root}/outside-dir/mini.cfg.calib`;
    const before = snapshot(target);
    expectInputError(
      () => readShudTextInput(base, "linked/mini.cfg.calib", "cfg.calib"),
      "linked/mini.cfg.calib",
      "unsafe",
    );
    expect(fs.openSync).not.toHaveBeenCalled();
    expect(fs.readSync).not.toHaveBeenCalled();
    expect(snapshot(target)).toEqual(before);
    expect(native.readlinkSync(`${base}/linked`)).toBe(`${root}/outside-dir`);
    expectReadOnly();
    expectClosed();
  });

  test("rejects a regular-file ancestor as unsafe rather than missing", () => {
    native.writeFileSync(`${base}/not-a-directory`, text);
    expectInputError(
      () => readShudTextInput(base, "not-a-directory/mini.cfg.calib", "cfg.calib"),
      "not-a-directory/mini.cfg.calib",
      "unsafe",
    );
    expect(fs.openSync).not.toHaveBeenCalled();
    expectClosed();
  });

  test("rejects a genuine writerless FIFO in a killed-and-reaped no-hang guard", () => {
    function child() {
      return spawnSync(
        process.execPath,
        [
          "--experimental-transform-types",
          "--input-type=module",
          "-e",
          `
        // Eval has no module-relative base; import the runtime URL supplied by the parent.
        const { readShudTextInput, ShudInputError } = await import(process.argv[1]);
        try {
          const result = readShudTextInput(process.argv[2], process.argv[3], "cfg.calib");
          console.log(JSON.stringify({ data: result.data }));
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
    }
    const control = child();
    expect(control.error, control.stderr).toBeUndefined();
    expect(control.status, control.stderr).toBe(0);
    expect(JSON.parse(control.stdout)).toEqual({
      data: [
        { key: "GEOL_KSATV", value: 1, line: 1 },
        { key: "RIV_WDTH+", value: 50, line: 2 },
      ],
    });
    native.unlinkSync(file);
    execFileSync("mkfifo", [file]);
    expect(native.lstatSync(file).isFIFO()).toBe(true);
    const before = snapshot(outside);
    const result = child();
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.signal, result.stderr).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ stage: "unsafe", path: relative });
    expect(native.lstatSync(file).isFIFO()).toBe(true);
    expect(snapshot(outside)).toEqual(before);
  }, 10000);
});

describe("observed replacement detection", () => {
  test.each(["file", "symlink", "directory", "fifo"] as const)(
    "rejects replacement by %s between preflight and open before content",
    (kind) => {
      const before = snapshot(outside);
      let replaced = false;
      vi.mocked(fs.openSync).mockImplementation((...args) => {
        native.renameSync(file, `${root}/detached`);
        if (kind === "file") native.writeFileSync(file, text);
        else if (kind === "symlink") native.symlinkSync(outside, file);
        else if (kind === "directory") native.mkdirSync(file);
        else execFileSync("mkfifo", [file]);
        replaced = true;
        // Never let a regression hang Vitest or follow the link. The flag assertions
        // below and the real FIFO child test make this guard non-vacuous.
        if (
          typeof args[1] !== "number" ||
          !(args[1] & fs.constants.O_NONBLOCK) ||
          !(args[1] & fs.constants.O_NOFOLLOW)
        )
          fault();
        return openOwned(...args);
      });
      expectInputError(read, relative, "unsafe");
      expect(replaced).toBe(true);
      expect(fs.readSync).not.toHaveBeenCalled();
      expect(native.readFileSync(`${root}/detached`, "utf8")).toBe(text);
      expect(snapshot(outside)).toEqual(before);
      expectClosed();
      expectReadOnly();
    },
  );

  test.each(["dev", "ino", "type"] as const)(
    "rejects descriptor %s disagreement before reading",
    (field) => {
      vi.mocked(fs.fstatSync).mockImplementation((...args) => {
        const stat = native.fstatSync(...args);
        if (field === "type") stat.isFile = () => false;
        else Object.defineProperty(stat, field, { value: Number(stat[field]) + 1 });
        return stat;
      });
      expectInputError(read, relative, "unsafe");
      expect(fs.readSync).not.toHaveBeenCalled();
      expectClosed();
      expectReadOnly();
    },
  );

  test.each(["before read", "after read"] as const)(
    "rejects a final pathname replacement %s despite retaining the original descriptor",
    (when) => {
      let replaced = false;
      const replace = () => {
        native.renameSync(file, `${root}/detached`);
        native.writeFileSync(file, "GEOL_KSATV 9\n");
        replaced = true;
      };
      if (when === "before read")
        vi.mocked(fs.fstatSync).mockImplementation((...args) => {
          const stat = native.fstatSync(...args);
          if (!replaced) replace();
          return stat;
        });
      else
        vi.mocked(fs.readSync).mockImplementation((...args) => {
          const count = native.readSync(...args);
          if (!replaced && count > 0) replace();
          return count;
        });
      expectInputError(read, relative, "unsafe");
      expect(replaced).toBe(true);
      if (when === "before read") expect(fs.readSync).not.toHaveBeenCalled();
      expect(native.readFileSync(`${root}/detached`, "utf8")).toBe(text);
      expect(native.readFileSync(file, "utf8")).toBe("GEOL_KSATV 9\n");
      expectClosed();
      expectReadOnly();
    },
  );

  test.each([
    ["base", "before read"],
    ["nested", "before read"],
    ["base", "after read"],
    ["nested", "after read"],
  ] as const)(
    "rejects an observed %s directory replacement %s even with the same target inode",
    (level, when) => {
      let replaced = false;
      const original = snapshot(file);
      const replace = () => {
        const directory = level === "base" ? base : `${base}/nested`;
        native.renameSync(directory, `${root}/detached-dir`);
        native.mkdirSync(`${base}/nested`, { recursive: true });
        const detached =
          level === "base"
            ? `${root}/detached-dir/${relative}`
            : `${root}/detached-dir/mini.cfg.calib`;
        native.linkSync(detached, file);
        replaced = true;
      };
      if (when === "before read")
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
      expect(snapshot(file)).toEqual(original);
      if (when === "before read") expect(fs.readSync).not.toHaveBeenCalled();
      expectClosed();
      expectReadOnly();
    },
  );
});

describe("controlled native failures and descriptor ownership", () => {
  test.each(["lstat", "open", "fstat", "read"] as const)(
    "sanitizes %s failure, preserves bytes and closes every owned descriptor",
    (phase) => {
      const before = [snapshot(file), snapshot(outside)];
      if (phase === "lstat") vi.mocked(fs.lstatSync).mockImplementation(() => fault("EACCES"));
      if (phase === "open") vi.mocked(fs.openSync).mockImplementation(() => fault("EACCES"));
      if (phase === "fstat") vi.mocked(fs.fstatSync).mockImplementation(() => fault());
      if (phase === "read") vi.mocked(fs.readSync).mockImplementation(() => fault());
      expectInputError(read, relative, "read");
      expect([snapshot(file), snapshot(outside)]).toEqual(before);
      expectClosed();
      expectReadOnly();
    },
  );

  test("sanitizes failure to resolve the physical base without accessing input content", () => {
    vi.mocked(fs.realpathSync).mockImplementation(() => fault("EACCES"));
    vi.mocked(fs.realpathSync.native).mockImplementation(() => fault("EACCES"));
    expectInputError(read, relative, "read");
    expect(fs.openSync).not.toHaveBeenCalled();
    expect(fs.readSync).not.toHaveBeenCalled();
    expectClosed();
    expectReadOnly();
  });

  test("classifies ENOENT at open as missing, not successful empty input", () => {
    vi.mocked(fs.openSync).mockImplementation(() => fault("ENOENT"));
    expectInputError(read, relative, "missing");
    expect(fs.readSync).not.toHaveBeenCalled();
    expectClosed();
  });

  test("does not call an ENOENT during descriptor reading a missing path", () => {
    vi.mocked(fs.readSync).mockImplementation(() => fault("ENOENT"));
    expectInputError(read, relative, "read");
    expectClosed();
  });

  test.each(["close", "fstat then close", "read then close"] as const)(
    "attempts one close and reports unknown ownership for %s failure",
    (phase) => {
      const before = snapshot(file);
      if (phase === "fstat then close") vi.mocked(fs.fstatSync).mockImplementation(() => fault());
      if (phase === "read then close") vi.mocked(fs.readSync).mockImplementation(() => fault());
      vi.mocked(fs.closeSync).mockImplementation(() => fault("EACCES"));
      const error = expectInputError(read, relative, "read");
      expect(error.message).toMatch(/descriptor state unknown/iu);
      if (phase !== "close") expect(error.message).toMatch(/cleanup/iu);
      expect(fs.closeSync).toHaveBeenCalledTimes(1);
      expect(opened).toHaveLength(1);
      // The OS, not the mock registry, proves production did not release this descriptor.
      expect(native.fstatSync(opened[0]).isFile()).toBe(true);
      expect(snapshot(file)).toEqual(before);
      expectReadOnly();
    },
  );

  test("preserves an unsafe identity failure when descriptor cleanup also fails", () => {
    vi.mocked(fs.fstatSync).mockImplementation((...args) => {
      const stat = native.fstatSync(...args);
      stat.isFile = () => false;
      return stat;
    });
    vi.mocked(fs.closeSync).mockImplementation(() => fault());
    const error = expectInputError(read, relative, "unsafe");
    expect(error.message).toMatch(/cleanup/iu);
    expect(error.message).toMatch(/descriptor state unknown/iu);
    expect(fs.readSync).not.toHaveBeenCalled();
    expect(fs.closeSync).toHaveBeenCalledTimes(1);
    expect(native.fstatSync(opened[0]).isFile()).toBe(true);
    expectReadOnly();
  });

  test("never retries a close which released the descriptor before reporting failure", () => {
    vi.mocked(fs.closeSync).mockImplementation((fd) => {
      closeOwned(fd);
      fault();
    });
    const error = expectInputError(read, relative, "read");
    expect(error.message).toMatch(/descriptor state unknown/iu);
    expect(fs.closeSync).toHaveBeenCalledTimes(1);
    expect(active.size).toBe(0);
    expect(() => native.fstatSync(opened[0])).toThrow(expect.objectContaining({ code: "EBADF" }));
    expect(inspect(error, { showHidden: true, depth: null })).not.toContain(privateNative);
  });
});
