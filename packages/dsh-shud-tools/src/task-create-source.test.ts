import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { expectToolError } from "./task-linked/test-harness.ts";
import {
  changeHarness,
  git,
  PRIVATE,
  readCard,
  seedSource,
  seedTask,
  sourceSnapshot,
  taskArgs,
  type ChangeHarness,
  valueOf,
} from "./change-create/test-harness.ts";

const hooks = vi.hoisted(() => ({
  git: undefined as ((argv: readonly string[]) => void) | undefined,
  stderr: false,
}));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof childProcess>();
  return {
    ...actual,
    execFile: vi.fn((...args: Parameters<typeof actual.execFile>) => {
      if (Array.isArray(args[1])) hooks.git?.(args[1]);
      if (hooks.stderr && Array.isArray(args[1]) && args[1].includes("HEAD")) {
        const callback = args[3];
        return actual.execFile(args[0], args[1], args[2], (_error, stdout) => {
          callback?.(
            Object.assign(new Error("Injected Git exit"), { code: 128 }),
            stdout,
            Buffer.from("PRIVATE_CHANGE_FIXTURE_536"),
          );
        });
      }
      return actual.execFile(...args);
    }),
  };
});
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    lstatSync: vi.fn(actual.lstatSync),
    readFileSync: vi.fn(actual.readFileSync),
    mkdirSync: vi.fn(actual.mkdirSync),
  };
});
const native = await vi.importActual<typeof fs>("node:fs");
let h: ChangeHarness;
beforeEach(async () => {
  vi.clearAllMocks();
  hooks.git = undefined;
  hooks.stderr = false;
  h = await changeHarness();
});
afterEach(async () => {
  hooks.git = undefined;
  hooks.stderr = false;
  vi.mocked(fs.lstatSync).mockImplementation(native.lstatSync);
  vi.mocked(fs.mkdirSync).mockImplementation(native.mkdirSync);
  await h.dispose();
});

test.each(["absent", "symlink", "file", "fifo", "nonrepo", "nested", "unborn", "sha256"])(
  "code_change rejects %s checkout before task directory creation",
  async (kind) => {
    fs.mkdirSync(join(h.cwd, "repos"));
    if (kind === "symlink") {
      const outside = join(h.root, "outside");
      fs.mkdirSync(outside);
      fs.symlinkSync(outside, h.source);
    } else if (kind === "file") fs.writeFileSync(h.source, PRIVATE);
    else if (kind === "fifo") childProcess.execFileSync("mkfifo", [h.source]);
    else if (kind === "sha256") seedSource(h, ["Makefile"], "sha256");
    else if (kind !== "absent") {
      fs.mkdirSync(h.source);
      if (kind === "unborn") git(h.source, "init", "-q", "--template=");
      if (kind === "nested") git(h.cwd, "init", "-q", "--template=");
    }
    vi.mocked(fs.mkdirSync).mockClear();
    const message = expectToolError(await h.invoke("task_create", taskArgs), /repos\/SHUD/iu);
    expect(message).not.toContain(PRIVATE);
    expect(fs.existsSync(join(h.cwd, "tasks"))).toBe(false);
    expect(fs.mkdirSync).not.toHaveBeenCalled();
  },
);

test("code_change validates root and HEAD before making task directories and leaves checkout unchanged", async () => {
  const head = seedSource(h);
  const before = sourceSnapshot(h);
  const order: string[] = [];
  hooks.git = (argv) => {
    if (argv.includes("rev-parse")) order.push(argv.at(-1)!);
  };
  vi.mocked(fs.mkdirSync).mockImplementation((...args) => {
    if (String(args[0]).startsWith(join(h.cwd, "tasks"))) order.push("mkdir-task");
    return native.mkdirSync(...args);
  });
  const id = await seedTask(h);
  expect(readCard(h, id).source_base_commit).toBe(head);
  expect(order.slice(0, 2)).toEqual(["--show-toplevel", "HEAD"]);
  expect(order.indexOf("mkdir-task")).toBeGreaterThan(1);
  expect(sourceSnapshot(h)).toEqual(before);
});

test.each(["missing", "broken-repos", "broken-checkout"])(
  "science_assist never inspects the %s checkout namespace",
  async (kind) => {
    if (kind === "broken-repos") fs.symlinkSync(join(h.root, "missing"), join(h.cwd, "repos"));
    if (kind === "broken-checkout") {
      fs.mkdirSync(join(h.cwd, "repos"));
      fs.symlinkSync(join(h.root, "missing"), h.source);
    }
    const repos = join(h.cwd, "repos");
    vi.mocked(fs.lstatSync).mockImplementation((...args) => {
      if (String(args[0]).startsWith(repos)) throw new Error(PRIVATE);
      return native.lstatSync(...args);
    });
    vi.mocked(childProcess.execFile).mockClear();
    vi.mocked(fs.readFileSync).mockClear();
    const result = valueOf(await h.invoke("task_create", { ...taskArgs, type: "science_assist" }));
    const entries = fs.readdirSync(join(h.cwd, "tasks"));
    expect(entries).toEqual([result.task_id]);
    const card: unknown = JSON.parse(
      native.readFileSync(join(h.cwd, "tasks", entries[0], "task.json"), "utf8"),
    );
    expect(card).toMatchObject({
      type: "science_assist",
      source_base_commit: null,
      status: "planned",
    });
    expect(childProcess.execFile).not.toHaveBeenCalled();
    expect(
      vi.mocked(fs.lstatSync).mock.calls.some(([path]) => String(path).startsWith(repos)),
    ).toBe(false);
    expect(
      vi.mocked(fs.readFileSync).mock.calls.some(([path]) => String(path).startsWith(repos)),
    ).toBe(false);
  },
);

test.each(["native", "git"])("checkout %s faults suppress private cause details", async (kind) => {
  seedSource(h);
  if (kind === "native") {
    vi.mocked(fs.lstatSync).mockImplementation((...args) => {
      if (String(args[0]) === h.source) throw Object.assign(new Error(PRIVATE), { code: "EACCES" });
      return native.lstatSync(...args);
    });
  } else
    hooks.git = () => {
      throw Object.assign(new Error(PRIVATE), { code: "EIO", stderr: Buffer.from(PRIVATE) });
    };
  const message = expectToolError(
    await h.invoke("task_create", taskArgs),
    /repos\/SHUD.*validation/iu,
  );
  expect(message).not.toContain(PRIVATE);
  expect(fs.existsSync(join(h.cwd, "tasks"))).toBe(false);
});

test("HEAD subprocess stderr is redacted at the model-facing checkout boundary", async () => {
  seedSource(h);
  hooks.stderr = true;
  const message = expectToolError(await h.invoke("task_create", taskArgs), /repos\/SHUD.*HEAD/iu);
  expect(message).not.toContain(PRIVATE);
  expect(fs.existsSync(join(h.cwd, "tasks"))).toBe(false);
});

test.each([
  null,
  [],
  "task",
  3,
  { ...taskArgs, type: "engineering" },
  { ...taskArgs, source_path: "repos/SHUD" },
  { ...taskArgs, title: "" },
  { ...taskArgs, question_or_goal: "" },
])("code_change rejects invalid arguments before checkout IO: %j", async (args) => {
  vi.clearAllMocks();
  expectToolError(await h.invoke("task_create", args), /object|type|parameter|nonempty/iu);
  expect(childProcess.execFile).not.toHaveBeenCalled();
  expect(fs.lstatSync).not.toHaveBeenCalled();
  expect(fs.readFileSync).not.toHaveBeenCalled();
  expect(fs.mkdirSync).not.toHaveBeenCalled();
});
