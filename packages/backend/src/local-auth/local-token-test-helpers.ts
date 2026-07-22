import { execFile } from "node:child_process";
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

export function readCanonicalBytes(workspace: LocalTokenTestWorkspace): Buffer {
  return readFileSync(join(workspace.secretsRoot, "local-token"));
}
