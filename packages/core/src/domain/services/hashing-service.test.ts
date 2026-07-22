import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:net";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  utimes,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  WorkspacePathSafetyError,
  hashDirectory,
  hashFile,
  type HashingServiceInput
} from "./index";

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const DIRECTORY_ORACLE = "abeb7f0f89055fff57ff5fdec6e07f6b397071d82f6b11e52d068bef7951bb0d";
const COLLIDING_DIRECTORY_ORACLE =
  "b6bfe7d76032d5a8702f538c8b26915dc76ff20e6a0d33267b4721dd046fa760";
const tempRoots: string[] = [];
const socketServers: Server[] = [];

describe("hashing service", () => {
  afterEach(async () => {
    await Promise.all(socketServers.splice(0).map(closeServer));
    await Promise.all(
      tempRoots.splice(0).map((tempRoot) => rm(tempRoot, { recursive: true, force: true }))
    );
  });

  test("services barrel exposes only the fixed public hashing API and production has no test hooks", async () => {
    const { workspaceRoot } = await createWorkspace();
    await writeFile(join(workspaceRoot, "public.txt"), "public-contract");
    const input: HashingServiceInput = {
      workspaceRoot,
      inputPath: "public.txt",
      evidenceRef: "hash.public-contract"
    };

    const pendingDigest: Promise<string> = hashFile(input);
    expect(await pendingDigest).toMatch(/^[a-f0-9]{64}$/);

    const serviceExports = await import("./index");
    expect(serviceExports.hashFile).toBe(hashFile);
    expect(serviceExports.hashDirectory).toBe(hashDirectory);
    expect("runWithHashingServiceHooksForTest" in serviceExports).toBe(false);
    const source = await readFile(join(import.meta.dir, "hashing-service.ts"), "utf8");
    expect(source).not.toMatch(
      /AsyncLocalStorage|HashingServiceHooks|runWithHashingServiceHooksForTest/
    );
  });

  test("hashFile matches independent sha256 oracles for known, empty, and multi-chunk bytes", async () => {
    const { workspaceRoot } = await createWorkspace();
    const largeBytes = Buffer.alloc(1024 * 1024 + 31);
    for (let index = 0; index < largeBytes.length; index += 1) {
      largeBytes[index] = index % 251;
    }
    await Promise.all([
      writeFile(join(workspaceRoot, "known.bin"), "abc"),
      writeFile(join(workspaceRoot, "empty.bin"), Buffer.alloc(0)),
      writeFile(join(workspaceRoot, "large.bin"), largeBytes)
    ]);

    expect(await hashFile(hashInput(workspaceRoot, "known.bin", "hash.known"))).toBe(ABC_SHA256);
    expect(await hashFile(hashInput(workspaceRoot, "empty.bin", "hash.empty"))).toBe(EMPTY_SHA256);
    expect(await hashFile(hashInput(workspaceRoot, "large.bin", "hash.large"))).toBe(
      createHash("sha256").update(largeBytes).digest("hex")
    );

    const source = await readFile(join(import.meta.dir, "hashing-service.ts"), "utf8");
    expect(source).not.toMatch(/\breadFile(?:Sync)?\b/);
  });

  test("hashDirectory implements the exact canonical line protocol independent of creation order", async () => {
    const { workspaceRoot } = await createWorkspace();
    const first = join(workspaceRoot, "first");
    const second = join(workspaceRoot, "second");
    await mkdir(join(first, "nested"), { recursive: true });
    await writeFile(join(first, "a.txt"), "A");
    await writeFile(join(first, "nested", "b.txt"), "B");

    await mkdir(join(second, "nested"), { recursive: true });
    await writeFile(join(second, "nested", "b.txt"), "B");
    await writeFile(join(second, "a.txt"), "A");

    const firstDigest = await hashDirectory(hashInput(workspaceRoot, "first", "hash.directory.first"));
    expect(firstDigest).toBe(DIRECTORY_ORACLE);
    expect(await hashDirectory(hashInput(workspaceRoot, "first", "hash.directory.repeat"))).toBe(
      DIRECTORY_ORACLE
    );
    expect(await hashDirectory(hashInput(workspaceRoot, "second", "hash.directory.second"))).toBe(
      DIRECTORY_ORACLE
    );
  });

  test("hashDirectory supports the workspace boundary root by relative and absolute path", async () => {
    const { workspaceRoot } = await createWorkspace();
    await writeFile(join(workspaceRoot, "root.txt"), "root bytes");
    const baselineOracle = exactDirectoryDigest({ "root.txt": "root bytes" });
    expect(await hashDirectory(hashInput(workspaceRoot, ".", "hash.boundary.relative"))).toBe(baselineOracle);
    expect(await hashDirectory(
      hashInput(workspaceRoot, workspaceRoot, "hash.boundary.absolute")
    )).toBe(baselineOracle);
    expect(await hashDirectory(hashInput(workspaceRoot, ".", "hash.boundary.repeat"))).toBe(baselineOracle);
    await writeFile(join(workspaceRoot, "root.txt"), "changed root bytes");
    const changed = await hashDirectory(hashInput(workspaceRoot, workspaceRoot, "hash.boundary.changed"));
    expect(changed).toBe(exactDirectoryDigest({ "root.txt": "changed root bytes" }));
    expect(changed).not.toBe(baselineOracle);
  });

  test("hashDirectory supports an exact allowed read-only boundary root", async () => {
    const { tempRoot, workspaceRoot } = await createWorkspace();
    const readonlyRoot = join(tempRoot, "readonly-root");
    await mkdir(readonlyRoot);
    await writeFile(join(readonlyRoot, "evidence.txt"), "readonly bytes");
    const input = (evidenceRef: string): HashingServiceInput => ({ workspaceRoot,
      inputPath: readonlyRoot, evidenceRef, allowedReadonlyRoots: [readonlyRoot] });
    const baselineOracle = exactDirectoryDigest({ "evidence.txt": "readonly bytes" });
    expect(await hashDirectory(input("hash.boundary.readonly"))).toBe(baselineOracle);
    expect(await hashDirectory(input("hash.boundary.readonly.repeat"))).toBe(baselineOracle);

    await writeFile(join(readonlyRoot, "evidence.txt"), "changed readonly bytes");
    const changed = await hashDirectory(input("hash.boundary.readonly.changed"));
    expect(changed).toBe(exactDirectoryDigest({ "evidence.txt": "changed readonly bytes" }));
    expect(changed).not.toBe(baselineOracle);
  });

  test("hashDirectory preserves root sibling names that differ only by a leading BOM", async () => {
    const { workspaceRoot } = await createWorkspace();
    const directory = join(workspaceRoot, "bom-root");
    const bomName = "\uFEFFa";
    await mkdir(directory);
    await writeFile(join(directory, "a"), "ordinary");
    await writeFile(join(directory, bomName), "bom-prefixed");

    const baselineFiles = Object.freeze({ a: "ordinary", [bomName]: "bom-prefixed" });
    const baseline = await hashDirectory(hashInput(workspaceRoot, "bom-root", "hash.bom.root"));
    expect(baseline).toBe(exactDirectoryDigest(baselineFiles));

    await writeFile(join(directory, "a"), "ordinary-changed");
    const ordinaryChanged = await hashDirectory(
      hashInput(workspaceRoot, "bom-root", "hash.bom.root.ordinary")
    );
    expect(ordinaryChanged).toBe(
      exactDirectoryDigest({ a: "ordinary-changed", [bomName]: "bom-prefixed" })
    );
    expect(ordinaryChanged).not.toBe(baseline);

    await writeFile(join(directory, "a"), "ordinary");
    await writeFile(join(directory, bomName), "bom-prefixed-changed");
    const bomChanged = await hashDirectory(
      hashInput(workspaceRoot, "bom-root", "hash.bom.root.prefixed")
    );
    expect(bomChanged).toBe(
      exactDirectoryDigest({ a: "ordinary", [bomName]: "bom-prefixed-changed" })
    );
    expect(bomChanged).not.toBe(baseline);
  });

  test("hashDirectory preserves nested directory names that differ only by a leading BOM", async () => {
    const { workspaceRoot } = await createWorkspace();
    const directory = join(workspaceRoot, "bom-nested");
    const bomName = "\uFEFFa";
    await mkdir(join(directory, "a"), { recursive: true });
    await mkdir(join(directory, bomName));
    await writeFile(join(directory, "a", "value"), "ordinary nested");
    await writeFile(join(directory, bomName, "value"), "bom nested");

    const baselineFiles = Object.freeze({
      "a/value": "ordinary nested",
      [`${bomName}/value`]: "bom nested"
    });
    const baseline = await hashDirectory(
      hashInput(workspaceRoot, "bom-nested", "hash.bom.nested")
    );
    expect(baseline).toBe(exactDirectoryDigest(baselineFiles));

    await writeFile(join(directory, "a", "value"), "ordinary nested changed");
    const ordinaryChanged = await hashDirectory(
      hashInput(workspaceRoot, "bom-nested", "hash.bom.nested.ordinary")
    );
    expect(ordinaryChanged).toBe(
      exactDirectoryDigest({
        "a/value": "ordinary nested changed",
        [`${bomName}/value`]: "bom nested"
      })
    );
    expect(ordinaryChanged).not.toBe(baseline);

    await writeFile(join(directory, "a", "value"), "ordinary nested");
    await writeFile(join(directory, bomName, "value"), "bom nested changed");
    const bomChanged = await hashDirectory(
      hashInput(workspaceRoot, "bom-nested", "hash.bom.nested.prefixed")
    );
    expect(bomChanged).toBe(
      exactDirectoryDigest({
        "a/value": "ordinary nested",
        [`${bomName}/value`]: "bom nested changed"
      })
    );
    expect(bomChanged).not.toBe(baseline);
  });

  test("hashDirectory rejects the exact LF-path collision while preserving the canonical oracle", async () => {
    const { workspaceRoot } = await createWorkspace();
    const ordinaryTree = join(workspaceRoot, "ordinary");
    const collidingTree = join(workspaceRoot, "colliding");
    const aDigest = createHash("sha256").update("A").digest("hex");
    await Promise.all([mkdir(ordinaryTree), mkdir(collidingTree)]);
    await Promise.all([
      writeFile(join(ordinaryTree, "a"), "A"),
      writeFile(join(ordinaryTree, "b"), "B"),
      writeFile(join(collidingTree, `a\n${aDigest}\nb`), "B")
    ]);

    expect(await hashDirectory(hashInput(workspaceRoot, "ordinary", "hash.lf.ordinary"))).toBe(
      COLLIDING_DIRECTORY_ORACLE
    );
    await expectPathSafety(
      () => hashDirectory(hashInput(workspaceRoot, "colliding", "hash.lf.collision")),
      "hash.lf.collision"
    );
  });

  test("hashDirectory rejects LF in a nested relative-path segment", async () => {
    const { workspaceRoot } = await createWorkspace();
    await mkdir(join(workspaceRoot, "tree", "nested\nsegment"), { recursive: true });
    await writeFile(join(workspaceRoot, "tree", "nested\nsegment", "evidence.txt"), "evidence");

    await expectPathSafety(
      () => hashDirectory(hashInput(workspaceRoot, "tree", "hash.lf.nested")),
      "hash.lf.nested"
    );
  });

  test("hashDirectory changes for added files, changed bytes, and renamed canonical paths", async () => {
    const { workspaceRoot } = await createWorkspace();
    const directory = join(workspaceRoot, "dataset");
    await mkdir(join(directory, "nested"), { recursive: true });
    await writeFile(join(directory, "a.txt"), "A");
    await writeFile(join(directory, "nested", "b.txt"), "B");
    const baseline = await hashDirectory(hashInput(workspaceRoot, "dataset", "hash.change.baseline"));

    await writeFile(join(directory, "added.txt"), "added");
    const afterAdd = await hashDirectory(hashInput(workspaceRoot, "dataset", "hash.change.add"));
    expect(afterAdd).not.toBe(baseline);
    await rm(join(directory, "added.txt"));

    await writeFile(join(directory, "a.txt"), "changed");
    const afterContentChange = await hashDirectory(
      hashInput(workspaceRoot, "dataset", "hash.change.content")
    );
    expect(afterContentChange).not.toBe(baseline);
    await writeFile(join(directory, "a.txt"), "A");

    await rename(join(directory, "nested", "b.txt"), join(directory, "nested", "renamed.txt"));
    const afterRename = await hashDirectory(hashInput(workspaceRoot, "dataset", "hash.change.rename"));
    expect(afterRename).not.toBe(baseline);
  });

  test("read-only boundaries are accepted while missing, outside, and traversal paths fail closed", async () => {
    const { tempRoot, workspaceRoot } = await createWorkspace();
    const readonlyRoot = join(tempRoot, "readonly");
    await mkdir(readonlyRoot);
    await writeFile(join(readonlyRoot, "evidence.txt"), "readonly evidence");

    expect(
      await hashFile({
        workspaceRoot,
        inputPath: join(readonlyRoot, "evidence.txt"),
        evidenceRef: "hash.readonly",
        allowedReadonlyRoots: [readonlyRoot]
      })
    ).toBe(createHash("sha256").update("readonly evidence").digest("hex"));

    await expectPathSafety(
      () => hashFile(hashInput(workspaceRoot, "missing.txt", "hash.missing")),
      "hash.missing"
    );
    await expectPathSafety(
      () => hashFile(hashInput(workspaceRoot, join(tempRoot, "outside.txt"), "hash.outside")),
      "hash.outside"
    );
    await expectPathSafety(
      () => hashFile(hashInput(workspaceRoot, "../outside.txt", "hash.traversal")),
      "hash.traversal"
    );
  });

  test("wrong root types and directories without regular files fail with path-safety errors", async () => {
    const { workspaceRoot } = await createWorkspace();
    await writeFile(join(workspaceRoot, "file.txt"), "file");
    await mkdir(join(workspaceRoot, "directory", "nested"), { recursive: true });

    await expectPathSafety(
      () => hashFile(hashInput(workspaceRoot, "directory", "hash.wrong.file")),
      "hash.wrong.file"
    );
    await expectPathSafety(
      () => hashDirectory(hashInput(workspaceRoot, "file.txt", "hash.wrong.directory")),
      "hash.wrong.directory"
    );
    await expectPathSafety(
      () => hashDirectory(hashInput(workspaceRoot, "directory", "hash.empty-directory")),
      "hash.empty-directory"
    );
  });

  test("root, leaf, ancestor, nested, and broken symlinks are never accepted", async () => {
    const { tempRoot, workspaceRoot } = await createWorkspace();
    const actualWorkspace = join(tempRoot, "actual-workspace");
    const workspaceLink = join(tempRoot, "workspace-link");
    await mkdir(actualWorkspace);
    await writeFile(join(actualWorkspace, "root.txt"), "root");
    await symlink(actualWorkspace, workspaceLink);
    await expectPathSafety(
      () => hashFile(hashInput(workspaceLink, "root.txt", "hash.symlink.workspace-root")),
      "hash.symlink.workspace-root"
    );

    const safeDirectory = join(workspaceRoot, "safe-directory");
    await mkdir(safeDirectory);
    await writeFile(join(safeDirectory, "file.txt"), "safe");
    await symlink(safeDirectory, join(workspaceRoot, "root-directory-link"));
    await symlink(join(safeDirectory, "file.txt"), join(workspaceRoot, "leaf-file-link"));
    await symlink(safeDirectory, join(workspaceRoot, "ancestor-link"));
    await symlink("does-not-exist", join(workspaceRoot, "broken-link"));

    await expectPathSafety(
      () => hashDirectory(hashInput(workspaceRoot, "root-directory-link", "hash.symlink.root")),
      "hash.symlink.root"
    );
    await expectPathSafety(
      () => hashFile(hashInput(workspaceRoot, "leaf-file-link", "hash.symlink.leaf")),
      "hash.symlink.leaf"
    );
    await expectPathSafety(
      () => hashFile(hashInput(workspaceRoot, "ancestor-link/file.txt", "hash.symlink.ancestor")),
      "hash.symlink.ancestor"
    );
    await expectPathSafety(
      () => hashFile(hashInput(workspaceRoot, "broken-link", "hash.symlink.broken")),
      "hash.symlink.broken"
    );

    const tree = join(workspaceRoot, "tree");
    await mkdir(tree);
    await writeFile(join(tree, "regular.txt"), "regular");
    await symlink(join(safeDirectory, "file.txt"), join(tree, "nested-link"));
    await expectPathSafety(
      () => hashDirectory(hashInput(workspaceRoot, "tree", "hash.symlink.nested")),
      "hash.symlink.nested"
    );
  });

  test.skipIf(process.platform === "win32")(
    "FIFO and socket entries are rejected within a bounded interval before blocking reads",
    async () => {
      const { workspaceRoot } = await createWorkspace();
      const fifoTree = join(workspaceRoot, "fifo-tree");
      await mkdir(fifoTree);
      await createFifo(join(fifoTree, "blocking.fifo"));

      const fifoProbe = await runBoundedHashProbe(workspaceRoot, "fifo-tree", 1_000);
      expect(fifoProbe.timedOut).toBe(false);
      expect(fifoProbe.exitCode).toBe(0);
      expect(fifoProbe.stdout.trim()).toBe("WorkspacePathSafetyError");

      const socketTree = join(workspaceRoot, "s");
      const socketPath = join(socketTree, "x");
      await mkdir(socketTree);
      const server = createServer();
      socketServers.push(server);
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(socketPath, resolveListen);
      });
      await expectPathSafety(
        () => hashDirectory(hashInput(workspaceRoot, "s", "hash.socket")),
        "hash.socket"
      );
    }
  );

  test("post-first-chunk truncation fails closed without returning a partial digest", async () => {
    const { workspaceRoot } = await createWorkspace();
    const path = join(workspaceRoot, "changing.bin");
    const initialSize = 64 * 1024 * 1024;
    await writeFile(path, "");
    await truncate(path, initialSize);
    const initialAtime = await makeAtimeObservable(path);

    const outcome = settle(hashFile(hashInput(workspaceRoot, "changing.bin", "hash.read.truncate")));
    await waitForAtimeChange(path, initialAtime);
    await truncate(path, initialSize / 2);

    await expectSettledPathSafety(outcome, "hash.read.truncate", 2_000);
  });

  test("active sparse appender cannot extend hashing beyond the initially opened size", async () => {
    const { workspaceRoot } = await createWorkspace();
    const path = join(workspaceRoot, "appending.bin");
    const initialSize = 64 * 1024 * 1024;
    await writeFile(path, "");
    await truncate(path, initialSize);
    const initialAtime = await makeAtimeObservable(path);
    const appender = await startSparseAppender(path, initialSize);

    const outcome = settle(hashFile(hashInput(workspaceRoot, "appending.bin", "hash.read.append")));
    await waitForAtimeChange(path, initialAtime);
    appender.start();
    try {
      await expectSettledPathSafety(outcome, "hash.read.append", 2_000);
      expect(appender.exited).toBe(false);
    } finally {
      await appender.stop();
      await truncate(path, initialSize);
      await outcome;
    }
  });

  test("LF and synthetic duplicate entries reject before affected inode reads", async () => {
    const { workspaceRoot } = await createWorkspace();
    const result = await runPreContentRejectionProbe(workspaceRoot);
    expect(result.controlReadCalls).toBeGreaterThan(0);
    expect(result).toMatchObject({
      lfError: { name: "WorkspacePathSafetyError", evidenceRef: "hash.precontent.lf" },
      duplicateError: { name: "WorkspacePathSafetyError", evidenceRef: "hash.precontent.duplicate" },
      lfAffectedReads: 0, duplicateAffectedReads: 0,
      duplicateReplayed: true
    });
  });

  test("root and nested directory substitution never enumerate symlink targets", async () => {
    const { workspaceRoot } = await createWorkspace();
    for (const scope of ["root", "nested"] as const) {
      const result = await runDirectorySubstitutionProbe(workspaceRoot, scope);
      expect(result).toMatchObject({
        errorName: "WorkspacePathSafetyError",
        evidenceRef: `hash.directory-swap.${scope}`,
        replacementEnumerated: false
      });
      expect(result.descriptorEnumerationCalls).toBeGreaterThan(0);
    }
  });

  test("ancestor and leaf substitution never read replacement file bytes", async () => {
    const { workspaceRoot } = await createWorkspace();
    for (const scope of ["ancestor", "leaf"] as const) {
      const result = await runFileSubstitutionProbe(workspaceRoot, scope);
      expect(result).toMatchObject({
        errorName: "WorkspacePathSafetyError",
        evidenceRef: `hash.file-swap.${scope}`,
        replacementRead: false
      });
      expect(result.descriptorReadCalls).toBeGreaterThan(0);
    }
  });
});

