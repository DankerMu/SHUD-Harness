import * as fs from "node:fs";
import { join, normalize, resolve } from "node:path";
import type * as NodePath from "node:path";
import { tmpdir } from "node:os";
import { inspect } from "node:util";
import type * as NodeCrypto from "node:crypto";
import {
  ChangeRequestSchema,
  createBrandedId,
  VerificationCaseSchema,
  type ChangeId,
  type ChangeRequest,
  type VerificationCase,
} from "@shud-harness/dsh-shud-core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createChangeRequest,
  createVerificationCase,
  readChangePatch,
  readWorkspaceRecord,
  rewriteChangeRequest,
  writeChangePatch,
  WorkspaceRecordError,
  type WorkspaceRecordStage,
} from "./index.ts";
import { installUnsafe, unsafeKinds } from "./test-harness.ts";
import {
  changeCase,
  verificationCase,
  workspaceFileCases,
} from "./workspace-files-test-harness.ts";

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
  const actual = await original<typeof fs>();
  return {
    ...actual,
    lstatSync: vi.fn(actual.lstatSync),
    mkdirSync: vi.fn(actual.mkdirSync),
    readFileSync: vi.fn(actual.readFileSync),
    openSync: vi.fn(actual.openSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    fsyncSync: vi.fn(actual.fsyncSync),
    closeSync: vi.fn(actual.closeSync),
    linkSync: vi.fn(actual.linkSync),
    unlinkSync: vi.fn(actual.unlinkSync),
    renameSync: vi.fn(actual.renameSync),
    rmSync: vi.fn(actual.rmSync),
  };
});
vi.mock("node:path", async (original) => {
  const actual = await original<typeof NodePath>();
  return {
    ...actual,
    join: vi.fn((...parts: string[]) => actual.join(...parts)),
    resolve: vi.fn((...parts: string[]) => actual.resolve(...parts)),
    normalize: vi.fn((value: string) => actual.normalize(value)),
  };
});

const native = await vi.importActual<typeof fs>("node:fs");
const nativePath = await vi.importActual<typeof NodePath>("node:path");
const change = ChangeRequestSchema.parse(changeCase.value);
const verification = VerificationCaseSchema.parse(verificationCase.value);
const secret = "private-publication-payload-527";
// SHA256("abc") is the published standard vector in both frozen schema fixtures.
const patchBytes = Buffer.from("abc");
let root: string;
let cwd: string;
let descriptors: number[];

beforeEach(() => {
  vi.mocked(fs.lstatSync).mockReset().mockImplementation(native.lstatSync);
  vi.mocked(fs.mkdirSync).mockReset().mockImplementation(native.mkdirSync);
  vi.mocked(fs.readFileSync).mockReset().mockImplementation(native.readFileSync);
  vi.mocked(fs.writeFileSync).mockReset().mockImplementation(native.writeFileSync);
  vi.mocked(fs.fsyncSync).mockReset().mockImplementation(native.fsyncSync);
  vi.mocked(fs.closeSync).mockReset().mockImplementation(native.closeSync);
  vi.mocked(fs.linkSync).mockReset().mockImplementation(native.linkSync);
  vi.mocked(fs.unlinkSync).mockReset().mockImplementation(native.unlinkSync);
  vi.mocked(fs.renameSync).mockReset().mockImplementation(native.renameSync);
  vi.mocked(fs.rmSync).mockReset().mockImplementation(native.rmSync);
  descriptors = [];
  vi.mocked(fs.openSync)
    .mockReset()
    .mockImplementation((...args) => {
      const fd = native.openSync(...args);
      descriptors.push(fd);
      return fd;
    });
  root = native.mkdtempSync(nativePath.join(tmpdir(), "workspace-publication-"));
  cwd = nativePath.join(root, "workspace");
  native.mkdirSync(cwd);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-02T09:00:00.987Z"));
  entropy.suffixes = ["a1b2", "abcd", "1234", "5678", "9999"];
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const fd of descriptors) {
    try {
      native.closeSync(fd);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EBADF")) throw error;
    }
  }
  native.rmSync(root, { recursive: true, force: true });
});

