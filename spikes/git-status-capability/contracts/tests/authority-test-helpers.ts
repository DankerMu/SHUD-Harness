import { expect } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { runCheck } from "../lib/checker";

export const repositoryRoot = join(import.meta.dir, "..", "..", "..", "..");
export const fixturesRoot = join(import.meta.dir, "..", "fixtures");
export const authorityFixture = join(fixturesRoot, "valid", "authority-set-v1.json");
export const successReceipt = (kind: string) =>
  `{"schema_version":"shud.git-status-capability.contract-check-receipt.v1","status":"ok","input_kind":"${kind}"}\n`;
export const errorReceipt = (code: string) =>
  `{"schema_version":"shud.git-status-capability.contract-error.v1","status":"error","code":"${code}"}\n`;

export async function loadAuthority(): Promise<Record<string, any>> {
  return JSON.parse(await readFile(authorityFixture, "utf8"));
}

export async function invoke(args: string[]): Promise<{ exit: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const exit = await runCheck(args, {
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; }
  });
  return { exit, stdout, stderr };
}

export async function invokeAuthority(path = authorityFixture, root = repositoryRoot) {
  return invoke(["--input", path, "--kind", "authority_set", "--repository-root", root]);
}

export function expectSuccess(result: { exit: number; stdout: string; stderr: string }, kind: string): void {
  expect(result).toEqual({ exit: 0, stdout: successReceipt(kind), stderr: "" });
}

export function expectSchemaFailure(result: { exit: number; stdout: string; stderr: string }): void {
  expect(result).toEqual({ exit: 2, stdout: "", stderr: errorReceipt("CONTRACT_SCHEMA_INVALID") });
}

export async function withJson(value: unknown, run: (path: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(realpathSync(tmpdir()), "shud-authority-test-"));
  try {
    const path = join(root, "input.json");
    await writeFile(path, JSON.stringify(value));
    await run(path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function expectMutationRejected(mutate: (value: Record<string, any>) => void): Promise<void> {
  expectSuccess(await invokeAuthority(), "authority_set");
  const value = await loadAuthority();
  mutate(value);
  await withJson(value, async (path) => {
    const first = await invokeAuthority(path);
    const second = await invokeAuthority(path);
    expectSchemaFailure(first);
    expect(second).toEqual(first);
  });
}
