import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { LocalTokenTestStage } from "./local-token-test-support";

const execFileAsync = promisify(execFile);

export interface LocalTokenTestWorkspace {
  readonly tempRoot: string;
  readonly workspaceRoot: string;
  readonly secretsRoot: string;
}

export interface ExternalSecretsMutationLease {
  release(): Promise<void>;
}

export function createLocalTokenTestWorkspace(): LocalTokenTestWorkspace {
  const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "shud-local-token-store-")));
  const workspaceRoot = join(tempRoot, "workspace");
  const secretsRoot = join(workspaceRoot, "secrets");
  mkdirSync(workspaceRoot, { mode: 0o700 });
  return Object.freeze({ tempRoot, workspaceRoot, secretsRoot });
}

export function createPrivateSecrets(workspace: LocalTokenTestWorkspace): void {
  mkdirSync(workspace.secretsRoot, { mode: 0o700 });
  chmodSync(workspace.secretsRoot, 0o700);
}

export function cleanupLocalTokenTestWorkspace(workspace: LocalTokenTestWorkspace): void {
  rmSync(workspace.tempRoot, { recursive: true, force: true });
}

export function replaceLocalTokenArtifact(
  secretsRoot: string,
  name: string,
  bytes: string
): BigIntStats {
  const path = join(secretsRoot, name);
  const displaced = join(secretsRoot, `${name}.displaced`);
  renameSync(path, displaced);
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  unlinkSync(displaced);
  return lstatSync(path, { bigint: true });
}

export function transactionNames(secretsRoot: string): string[] {
  return readdirSync(secretsRoot).filter((name) =>
    name.startsWith(".local-token-")
  );
}

export function descriptorInventory(): string[] {
  return readdirSync("/dev/fd").sort();
}

export async function interruptLocalTokenStore(
  workspaceRoot: string,
  killStage: LocalTokenTestStage,
  faultStage?: LocalTokenTestStage
): Promise<void> {
  const storeUrl = new URL("./local-token-store.ts", import.meta.url).href;
  const supportUrl = new URL("./local-token-test-support.ts", import.meta.url).href;
  const script = [
    `import { openWorkspaceLocalTokenAuthority } from ${JSON.stringify(storeUrl)};`,
    `import { runWithLocalTokenStoreTestContext } from ${JSON.stringify(supportUrl)};`,
    `const killStage = ${JSON.stringify(killStage)};`,
    `const faultStage = ${JSON.stringify(faultStage)};`,
    "runWithLocalTokenStoreTestContext({ hook: ({ stage }) => {",
    '  if (stage === faultStage) throw new Error("fixture fault");',
    '  if (stage === killStage) process.kill(process.pid, "SIGKILL");',
    `}}, () => openWorkspaceLocalTokenAuthority({ workspaceRoot: ${JSON.stringify(workspaceRoot)} }));`
  ].join("\n");
  let signal: unknown;
  try {
    await execFileAsync(process.execPath, ["-e", script], { timeout: 2_000 });
  } catch (error) {
    signal = typeof error === "object" && error !== null
      ? Reflect.get(error, "signal")
      : undefined;
  }
  if (signal !== "SIGKILL") {
    throw new Error(`Expected SIGKILL fixture, received ${String(signal)}`);
  }
}

function waitForChildOutput(
  child: ChildProcessWithoutNullStreams,
  expected: string
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error(`Timed out waiting for child output: ${expected}`));
    }, 2_000);
    let output = "";
    const onData = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      if (!output.includes(expected)) return;
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      resolvePromise();
    };
    child.stdout.on("data", onData);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.once("exit", (code, signal) => {
      if (output.includes(expected)) return;
      clearTimeout(timeout);
      rejectPromise(new Error(`Lease child exited early: ${String(code)}/${String(signal)}`));
    });
  });
}

export async function holdSecretsMutationLeaseInSubprocess(
  workspace: LocalTokenTestWorkspace
): Promise<ExternalSecretsMutationLease> {
  const syscallsUrl = new URL("./local-token-syscalls.ts", import.meta.url).href;
  const typesUrl = new URL("./local-token-types.ts", import.meta.url).href;
  const script = [
    'import { closeSync, openSync } from "node:fs";',
    `import { flockNonblocking } from ${JSON.stringify(syscallsUrl)};`,
    `import { DIRECTORY_OPEN_FLAGS, FLOCK_EXCLUSIVE, FLOCK_NONBLOCKING, FLOCK_UNLOCK } from ${JSON.stringify(typesUrl)};`,
    `const descriptor = openSync(${JSON.stringify(workspace.secretsRoot)}, DIRECTORY_OPEN_FLAGS);`,
    "if (flockNonblocking(descriptor, FLOCK_EXCLUSIVE | FLOCK_NONBLOCKING) !== 0) process.exit(2);",
    'process.stdout.write("locked\\n");',
    "process.stdin.resume();",
    "process.stdin.once('data', () => {",
    "  const unlocked = flockNonblocking(descriptor, FLOCK_UNLOCK) === 0;",
    "  closeSync(descriptor);",
    "  process.exit(unlocked ? 0 : 3);",
    "});"
  ].join("\n");
  const child = spawn(process.execPath, ["-e", script], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  await waitForChildOutput(child, "locked\n");
  let released = false;
  return Object.freeze({
    async release(): Promise<void> {
      if (released) throw new Error("External secrets mutation lease already released.");
      released = true;
      const exited = new Promise<void>((resolvePromise, rejectPromise) => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          rejectPromise(new Error("Timed out releasing external secrets mutation lease."));
        }, 2_000);
        child.once("exit", (code, signal) => {
          clearTimeout(timeout);
          if (code === 0 && signal === null) resolvePromise();
          else rejectPromise(new Error(`Lease child release failed: ${String(code)}/${String(signal)}`));
        });
      });
      child.stdin.write("release\n");
      await exited;
    }
  });
}

export async function openAuthorityInSubprocess(
  workspaceRoot: string
): Promise<"blocked" | "success"> {
  const storeUrl = new URL("./local-token-store.ts", import.meta.url).href;
  const script = [
    `import { LocalTokenStorageError, openWorkspaceLocalTokenAuthority } from ${JSON.stringify(storeUrl)};`,
    "try {",
    `  openWorkspaceLocalTokenAuthority({ workspaceRoot: ${JSON.stringify(workspaceRoot)} });`,
    '  process.stdout.write("success");',
    "} catch (error) {",
    '  if (!(error instanceof LocalTokenStorageError)) throw error;',
    '  process.stdout.write("blocked");',
    "}"
  ].join("\n");
  const result = await execFileAsync(process.execPath, ["-e", script], {
    timeout: 2_000
  });
  const output = result.stdout.trim();
  if (output !== "blocked" && output !== "success") {
    throw new Error(`Unexpected local-token subprocess result: ${output}`);
  }
  return output;
}

export function readCanonicalBytes(workspace: LocalTokenTestWorkspace): Buffer {
  return readFileSync(join(workspace.secretsRoot, "local-token"));
}