function seed(relative: string, bytes: string | Uint8Array): string {
  const target = nativePath.join(cwd, relative);
  native.mkdirSync(nativePath.dirname(target), { recursive: true });
  native.writeFileSync(target, bytes);
  return target;
}
function snapshot(target: string) {
  const { ino, mode, mtimeNs } = native.lstatSync(target, { bigint: true });
  return { ino, mode, mtimeNs, bytes: native.readFileSync(target) };
}
function expectClosed(): void {
  for (const fd of descriptors) expect(() => native.fstatSync(fd)).toThrow();
}
function failure(call: () => unknown, stage: WorkspaceRecordStage): Error {
  let caught: unknown;
  try {
    call();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(WorkspaceRecordError);
  expect(caught).toMatchObject({ stage });
  if (!(caught instanceof Error)) throw new Error("Expected a controlled publication failure");
  expect(caught.cause).toBeUndefined();
  expect(inspect(caught, { depth: null })).not.toContain(secret);
  return caught;
}
function fault(code = "EIO"): never {
  throw Object.assign(new Error(secret), { code });
}
function expectNoWrites(): void {
  for (const operation of [
    fs.mkdirSync,
    fs.openSync,
    fs.writeFileSync,
    fs.fsyncSync,
    fs.closeSync,
    fs.linkSync,
    fs.unlinkSync,
    fs.renameSync,
    fs.rmSync,
  ])
    expect(operation).not.toHaveBeenCalled();
}
function expectNoPathOrIO(): void {
  expect(join).not.toHaveBeenCalled();
  expect(resolve).not.toHaveBeenCalled();
  expect(normalize).not.toHaveBeenCalled();
  expect(fs.lstatSync).not.toHaveBeenCalled();
  expect(fs.readFileSync).not.toHaveBeenCalled();
  expectNoWrites();
}
function changeCandidate(): ChangeRequest {
  const change_id = createBrandedId("CHG");
  return { ...change, change_id, patch_path: `patches/${change_id}.patch` };
}
function verificationFields(): Omit<VerificationCase, "vc_id"> {
  const { vc_id, ...fields } = verification;
  void vc_id;
  return fields;
}
const allocations = [
  {
    ...changeCase,
    create: (directory: string) => createChangeRequest(directory, changeCandidate()),
    invalid: (directory: string) =>
      createChangeRequest(directory, { ...changeCandidate(), risk: "high" }),
    expected: (id: string) => ({
      ...changeCase.value,
      change_id: id,
      patch_path: `patches/${id}.patch`,
    }),
  },
  {
    ...verificationCase,
    create: (directory: string) => createVerificationCase(directory, verificationFields()),
    invalid: (directory: string) =>
      createVerificationCase(directory, {
        ...verificationFields(),
        failure_reason: "A passed result cannot have a failure reason.",
      }),
    expected: (id: string) => ({ ...verificationCase.value, vc_id: id }),
  },
];

describe.each(allocations)("$kind first publication", (fixture) => {
  beforeEach(() => {
    entropy.suffixes = [fixture.id.slice(-4), "abcd", "1234", "5678", "9999"];
  });

  test("publishes complete private JSON once, closes before visibility, and leaves no temporary", () => {
    const target = nativePath.join(cwd, fixture.relative);
    let observed = false;
    vi.mocked(fs.linkSync).mockImplementationOnce((temporary, final) => {
      expect(final).toBe(target);
      expect(nativePath.dirname(String(temporary))).toBe(nativePath.dirname(target));
      expect(native.existsSync(target)).toBe(false);
      expect(JSON.parse(native.readFileSync(temporary, "utf8"))).toEqual(fixture.value);
      expect(fs.fsyncSync).toHaveBeenCalled();
      expectClosed();
      native.linkSync(temporary, final);
      expect(JSON.parse(native.readFileSync(target, "utf8"))).toEqual(fixture.value);
      observed = true;
    });

    expect(fixture.create(cwd)).toEqual(fixture.value);

    expect(observed).toBe(true);
    expect(readWorkspaceRecord(cwd, fixture.kind, fixture.id, { readonly: true })).toEqual(
      fixture.value,
    );
    expect(native.statSync(target).mode & 0o777).toBe(0o600);
    expect(native.readFileSync(target, "utf8").endsWith("\n")).toBe(true);
    expect(native.readdirSync(nativePath.dirname(target))).toEqual([nativePath.basename(target)]);
    expect(native.readdirSync(cwd)).toEqual([fixture.directory]);
    expect(fs.renameSync).not.toHaveBeenCalled();
    expect(entropy.suffixes).toEqual(["abcd", "1234", "5678", "9999"]);
    expectClosed();
  });

  test.each([1, 2, 3])(
    "reallocates after %i existing targets, preserving every prior object",
    (count) => {
      const ids = [
        fixture.id,
        `${fixture.id.slice(0, -4)}abcd`,
        `${fixture.id.slice(0, -4)}1234`,
        `${fixture.id.slice(0, -4)}5678`,
      ];
      const originals = ids.slice(0, count).map((id) => {
        const target = seed(`${fixture.directory}/${id}.json`, `foreign ${id}\n`);
        return { target, before: snapshot(target) };
      });
      const selected = ids[count];
      if (selected === undefined) throw new Error("Missing allocation oracle");

      expect(fixture.create(cwd)).toEqual(fixture.expected(selected));

      for (const original of originals) expect(snapshot(original.target)).toEqual(original.before);
      expect(readWorkspaceRecord(cwd, fixture.kind, selected)).toEqual(fixture.expected(selected));
      expect(native.readdirSync(nativePath.join(cwd, fixture.directory)).sort()).toEqual(
        ids
          .slice(0, count + 1)
          .map((id) => `${id}.json`)
          .sort(),
      );
      expect(entropy.suffixes).toEqual(["abcd", "1234", "5678", "9999"].slice(count));
      expectClosed();
    },
  );

  test("four collisions exhaust the budget without consuming a fifth id or modifying evidence", () => {
    const ids = [
      fixture.id,
      `${fixture.id.slice(0, -4)}abcd`,
      `${fixture.id.slice(0, -4)}1234`,
      `${fixture.id.slice(0, -4)}5678`,
    ];
    const originals = ids.map((id) => {
      const target = seed(`${fixture.directory}/${id}.json`, `foreign ${id}\n`);
      return { target, before: snapshot(target) };
    });

    const error = failure(() => fixture.create(cwd), "write");

    expect(error.message).toMatch(/collision/iu);
    expect(error.message).toContain(ids[3]);
    expect(entropy.suffixes).toEqual(["9999"]);
    for (const original of originals) expect(snapshot(original.target)).toEqual(original.before);
    expect(native.readdirSync(nativePath.join(cwd, fixture.directory)).sort()).toEqual(
      ids.map((id) => `${id}.json`).sort(),
    );
    expectClosed();
  });

  test("a final target appearing at link is not clobbered and reallocates only that collision", () => {
    const target = nativePath.join(cwd, fixture.relative);
    let original: unknown;
    vi.mocked(fs.linkSync).mockImplementationOnce((temporary, final) => {
      native.writeFileSync(final, "late foreign record\n");
      original = snapshot(target);
      native.linkSync(temporary, final);
    });
    const second = `${fixture.id.slice(0, -4)}abcd`;

    expect(fixture.create(cwd)).toEqual(fixture.expected(second));

    expect(snapshot(target)).toEqual(original);
    expect(entropy.suffixes).toEqual(["1234", "5678", "9999"]);
    expect(native.readdirSync(nativePath.dirname(target)).sort()).toEqual(
      [`${fixture.id}.json`, `${second}.json`].sort(),
    );
    expectClosed();
  });

  test("invalid complete fields fail before path construction or IO", () => {
    failure(() => fixture.invalid(cwd), "schema");
    expectNoPathOrIO();
    expect(native.readdirSync(cwd)).toEqual([]);
  });

  test.each(unsafeKinds)("a %s managed root fails closed without reallocation", (kind) => {
    const outside = nativePath.join(root, "outside");
    native.mkdirSync(outside);
    const sentinel = nativePath.join(outside, "sentinel");
    native.writeFileSync(sentinel, "foreign bytes\n");
    const before = snapshot(sentinel);
    const directory = nativePath.join(cwd, fixture.directory);
    installUnsafe(directory, kind, outside);
    vi.clearAllMocks();

    failure(() => fixture.create(cwd), "directory");

    expect(snapshot(sentinel)).toEqual(before);
    expect(native.readdirSync(outside)).toEqual(["sentinel"]);
    expectNoWrites();
    expect(entropy.suffixes).toEqual(["abcd", "1234", "5678", "9999"]);
  });

  test.each(["symlink", "dangling-link", "directory", "fifo"] as const)(
    "a %s target is unsafe, not a retryable collision",
    (kind) => {
      const outside = nativePath.join(root, "outside.json");
      native.writeFileSync(outside, "foreign bytes\n");
      const before = snapshot(outside);
      const target = nativePath.join(cwd, fixture.relative);
      native.mkdirSync(nativePath.dirname(target), { recursive: true });
      installUnsafe(target, kind, outside);
      vi.clearAllMocks();

      failure(() => fixture.create(cwd), "target");

      expect(snapshot(outside)).toEqual(before);
      expectNoWrites();
      expect(entropy.suffixes).toEqual(["abcd", "1234", "5678", "9999"]);
      expect(native.readdirSync(nativePath.dirname(target))).toEqual([nativePath.basename(target)]);
    },
  );

  test("a foreign temporary created at exclusive open is preserved and never reallocates the record", () => {
    let temporary = "";
    let before: unknown;
    vi.mocked(fs.openSync).mockImplementationOnce((target, flags, mode) => {
      temporary = String(target);
      native.writeFileSync(target, "foreign temporary\n");
      before = snapshot(temporary);
      return native.openSync(target, flags, mode);
    });

    failure(() => fixture.create(cwd), "write");

    expect(snapshot(temporary)).toEqual(before);
    expect(native.existsSync(nativePath.join(cwd, fixture.relative))).toBe(false);
    expect(native.readdirSync(nativePath.dirname(temporary))).toEqual([
      nativePath.basename(temporary),
    ]);
    expect(entropy.suffixes).toEqual(["abcd", "1234", "5678", "9999"]);
    expectClosed();
  });

  test.each(["open", "write", "sync", "close", "link"] as const)(
    "%s failure leaves no published object, closes resources, and does not spend retry budget",
    (phase) => {
      if (phase === "open") vi.mocked(fs.openSync).mockImplementationOnce(() => fault());
      if (phase === "write") vi.mocked(fs.writeFileSync).mockImplementationOnce(() => fault());
      if (phase === "sync") vi.mocked(fs.fsyncSync).mockImplementationOnce(() => fault());
      if (phase === "close") vi.mocked(fs.closeSync).mockImplementationOnce(() => fault());
      if (phase === "link") vi.mocked(fs.linkSync).mockImplementationOnce(() => fault());

      failure(() => fixture.create(cwd), "write");

      expect(native.readdirSync(nativePath.join(cwd, fixture.directory))).toEqual([]);
      expect(entropy.suffixes).toEqual(["abcd", "1234", "5678", "9999"]);
      expectClosed();
    },
  );

  test("cleanup failure after link reports the committed id without duplicate allocation or rollback", () => {
    vi.mocked(fs.unlinkSync).mockImplementation(() => fault("EACCES"));
    vi.mocked(fs.rmSync).mockImplementation(() => fault("EACCES"));

    const error = failure(() => fixture.create(cwd), "write");

    expect(error.message).toContain(fixture.id);
    expect(error.message).toMatch(/committed/iu);
    expect(error.message).toMatch(/cleanup/iu);
    expect(readWorkspaceRecord(cwd, fixture.kind, fixture.id)).toEqual(fixture.value);
    const files = native.readdirSync(nativePath.join(cwd, fixture.directory));
    expect(files.filter((file) => file.endsWith(".json"))).toEqual([`${fixture.id}.json`]);
    expect(files).toHaveLength(2);
    expect(entropy.suffixes).toEqual(["abcd", "1234", "5678", "9999"]);
    expectClosed();
  });

  test("a late unsafe final target fails closed instead of allocating a different object", () => {
    const outside = nativePath.join(root, "outside.json");
    native.writeFileSync(outside, "foreign bytes\n");
    const before = snapshot(outside);
    const target = nativePath.join(cwd, fixture.relative);
    vi.mocked(fs.linkSync).mockImplementationOnce((temporary, final) => {
      native.symlinkSync(outside, final);
      native.linkSync(temporary, final);
    });

    failure(() => fixture.create(cwd), "target");

    expect(native.readlinkSync(target)).toBe(outside);
    expect(snapshot(outside)).toEqual(before);
    expect(native.readdirSync(nativePath.dirname(target))).toEqual([nativePath.basename(target)]);
    expect(entropy.suffixes).toEqual(["abcd", "1234", "5678", "9999"]);
    expectClosed();
  });

  test("a late collision with failed cleanup does not allocate a duplicate", () => {
    const target = nativePath.join(cwd, fixture.relative);
    vi.mocked(fs.linkSync).mockImplementationOnce((temporary, final) => {
      native.writeFileSync(final, "late foreign record\n");
      native.linkSync(temporary, final);
    });
    vi.mocked(fs.unlinkSync).mockImplementation(() => fault("EACCES"));
    vi.mocked(fs.rmSync).mockImplementation(() => fault("EACCES"));

    const error = failure(() => fixture.create(cwd), "write");

    expect(error.message).toContain(fixture.id);
    expect(error.message).toMatch(/collision/iu);
    expect(error.message).toMatch(/cleanup/iu);
    expect(native.readFileSync(target, "utf8")).toBe("late foreign record\n");
    expect(native.readdirSync(nativePath.dirname(target))).toHaveLength(2);
    expect(entropy.suffixes).toEqual(["abcd", "1234", "5678", "9999"]);
    expectClosed();
  });

  test("publication plus cleanup failures retain both controlled facts without publishing or retrying", () => {
    vi.mocked(fs.linkSync).mockImplementationOnce(() => fault());
    vi.mocked(fs.unlinkSync).mockImplementation(() => fault("EACCES"));
    vi.mocked(fs.rmSync).mockImplementation(() => fault("EACCES"));

    const error = failure(() => fixture.create(cwd), "write");

    expect(error.message).toMatch(/link|publication/iu);
    expect(error.message).toMatch(/cleanup/iu);
    expect(native.existsSync(nativePath.join(cwd, fixture.relative))).toBe(false);
    expect(native.readdirSync(nativePath.join(cwd, fixture.directory))).toHaveLength(1);
    expect(entropy.suffixes).toEqual(["abcd", "1234", "5678", "9999"]);
    expectClosed();
  });
});

test("record write and descriptor cleanup failure retain controlled facts without publishing or reallocating", () => {
  vi.mocked(fs.writeFileSync).mockImplementationOnce(() => fault());
  vi.mocked(fs.closeSync).mockImplementation(() => fault("EACCES"));

  const error = failure(() => createChangeRequest(cwd, changeCandidate()), "write");

  expect(error.message).toContain(change.change_id);
  expect(error.message).toMatch(/publication/iu);
  expect(error.message).toMatch(/cleanup/iu);
  expect(native.existsSync(nativePath.join(cwd, changeCase.relative))).toBe(false);
  expect(native.readdirSync(nativePath.join(cwd, "changes"))).toEqual([]);
  expect(entropy.suffixes).toEqual(["abcd", "1234", "5678", "9999"]);
  expect(fs.linkSync).not.toHaveBeenCalled();
  expect(descriptors).toHaveLength(1);
  expect(fs.closeSync).toHaveBeenCalledExactlyOnceWith(descriptors[0]);
  // Close is deliberately unavailable; afterEach restores it and releases the tracked descriptor.
});

describe("supplied ChangeRequest candidate", () => {
  test("preserves the supplied id, path and metadata without drawing another id", () => {
    const candidate = {
      ...structuredClone(change),
      change_id: ChangeRequestSchema.shape.change_id.parse("CHG-20261001T010203-dead"),
      patch_path: "patches/CHG-20261001T010203-dead.patch",
    };
    const before = structuredClone(candidate);
    const remaining = [...entropy.suffixes];

    expect(createChangeRequest(cwd, candidate)).toEqual(before);

    expect(candidate).toEqual(before);
    expect(entropy.suffixes).toEqual(remaining);
    expect(readWorkspaceRecord(cwd, "change", candidate.change_id, { readonly: true })).toEqual(
      before,
    );
    expect(native.readdirSync(cwd)).toEqual(["changes"]);
    expect(native.readdirSync(nativePath.join(cwd, "changes"))).toEqual([
      `${candidate.change_id}.json`,
    ]);
  });

  test.each([
    { label: "missing id", field: "change_id", value: undefined },
    { label: "traversal id", field: "change_id", value: "../tasks/private" },
    { label: "legacy id", field: "change_id", value: "CHG-0001" },
    { label: "uppercase id", field: "change_id", value: "CHG-20261102T090000-A1B2" },
    { label: "wrong brand", field: "change_id", value: "VC-20261102T090000-a1b2" },
    { label: "missing path", field: "patch_path", value: undefined },
    {
      label: "mismatched path",
      field: "patch_path",
      value: "patches/CHG-20261102T090000-abcd.patch",
    },
    { label: "traversal path", field: "patch_path", value: "../outside.patch" },
    { label: "invalid schema", field: "base_commit", value: "short" },
    { label: "inconsistent risk", field: "risk", value: "high" },
  ])("rejects $label before path construction, entropy or IO", ({ field, value }) => {
    const candidate: Record<string, unknown> = { ...change, [field]: value };
    if (value === undefined) delete candidate[field];
    const remaining = [...entropy.suffixes];
    // Deliberately bypass only the static type, never the production schema validator.
    expect(() => createChangeRequest(cwd, candidate as ChangeRequest)).toThrow();
    expectNoPathOrIO();
    expect(entropy.suffixes).toEqual(remaining);
    expect(native.readdirSync(cwd)).toEqual([]);
  });
});

describe("change patch companion", () => {
  test.each(["abc", patchBytes])(
    "publishes exact supplied bytes once and reads a Buffer without mutation",
    (bytes) => {
      const target = seed(changeCase.relative, ` ${JSON.stringify(changeCase.value)}\n`);
      const before = snapshot(target);
      const patch = nativePath.join(cwd, change.patch_path);
      let observed = false;
      vi.mocked(fs.linkSync).mockImplementationOnce((temporary, final) => {
        expect(final).toBe(patch);
        expect(native.readFileSync(temporary)).toEqual(patchBytes);
        expect(native.existsSync(patch)).toBe(false);
        expectClosed();
        native.linkSync(temporary, final);
        observed = true;
      });

      expect(writeChangePatch(cwd, change.change_id, bytes)).toBeUndefined();

      expect(observed).toBe(true);
      expect(native.readFileSync(patch)).toEqual(patchBytes);
      const patchBefore = snapshot(patch);
      vi.clearAllMocks();
      const result = readChangePatch(cwd, change.change_id, { readonly: true });
      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result).toEqual(patchBytes);
      expectNoWrites();
      expect(snapshot(patch)).toEqual(patchBefore);
      expect(snapshot(target)).toEqual(before);
      expect(native.readdirSync(nativePath.join(cwd, "patches"))).toEqual([
        `${change.change_id}.patch`,
      ]);
      expect(entropy.suffixes).toEqual(["a1b2", "abcd", "1234", "5678", "9999"]);
    },
  );

  test("a hash mismatch rejects before creating the patch root and preserves the CR", () => {
    const target = seed(changeCase.relative, JSON.stringify(changeCase.value));
    const before = snapshot(target);
    vi.clearAllMocks();

    failure(() => writeChangePatch(cwd, change.change_id, Buffer.from("abd")), "write");

    expectNoWrites();
    expect(snapshot(target)).toEqual(before);
    expect(native.readdirSync(cwd)).toEqual(["changes"]);
  });

  test.each([false, true])(
    "patch collision late=%s preserves both files and never allocates another id",
    (late) => {
      const target = seed(changeCase.relative, JSON.stringify(changeCase.value));
      const before = snapshot(target);
      const patch = nativePath.join(cwd, change.patch_path);
      let patchBefore: unknown;
      if (late) {
        vi.mocked(fs.linkSync).mockImplementationOnce((temporary, final) => {
          native.writeFileSync(final, "foreign patch\n");
          patchBefore = snapshot(patch);
          native.linkSync(temporary, final);
        });
      } else {
        seed(change.patch_path, "foreign patch\n");
        patchBefore = snapshot(patch);
      }

      const error = failure(() => writeChangePatch(cwd, change.change_id, patchBytes), "write");

      expect(error.message).toMatch(/collision/iu);
      expect(error.message).toContain(change.change_id);
      expect(snapshot(target)).toEqual(before);
      expect(snapshot(patch)).toEqual(patchBefore);
      expect(native.readdirSync(nativePath.dirname(patch))).toEqual([nativePath.basename(patch)]);
      expect(entropy.suffixes).toEqual(["a1b2", "abcd", "1234", "5678", "9999"]);
      expectClosed();
    },
  );

  test.each([undefined, { readonly: false }])(
    "missing patch reads create only the managed root with options=%j",
    (options) => {
      failure(() => readChangePatch(cwd, change.change_id, options), "missing");

      const directory = nativePath.join(cwd, "patches");
      expect(native.lstatSync(directory).isDirectory()).toBe(true);
      expect(native.readdirSync(directory)).toEqual([]);
      expect(native.readdirSync(cwd)).toEqual(["patches"]);
      expect(fs.openSync).not.toHaveBeenCalled();
      expect(fs.writeFileSync).not.toHaveBeenCalled();
      expect(fs.linkSync).not.toHaveBeenCalled();
      expect(fs.renameSync).not.toHaveBeenCalled();
    },
  );

  test("a missing readonly patch read creates no paths", () => {
    failure(() => readChangePatch(cwd, change.change_id, { readonly: true }), "missing");
    expectNoWrites();
    expect(native.readdirSync(cwd)).toEqual([]);
  });

  test.each([undefined, { readonly: false }, { readonly: true }])(
    "patch reads preserve arbitrary bytes with options=%j",
    (options) => {
      const bytes = Buffer.from([0, 255, 128, 13, 10, 97]);
      const patch = seed(change.patch_path, bytes);
      const before = snapshot(patch);
      vi.clearAllMocks();

      expect(readChangePatch(cwd, change.change_id, options)).toEqual(bytes);

      expectNoWrites();
      expect(snapshot(patch)).toEqual(before);
      expect(native.readdirSync(cwd)).toEqual(["patches"]);
    },
  );

  test("an existing empty patches root remains empty on a missing readonly read", () => {
    const directory = nativePath.join(cwd, "patches");
    native.mkdirSync(directory);
    vi.clearAllMocks();

    failure(() => readChangePatch(cwd, change.change_id, { readonly: true }), "missing");

    expectNoWrites();
    expect(native.readdirSync(directory)).toEqual([]);
  });

  test("patch read failures preserve evidence and hide raw IO diagnostics", () => {
    const patch = seed(change.patch_path, patchBytes);
    const before = snapshot(patch);
    vi.mocked(fs.readFileSync).mockImplementationOnce(() => fault("EACCES"));

    failure(() => readChangePatch(cwd, change.change_id, { readonly: true }), "read");

    expect(snapshot(patch)).toEqual(before);
    expectNoWrites();
  });

  test("cleanup failure after patch publication preserves the committed patch and CR", () => {
    const target = seed(changeCase.relative, JSON.stringify(changeCase.value));
    const before = snapshot(target);
    vi.mocked(fs.unlinkSync).mockImplementation(() => fault("EACCES"));
    vi.mocked(fs.rmSync).mockImplementation(() => fault("EACCES"));

    const error = failure(() => writeChangePatch(cwd, change.change_id, patchBytes), "write");

    expect(error.message).toContain(change.change_id);
    expect(error.message).toMatch(/committed/iu);
    expect(native.readFileSync(nativePath.join(cwd, change.patch_path))).toEqual(patchBytes);
    expect(snapshot(target)).toEqual(before);
    expect(entropy.suffixes).toEqual(["a1b2", "abcd", "1234", "5678", "9999"]);
    expectClosed();
  });
});

