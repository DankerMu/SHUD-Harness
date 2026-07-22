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
  symlink,
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
import { runWithHashingServiceHooksForTest } from "./hashing-service";

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const DIRECTORY_ORACLE = "abeb7f0f89055fff57ff5fdec6e07f6b397071d82f6b11e52d068bef7951bb0d";
const tempRoots: string[] = [];
const socketServers: Server[] = [];

describe("hashing service", () => {
  afterEach(async () => {
    await Promise.all(socketServers.splice(0).map(closeServer));
    await Promise.all(
      tempRoots.splice(0).map((tempRoot) => rm(tempRoot, { recursive: true, force: true }))
    );
  });

  test("services barrel exposes the fixed public API but keeps test hooks private", async () => {
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

  test("enumeration-time directory replacement is rejected without following the replacement", async () => {
    const { workspaceRoot } = await createWorkspace();
    const dataset = join(workspaceRoot, "dataset");
    const nested = join(dataset, "nested");
    const displaced = join(dataset, "nested-original");
    const replacement = join(workspaceRoot, "replacement");
    await mkdir(nested, { recursive: true });
    await mkdir(replacement);
    await writeFile(join(nested, "evidence.txt"), "original");
    await writeFile(join(replacement, "evidence.txt"), "replacement must not be read");

    await expectPathSafety(
      () =>
        runWithHashingServiceHooksForTest(
          {
            afterDirectoryEnumeration: async () => {
              await rename(nested, displaced);
              await symlink(replacement, nested);
            }
          },
          () => hashDirectory(hashInput(workspaceRoot, "dataset", "hash.race.enumeration"))
        ),
      "hash.race.enumeration"
    );
    expect(await readFile(join(replacement, "evidence.txt"), "utf8")).toBe(
      "replacement must not be read"
    );
  });

  test("open-window regular-file replacement fails pre-open identity binding", async () => {
    const { workspaceRoot } = await createWorkspace();
    const target = join(workspaceRoot, "target.bin");
    const displaced = join(workspaceRoot, "target-original.bin");
    await writeFile(target, "original bytes");
    let replaced = false;

    await expectPathSafety(
      () =>
        runWithHashingServiceHooksForTest(
          {
            beforeFileOpen: async ({ absolutePath }) => {
              if (replaced || absolutePath !== target) return;
              replaced = true;
              await rename(target, displaced);
              await writeFile(target, "replacement bytes");
            }
          },
          () => hashFile(hashInput(workspaceRoot, "target.bin", "hash.race.open"))
        ),
      "hash.race.open"
    );
  });
});

function hashInput(
  workspaceRoot: string,
  inputPath: string,
  evidenceRef: string
): HashingServiceInput {
  return { workspaceRoot, inputPath, evidenceRef };
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
