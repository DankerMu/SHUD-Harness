import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCheck, runCheckForTest } from "../lib/checker";
import type { DescriptorAdmissionHook } from "../lib/ingress";

export const contractsRoot = join(import.meta.dir, "..");
export const validSourcePath = join(contractsRoot, "fixtures", "valid", "source-input-record-paired-surrogate.json");
export const validIdentityPath = join(contractsRoot, "fixtures", "valid", "source-identity-projection-v1.json");
export const success = (kind: string) => `${JSON.stringify({
  schema_version: "shud.git-status-capability.contract-check-receipt.v1", status: "ok", input_kind: kind
})}\n`;
export const failure = (code: string) => `${JSON.stringify({
  schema_version: "shud.git-status-capability.contract-error.v1", status: "error", code
})}\n`;

export async function capture(args: string[]): Promise<{ exit: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const exit = await runCheck(args, { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } });
  return { exit, stdout, stderr };
}
export async function captureAfterAdmission(
  args: string[],
  afterAdmission: DescriptorAdmissionHook
): Promise<{ exit: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const exit = await runCheckForTest(
    args,
    { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } },
    afterAdmission
  );
  return { exit, stdout, stderr };
}
export async function withTemporaryFile(bytes: Uint8Array | string, action: (path: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "shud-source-contract-"));
  const path = join(root, "input.json");
  try {
    await writeFile(path, bytes);
    await action(path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function writePath(path: string, bytes: Uint8Array | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

export async function sourceText(): Promise<string> {
  return await readFile(validSourcePath, "utf8");
}