function hashInput(
  workspaceRoot: string,
  inputPath: string,
  evidenceRef: string
): HashingServiceInput {
  return { workspaceRoot, inputPath, evidenceRef };
}

function exactDirectoryDigest(files: Readonly<Record<string, string>>): string {
  const framing = Object.entries(files)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([path, contents]) => {
      const fileDigest = createHash("sha256").update(contents).digest("hex");
      return `${path}\n${fileDigest}\n`;
    })
    .join("");
  return createHash("sha256").update(framing).digest("hex");
}

async function createWorkspace(): Promise<{ tempRoot: string; workspaceRoot: string }> {
  const physicalTempRoot = await realpath(tmpdir());
  const tempRoot = await mkdtemp(join(physicalTempRoot, "hs-"));
  tempRoots.push(tempRoot);
  const workspaceRoot = join(tempRoot, "w");
  await mkdir(workspaceRoot);
  return { tempRoot, workspaceRoot };
}

async function expectPathSafety(
  action: () => Promise<unknown>,
  evidenceRef: string
): Promise<void> {
  let failure: unknown;
  try {
    await action();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(WorkspacePathSafetyError);
  expect((failure as WorkspacePathSafetyError).evidenceRef).toBe(evidenceRef);
}

async function createFifo(path: string): Promise<void> {
  const child = Bun.spawn(["mkfifo", path], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text()
  ]);
  if (exitCode !== 0) {
    throw new Error(`mkfifo failed with exit ${exitCode}: ${stderr.trim()}`);
  }
}

