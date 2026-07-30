import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCheck, runCheckForTest } from "../lib/checker";
import type { DescriptorIngressHooks } from "../lib/ingress";

export const contractsRoot = join(import.meta.dir, "..");
export const validSourcePath = join(contractsRoot, "fixtures", "valid", "source-input-record-paired-surrogate.json");
export const validIdentityPath = join(contractsRoot, "fixtures", "valid", "source-identity-projection-v1.json");
export const checkPath = join(contractsRoot, "check.ts");

export const success = (kind: string) => `${JSON.stringify({
  schema_version: "shud.git-status-capability.contract-check-receipt.v1", status: "ok", input_kind: kind
})}\n`;
export const failure = (code: string) => `${JSON.stringify({
  schema_version: "shud.git-status-capability.contract-error.v1", status: "error", code
})}\n`;

export async function capture(args: string[], hooks?: DescriptorIngressHooks): Promise<{
  exit: number; stdout: string; stderr: string;
}> {
  let stdout = "";
  let stderr = "";
  const io = { stdout: (text: string) => { stdout += text; }, stderr: (text: string) => { stderr += text; } };
  const exit = hooks ? await runCheckForTest(args, io, hooks) : await runCheck(args, io);
  return { exit, stdout, stderr };
}

export async function directCommand(args: string[]): Promise<{ exit: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, checkPath, ...args], { stdout: "pipe", stderr: "pipe" });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ]);
  return { exit, stdout, stderr };
}

export async function withTemporaryFile(
  bytes: Uint8Array | string,
  action: (path: string, root: string) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "shud-source-contract-"));
  const path = join(root, "input.json");
  try {
    await writeFile(path, bytes);
    await action(path, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function sourceRecord(): Promise<Record<string, any>> {
  return JSON.parse(await readFile(validSourcePath, "utf8"));
}

export function recordWithEntries(count: number): Record<string, any> {
  const value = structuredClone(cachedSourceRecord);
  value.entry_count = count;
  value.admitted_paths = Array.from({ length: count }, (_, index) => `f${index.toString().padStart(3, "0")}`);
  value.admitted_modes = Array.from({ length: count }, () => "100644");
  value.primary_result.entry_count = count;
  value.witness_result.entry_count = count;
  return value;
}

const cachedSourceRecord = JSON.parse(await readFile(validSourcePath, "utf8"));

export function countedItems(value: unknown): number {
  if (Array.isArray(value)) return value.length + value.reduce((total, child) => total + countedItems(child), 0);
  if (typeof value === "object" && value !== null) {
    return Object.keys(value).length + Object.values(value).reduce((total, child) => total + countedItems(child), 0);
  }
  return 0;
}

export async function descriptorCount(): Promise<number> {
  const descriptorDirectory = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
  return (await readdir(descriptorDirectory)).length;
}
