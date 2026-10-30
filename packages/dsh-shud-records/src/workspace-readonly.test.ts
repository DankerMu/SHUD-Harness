import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { readWorkspaceRecord } from "./index.ts";
import { installUnsafe, recordCases } from "./test-harness.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    mkdirSync: vi.fn(actual.mkdirSync),
    readFileSync: vi.fn(actual.readFileSync),
    lstatSync: vi.fn(actual.lstatSync),
  };
});
const native = await vi.importActual<typeof fs>("node:fs");
let cwd: string;
beforeEach(() => {
  cwd = native.mkdtempSync(join(tmpdir(), "report-readonly-"));
  vi.mocked(fs.mkdirSync).mockReset().mockImplementation(native.mkdirSync);
  vi.mocked(fs.readFileSync).mockReset().mockImplementation(native.readFileSync);
  vi.mocked(fs.lstatSync).mockReset().mockImplementation(native.lstatSync);
});
afterEach(() => {
  native.rmSync(cwd, { recursive: true, force: true });
});

for (const fixture of recordCases) {
  test(`${fixture.kind} readonly missing read never creates directories; legacy read still does`, () => {
    expect(() => readWorkspaceRecord(cwd, fixture.kind, fixture.id, { readonly: true })).toThrow();
    expect(fs.mkdirSync).not.toHaveBeenCalled();
    expect(native.readdirSync(cwd)).toEqual([]);
    expect(() => readWorkspaceRecord(cwd, fixture.kind, fixture.id)).toThrow();
    expect(native.existsSync(join(cwd, fixture.directory))).toBe(true);
    if (fixture.kind === "task")
      expect(native.existsSync(dirname(join(cwd, fixture.relative)))).toBe(true);
  });
  test(`${fixture.kind} readonly returns schema-bound identity without byte or mtime changes`, () => {
    const path = join(cwd, fixture.relative);
    native.mkdirSync(dirname(path), { recursive: true });
    native.writeFileSync(path, JSON.stringify(fixture.value));
    const before = native.statSync(path, { bigint: true });
    expect(readWorkspaceRecord(cwd, fixture.kind, fixture.id, { readonly: true })).toEqual(
      fixture.value,
    );
    expect(native.statSync(path, { bigint: true }).mtimeNs).toBe(before.mtimeNs);
    expect(fs.mkdirSync).not.toHaveBeenCalled();
  });
  test(`${fixture.kind} readonly rejects a schema-valid foreign embedded id`, () => {
    const path = join(cwd, fixture.relative);
    native.mkdirSync(dirname(path), { recursive: true });
    native.writeFileSync(
      path,
      JSON.stringify({
        ...fixture.value,
        [`${fixture.kind}_id`]: `${fixture.id.slice(0, -4)}ffff`,
      }),
    );
    const before = native.readFileSync(path);
    expect(() => readWorkspaceRecord(cwd, fixture.kind, fixture.id, { readonly: true })).toThrow();
    expect(native.readFileSync(path)).toEqual(before);
    expect(fs.mkdirSync).not.toHaveBeenCalled();
  });
  test.each(["symlink", "dangling-link", "fifo", "directory"] as const)(
    `${fixture.kind} readonly rejects %s target`,
    (kind) => {
      const path = join(cwd, fixture.relative);
      native.mkdirSync(dirname(path), { recursive: true });
      const outside = join(cwd, "outside.json");
      native.writeFileSync(outside, JSON.stringify(fixture.value));
      installUnsafe(path, kind, outside);
      vi.clearAllMocks();
      expect(() =>
        readWorkspaceRecord(cwd, fixture.kind, fixture.id, { readonly: true }),
      ).toThrow();
      expect(fs.readFileSync).not.toHaveBeenCalled();
      expect(fs.mkdirSync).not.toHaveBeenCalled();
      expect(native.readFileSync(outside, "utf8")).toBe(JSON.stringify(fixture.value));
    },
  );
  test.each(["symlink", "file", "fifo"] as const)(
    `${fixture.kind} readonly rejects %s managed ancestor`,
    (kind) => {
      const outside = join(cwd, "outside");
      native.mkdirSync(outside);
      installUnsafe(join(cwd, fixture.directory), kind, outside);
      expect(() =>
        readWorkspaceRecord(cwd, fixture.kind, fixture.id, { readonly: true }),
      ).toThrow();
      expect(fs.mkdirSync).not.toHaveBeenCalled();
      expect(fs.readFileSync).not.toHaveBeenCalled();
      expect(native.readdirSync(outside)).toEqual([]);
    },
  );
  test(`${fixture.kind} malformed id rejects before path IO`, () => {
    expect(() => readWorkspaceRecord(cwd, fixture.kind, "../escape", { readonly: true })).toThrow();
    expect(fs.mkdirSync).not.toHaveBeenCalled();
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(fs.lstatSync).not.toHaveBeenCalled();
  });
}