async function runBoundedHashProbe(
  workspaceRoot: string,
  inputPath: string,
  timeoutMs: number
): Promise<Readonly<{ timedOut: boolean; exitCode: number | null; stdout: string; stderr: string }>> {
  const script = `
    import { hashDirectory, WorkspacePathSafetyError } from "./packages/core/src/domain/services/index.ts";
    try {
      await hashDirectory(${JSON.stringify(
        hashInput(workspaceRoot, inputPath, "hash.fifo")
      )});
      console.log("unexpected-success");
      process.exit(2);
    } catch (error) {
      console.log(error instanceof WorkspacePathSafetyError ? error.name : "unexpected-error");
      process.exit(error instanceof WorkspacePathSafetyError ? 0 : 3);
    }
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    cwd: resolve(import.meta.dir, "../../../../.."),
    stdout: "pipe",
    stderr: "pipe"
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    child.exited.then((exitCode) => ({ timedOut: false as const, exitCode })),
    new Promise<{ timedOut: true; exitCode: null }>((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout({ timedOut: true, exitCode: null }), timeoutMs);
    })
  ]);
  if (timer) clearTimeout(timer);
  if (outcome.timedOut) {
    child.kill(9);
    await child.exited;
  }
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ]);
  return Object.freeze({ ...outcome, stdout, stderr });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

type Settled<T> = Readonly<{ status: "fulfilled"; value: T }> | Readonly<{
  status: "rejected";
  reason: unknown;
}>;

function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value) => Object.freeze({ status: "fulfilled" as const, value }),
    (reason) => Object.freeze({ status: "rejected" as const, reason })
  );
}

async function expectSettledPathSafety(
  outcome: Promise<Settled<unknown>>,
  evidenceRef: string,
  timeoutMs: number
): Promise<void> {
  const result = await Promise.race([
    outcome,
    Bun.sleep(timeoutMs).then(() => Object.freeze({ status: "timed_out" as const }))
  ]);
  expect(result.status).not.toBe("timed_out");
  if (result.status === "timed_out") return;
  expect(result.status).toBe("rejected");
  if (result.status !== "rejected") return;
  expect(result.reason).toBeInstanceOf(WorkspacePathSafetyError);
  expect((result.reason as WorkspacePathSafetyError).evidenceRef).toBe(evidenceRef);
}

async function makeAtimeObservable(path: string): Promise<bigint> {
  const oldAtime = new Date("2000-01-01T00:00:00.000Z");
  await utimes(path, oldAtime, new Date());
  return (await stat(path, { bigint: true })).atimeNs;
}

async function waitForAtimeChange(path: string, initialAtime: bigint): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if ((await stat(path, { bigint: true })).atimeNs !== initialAtime) return;
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for the hashing reader to consume its first chunk.");
}

async function startSparseAppender(
  path: string,
  initialSize: number
): Promise<Readonly<{ start: () => void; stop: () => Promise<void>; exited: boolean }>> {
  const script = `
    import { open } from "node:fs/promises";
    const file = await open(process.argv[1], "r+");
    const initialSize = Number(process.argv[2]);
    process.stdout.write("ready\\n");
    await new Promise((resolve) => process.stdin.once("data", resolve));
    let position = initialSize;
    try {
      for (;;) {
        position += 256 * 1024 * 1024;
        await file.write(Buffer.from([0]), 0, 1, position - 1);
        await Bun.sleep(1);
      }
    } finally {
      await file.close();
    }
  `;
  const child = Bun.spawn([process.execPath, "-e", script, path, String(initialSize)], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe"
  });
  const reader = child.stdout.getReader();
  const ready = await reader.read();
  reader.releaseLock();
  expect(new TextDecoder().decode(ready.value)).toContain("ready");
  let exited = false;
  void child.exited.then(() => {
    exited = true;
  });
  return Object.freeze({
    start: () => {
      child.stdin.write("start\n");
      child.stdin.flush();
    },
    stop: async () => {
      if (exited) return;
      child.kill(9);
      await child.exited;
      const stderr = await new Response(child.stderr).text();
      if (stderr.trim()) throw new Error(`Sparse appender failed: ${stderr.trim()}`);
    },
    get exited() {
      return exited;
    }
  });
}

async function runPreContentRejectionProbe(workspaceRoot: string): Promise<Readonly<{
  controlReadCalls: number; lfAffectedReads: number; duplicateAffectedReads: number;
  duplicateReplayed: boolean; lfError: ProbeError; duplicateError: ProbeError;
}>> {
  const script = `
    import { mock } from "bun:test";
    const fs = { ...await import("node:fs/promises") }, callbackFs = { ...await import("node:fs") };
    const ffi = { ...await import("bun:ffi") };
    const root = ${JSON.stringify(workspaceRoot)};
    const control = root + "/precontent-control.bin", lfTree = root + "/precontent-lf";
    const duplicateTree = root + "/precontent-duplicate";
    const lfPath = lfTree + "/affected\\nfile", duplicatePath = duplicateTree + "/affected.txt";
    await fs.mkdir(lfTree); await fs.mkdir(duplicateTree);
    await fs.writeFile(control, "control"); await fs.writeFile(lfPath, "lf affected"); await fs.writeFile(duplicatePath, "duplicate affected");
    const lfIdentity = await fs.stat(lfPath, { bigint: true }), duplicateIdentity = await fs.stat(duplicatePath, { bigint: true });
    let readCalls = 0, lfAffectedReads = 0, duplicateAffectedReads = 0;
    const same = (left, right) => left.dev === right.dev && left.ino === right.ino;
    mock.module("node:fs", () => ({ ...callbackFs, read: (descriptor, ...args) => {
      readCalls += 1; const identity = callbackFs.fstatSync(descriptor, { bigint: true });
      if (same(identity, lfIdentity)) lfAffectedReads += 1;
      if (same(identity, duplicateIdentity)) duplicateAffectedReads += 1;
      return callbackFs.read(descriptor, ...args);
    }}));
    let replayEntry = null, duplicateReplayed = false;
    const entryName = (entry) => {
      if (process.platform === "darwin") {
        const length = ffi.read.u16(entry, 18); return Buffer.from(ffi.toBuffer(entry, 21, length)).toString("utf8");
      }
      const recordLength = ffi.read.u16(entry, 16);
      const bytes = Buffer.from(ffi.toBuffer(entry, 19, recordLength - 19)); return bytes.subarray(0, bytes.indexOf(0)).toString("utf8");
    };
    mock.module("bun:ffi", () => ({ ...ffi, dlopen: (...args) => {
      const library = ffi.dlopen(...args);
      const symbols = new Proxy(library.symbols, { get(target, property) {
        const symbol = Reflect.get(target, property); if (property !== "readdir") return symbol;
        return (stream) => {
          if (replayEntry !== null) {
            const entry = replayEntry; replayEntry = null; duplicateReplayed = true; return entry;
          }
          const entry = symbol(stream);
          if (entry !== null && entryName(entry) === "affected.txt") replayEntry = entry;
          return entry;
        };
      }});
      return new Proxy(library, { get: (target, property) => property === "symbols" ? symbols : Reflect.get(target, property) });
    }}));
    const { hashDirectory, hashFile } = await import("./packages/core/src/domain/services/index.ts");
    await hashFile({ workspaceRoot: root, inputPath: control, evidenceRef: "hash.precontent.control" });
    const controlReadCalls = readCalls;
    const capture = async (action) => { try { await action(); return { name: null, evidenceRef: null }; } catch (error) {
      return { name: error?.name ?? null, evidenceRef: error?.evidenceRef ?? null }; } };
    const lfError = await capture(() => hashDirectory({ workspaceRoot: root, inputPath: lfTree, evidenceRef: "hash.precontent.lf" }));
    const duplicateError = await capture(() => hashDirectory({ workspaceRoot: root, inputPath: duplicateTree, evidenceRef: "hash.precontent.duplicate" }));
    console.log(JSON.stringify({ controlReadCalls, lfAffectedReads, duplicateAffectedReads, duplicateReplayed, lfError, duplicateError }));
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    cwd: resolve(import.meta.dir, "../../../../.."), stdout: "pipe", stderr: "pipe"
  });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited,
    new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(`Pre-content probe failed: ${stderr.trim()}`);
  return JSON.parse(stdout.trim());
}