const routedCalls = [
  { name: "patch read", call: (id: ChangeId) => readChangePatch(cwd, id, { readonly: true }) },
  { name: "patch write", call: (id: ChangeId) => writeChangePatch(cwd, id, patchBytes) },
  {
    name: "change rewrite",
    call: (id: ChangeId) => rewriteChangeRequest(cwd, { ...change, change_id: id }),
  },
];
describe.each(routedCalls)("$name routing", ({ call }) => {
  test.each([
    "../tasks/x",
    "CHG-0001",
    "CHG-20261102T090000-A1B2",
    "VC-20261102T090000-a1b2",
    null,
  ])("rejects malformed id %j before paths or IO", (id) => {
    failure(() => call(id as ChangeId), "id");
    expectNoPathOrIO();
    expect(native.readdirSync(cwd)).toEqual([]);
  });
});

const patchCalls = [
  { name: "read", call: () => readChangePatch(cwd, change.change_id, { readonly: true }) },
  { name: "write", call: () => writeChangePatch(cwd, change.change_id, patchBytes) },
];
describe.each(patchCalls)("patch $name path safety", ({ call }) => {
  test.each(unsafeKinds)("rejects a %s patches root without outside mutation", (kind) => {
    seed(changeCase.relative, JSON.stringify(changeCase.value));
    const outside = nativePath.join(root, "outside");
    native.mkdirSync(outside);
    const sentinel = nativePath.join(outside, "sentinel");
    native.writeFileSync(sentinel, "foreign bytes\n");
    const before = snapshot(sentinel);
    installUnsafe(nativePath.join(cwd, "patches"), kind, outside);
    vi.clearAllMocks();

    failure(call, "directory");

    expectNoWrites();
    expect(snapshot(sentinel)).toEqual(before);
    expect(native.readdirSync(outside)).toEqual(["sentinel"]);
  });

  test.each(["symlink", "dangling-link", "directory", "fifo"] as const)(
    "rejects a %s patch target before reading or replacing it",
    (kind) => {
      seed(changeCase.relative, JSON.stringify(changeCase.value));
      const outside = nativePath.join(root, "outside.patch");
      native.writeFileSync(outside, "foreign patch\n");
      const before = snapshot(outside);
      const target = nativePath.join(cwd, change.patch_path);
      native.mkdirSync(nativePath.dirname(target));
      installUnsafe(target, kind, outside);
      vi.mocked(fs.readFileSync).mockImplementation((file, ...args) => {
        if (String(file) === target) throw new Error("Unsafe patch must not be read");
        return native.readFileSync(file, ...args);
      });
      vi.clearAllMocks();

      failure(call, "target");

      expectNoWrites();
      expect(vi.mocked(fs.readFileSync).mock.calls.some(([file]) => String(file) === target)).toBe(
        false,
      );
      expect(snapshot(outside)).toEqual(before);
      expect(native.readdirSync(nativePath.dirname(target))).toEqual([nativePath.basename(target)]);
    },
  );
});

const boundCalls = [
  { name: "patch publication", call: () => writeChangePatch(cwd, change.change_id, patchBytes) },
  {
    name: "rewrite",
    call: () => rewriteChangeRequest(cwd, { ...change, description: "Updated description." }),
  },
];
describe.each(boundCalls)("$name requires existing valid CR", ({ call }) => {
  test("absence is not repaired and does not create managed roots", () => {
    failure(call, "missing");
    expectNoWrites();
    expect(native.readdirSync(cwd)).toEqual([]);
  });

  test.each([
    { stage: "parse", text: `{"private":"${secret}", broken` },
    { stage: "schema", text: JSON.stringify({ ...changeCase.value, risk: "high" }) },
    { stage: "identity", text: JSON.stringify(workspaceFileCases[0].foreignValue) },
  ] as const)("$stage-invalid existing CR is preserved, never revived", ({ stage, text }) => {
    const target = seed(changeCase.relative, text);
    const before = snapshot(target);
    vi.clearAllMocks();

    failure(call, stage);

    expectNoWrites();
    expect(snapshot(target)).toEqual(before);
    expect(native.readdirSync(cwd)).toEqual(["changes"]);
  });

  test.each(unsafeKinds)("rejects a %s changes root", (kind) => {
    const outside = nativePath.join(root, "outside");
    native.mkdirSync(outside);
    const sentinel = nativePath.join(outside, `${change.change_id}.json`);
    native.writeFileSync(sentinel, JSON.stringify(changeCase.value));
    const before = snapshot(sentinel);
    installUnsafe(nativePath.join(cwd, "changes"), kind, outside);
    vi.clearAllMocks();

    failure(call, "directory");

    expectNoWrites();
    expect(snapshot(sentinel)).toEqual(before);
    expect(native.readdirSync(outside)).toEqual([`${change.change_id}.json`]);
  });

  test.each(["symlink", "dangling-link", "directory", "fifo"] as const)(
    "rejects a %s existing CR target without reading it",
    (kind) => {
      const outside = nativePath.join(root, "outside.json");
      native.writeFileSync(outside, JSON.stringify(changeCase.value));
      const before = snapshot(outside);
      const target = nativePath.join(cwd, changeCase.relative);
      native.mkdirSync(nativePath.dirname(target));
      installUnsafe(target, kind, outside);
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error("Unsafe CR must not be read");
      });
      vi.clearAllMocks();

      failure(call, "target");

      expectNoWrites();
      expect(fs.readFileSync).not.toHaveBeenCalled();
      expect(snapshot(outside)).toEqual(before);
      expect(native.readdirSync(nativePath.dirname(target))).toEqual([nativePath.basename(target)]);
    },
  );
});