type ProbeError = Readonly<{ name: string | null; evidenceRef: string | null }>;

async function runDirectorySubstitutionProbe(
  workspaceRoot: string,
  scope: "root" | "nested"
): Promise<
  Readonly<{
    errorName: string | null;
    evidenceRef: string | null;
    replacementEnumerated: boolean;
    descriptorEnumerationCalls: number;
  }>
> {
  const caseRoot = join(workspaceRoot, `directory-swap-${scope}`);
  const dataset = join(caseRoot, "dataset");
  const live = scope === "root" ? dataset : join(dataset, "nested");
  const displaced = `${live}-original`;
  const replacement = join(caseRoot, "replacement");
  const control = join(caseRoot, "control");
  await mkdir(live, { recursive: true });
  await mkdir(replacement, { recursive: true });
  await mkdir(control);
  await writeFile(join(live, "evidence.txt"), "original");
  await writeFile(join(replacement, "sentinel.txt"), "replacement");
  await writeFile(join(control, "control.txt"), "control");
  const triggerCount = scope === "root" ? 4 : 3;
  const input = hashInput(
    workspaceRoot,
    `directory-swap-${scope}/dataset`,
    `hash.directory-swap.${scope}`
  );
  const controlInput = hashInput(
    workspaceRoot,
    `directory-swap-${scope}/control`,
    `hash.directory-swap.${scope}.control`
  );
  const script = `
    import { mock } from "bun:test";
    const actual = { ...await import("node:fs/promises") };
    const actualFs = { ...await import("node:fs") };
    const actualFfi = { ...await import("bun:ffi") };
    const actualLstat = actual.lstat;
    const live = ${JSON.stringify(live)};
    const displaced = ${JSON.stringify(displaced)};
    const replacement = ${JSON.stringify(replacement)};
    const triggerCount = ${triggerCount};
    const replacementIdentity = await actual.stat(replacement, { bigint: true });
    let observations = 0;
    let swapped = false;
    let replacementEnumerated = false;
    let descriptorEnumerationCalls = 0;
    const replacementStreams = new Set();
    mock.module("node:fs/promises", () => ({
      ...actual,
      lstat: async (...args) => {
        const result = await actualLstat(...args);
        if (!swapped && String(args[0]) === live && ++observations === triggerCount) {
          await actual.rename(live, displaced);
          await actual.symlink(replacement, live);
          swapped = true;
        }
        return result;
      }
    }));
    mock.module("bun:ffi", () => ({
      ...actualFfi,
      dlopen: (...args) => {
        const library = actualFfi.dlopen(...args);
        const wrappedSymbols = new Proxy(library.symbols, {
          get(symbols, property) {
            const symbol = Reflect.get(symbols, property);
            if (property === "fdopendir") {
              return (descriptor) => {
                const identity = actualFs.fstatSync(descriptor, { bigint: true });
                const stream = symbol(descriptor);
                if (
                  stream !== null &&
                  identity.dev === replacementIdentity.dev &&
                  identity.ino === replacementIdentity.ino
                ) {
                  replacementEnumerated = true;
                  replacementStreams.add(String(stream));
                }
                return stream;
              };
            }
            if (property === "readdir") {
              return (stream) => {
                descriptorEnumerationCalls += 1;
                if (replacementStreams.has(String(stream))) replacementEnumerated = true;
                return symbol(stream);
              };
            }
            return symbol;
          }
        });
        return new Proxy(library, {
          get(target, property) {
            return property === "symbols" ? wrappedSymbols : Reflect.get(target, property);
          }
        });
      }
    }));
    const { hashDirectory } = await import("./packages/core/src/domain/services/index.ts");
    await hashDirectory(${JSON.stringify(controlInput)});
    let errorName = null;
    let evidenceRef = null;
    try {
      await hashDirectory(${JSON.stringify(input)});
    } catch (error) {
      errorName = error?.name ?? null;
      evidenceRef = error?.evidenceRef ?? null;
    } finally {
      if (swapped) {
        await actual.rm(live, { force: true });
        await actual.rename(displaced, live);
      }
    }
    console.log(JSON.stringify({
      errorName,
      evidenceRef,
      replacementEnumerated,
      descriptorEnumerationCalls
    }));
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    cwd: resolve(import.meta.dir, "../../../../.."),
    stdout: "pipe",
    stderr: "pipe"
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ]);
  if (exitCode !== 0) {
    throw new Error(`Directory substitution probe failed with exit ${exitCode}: ${stderr.trim()}`);
  }
  return JSON.parse(stdout.trim());
}

async function runFileSubstitutionProbe(
  workspaceRoot: string,
  scope: "ancestor" | "leaf"
): Promise<
  Readonly<{
    errorName: string | null;
    evidenceRef: string | null;
    replacementRead: boolean;
    descriptorReadCalls: number;
  }>
> {
  const caseRoot = join(workspaceRoot, `file-swap-${scope}`);
  const ancestor = join(caseRoot, "ancestor");
  const target = join(ancestor, "target.bin");
  const displaced = scope === "ancestor" ? `${ancestor}-original` : `${target}-original`;
  const replacementDirectory = join(caseRoot, "replacement");
  const replacementLeaf = join(caseRoot, "replacement.bin");
  const control = join(caseRoot, "control.bin");
  await mkdir(ancestor, { recursive: true });
  await writeFile(target, "original bytes");
  await writeFile(control, "control bytes");
  if (scope === "ancestor") {
    await mkdir(replacementDirectory);
    await writeFile(join(replacementDirectory, "target.bin"), "replacement bytes");
  } else {
    await writeFile(replacementLeaf, "replacement bytes");
  }
  const input = hashInput(
    workspaceRoot,
    `file-swap-${scope}/ancestor/target.bin`,
    `hash.file-swap.${scope}`
  );
  const controlInput = hashInput(
    workspaceRoot,
    `file-swap-${scope}/control.bin`,
    `hash.file-swap.${scope}.control`
  );
  const script = `
    import { mock } from "bun:test";
    const actual = { ...await import("node:fs/promises") };
    const actualFs = { ...await import("node:fs") };
    const actualLstat = actual.lstat;
    const scope = ${JSON.stringify(scope)};
    const ancestor = ${JSON.stringify(ancestor)};
    const target = ${JSON.stringify(target)};
    const displaced = ${JSON.stringify(displaced)};
    const replacementDirectory = ${JSON.stringify(replacementDirectory)};
    const replacementLeaf = ${JSON.stringify(replacementLeaf)};
    const replacementPath = scope === "ancestor"
      ? ${JSON.stringify(join(replacementDirectory, "target.bin"))}
      : replacementLeaf;
    const replacementIdentity = await actual.stat(replacementPath, { bigint: true });
    let observations = 0;
    let swapped = false;
    let replacementRead = false;
    let descriptorReadCalls = 0;
    mock.module("node:fs/promises", () => ({
      ...actual,
      lstat: async (...args) => {
        const result = await actualLstat(...args);
        if (!swapped && String(args[0]) === target && ++observations === 4) {
          if (scope === "ancestor") {
            await actual.rename(ancestor, displaced);
            await actual.symlink(replacementDirectory, ancestor);
          } else {
            await actual.rename(target, displaced);
            await actual.rename(replacementLeaf, target);
          }
          swapped = true;
        }
        return result;
      }
    }));
    mock.module("node:fs", () => ({
      ...actualFs,
      read: (descriptor, ...args) => {
        descriptorReadCalls += 1;
        if (swapped) {
          const identity = actualFs.fstatSync(descriptor, { bigint: true });
          if (
            identity.dev === replacementIdentity.dev &&
            identity.ino === replacementIdentity.ino
          ) {
            replacementRead = true;
          }
        }
        return actualFs.read(descriptor, ...args);
      }
    }));
    const { hashFile } = await import("./packages/core/src/domain/services/index.ts");
    await hashFile(${JSON.stringify(controlInput)});
    let errorName = null;
    let evidenceRef = null;
    try {
      await hashFile(${JSON.stringify(input)});
    } catch (error) {
      errorName = error?.name ?? null;
      evidenceRef = error?.evidenceRef ?? null;
    } finally {
      if (swapped && scope === "ancestor") {
        await actual.rm(ancestor, { force: true });
        await actual.rename(displaced, ancestor);
      } else if (swapped) {
        await actual.rename(target, replacementLeaf);
        await actual.rename(displaced, target);
      }
    }
    console.log(JSON.stringify({ errorName, evidenceRef, replacementRead, descriptorReadCalls }));
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    cwd: resolve(import.meta.dir, "../../../../.."),
    stdout: "pipe",
    stderr: "pipe"
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ]);
  if (exitCode !== 0) {
    throw new Error(`File substitution probe failed with exit ${exitCode}: ${stderr.trim()}`);
  }
  return JSON.parse(stdout.trim());
}