describe("existing ChangeRequest rewrite", () => {
  test("atomically replaces only existing JSON, preserving patch bytes and caller-supplied fields", () => {
    const target = seed(changeCase.relative, ` ${JSON.stringify(changeCase.value)}\n`);
    const patch = seed(change.patch_path, patchBytes);
    const patchBefore = snapshot(patch);
    const before = snapshot(target);
    const updated: ChangeRequest = {
      ...change,
      status: "approved",
      approval_ref: "pi-decision-527",
      approved_at: "2026-11-02T10:00:00Z",
      updated_at: "2026-11-02T10:00:00Z",
      description: "Caller supplied approval evidence.",
    };
    let observed = false;
    vi.mocked(fs.renameSync).mockImplementationOnce((temporary, final) => {
      expect(final).toBe(target);
      expect(snapshot(target)).toEqual(before);
      expect(JSON.parse(native.readFileSync(temporary, "utf8"))).toEqual(updated);
      expectClosed();
      native.renameSync(temporary, final);
      observed = true;
    });

    expect(rewriteChangeRequest(cwd, updated)).toBeUndefined();

    expect(observed).toBe(true);
    expect(readWorkspaceRecord(cwd, "change", change.change_id)).toEqual(updated);
    expect(snapshot(patch)).toEqual(patchBefore);
    expect(native.readdirSync(nativePath.dirname(target))).toEqual([nativePath.basename(target)]);
    expect(fs.linkSync).not.toHaveBeenCalled();
    expect(entropy.suffixes).toEqual(["a1b2", "abcd", "1234", "5678", "9999"]);
    expectClosed();
  });

  test("invalid complete replacement fails before paths or IO", () => {
    failure(() => rewriteChangeRequest(cwd, { ...change, risk: "high" }), "schema");
    expectNoPathOrIO();
  });

  test("rename failure preserves existing JSON and patch with no temporary or descriptor leak", () => {
    const target = seed(changeCase.relative, JSON.stringify(changeCase.value));
    const patch = seed(change.patch_path, patchBytes);
    const before = snapshot(target);
    const patchBefore = snapshot(patch);
    vi.mocked(fs.renameSync).mockImplementationOnce(() => fault());

    failure(() => rewriteChangeRequest(cwd, { ...change, description: "Updated." }), "write");

    expect(snapshot(target)).toEqual(before);
    expect(snapshot(patch)).toEqual(patchBefore);
    expect(native.readdirSync(nativePath.dirname(target))).toEqual([nativePath.basename(target)]);
    expectClosed();
  });
});
