import * as fs from "node:fs";
import { isAbsolute, join } from "node:path";
import { release, type } from "node:os";
import {
  collectRepositoryRevision,
  computeStackFingerprint,
  createBrandedId,
  StackIdSchema,
  StackLockSchema,
  type StackId,
  type StackLock,
} from "@shud-harness/dsh-shud-core";
import manifest from "../../../package.json" with { type: "json" };
import { ensureDirectory, regularTarget } from "./workspace-paths.ts";
import { readWorkspaceRecord } from "./workspace-records.ts";

/** Trusted session root and explicit capture settings; no process-cwd or repository fallback. */
export interface StackCaptureConfig {
  cwd: string;
  stackRepos: { SHUD: string; rSHUD: string; AutoSHUD: string };
  hostVersion: string;
  sundialsRoot?: string;
  llm: { base_url: string; request_alias: string };
}

/** Structurally accepts RunJob model metadata without copying its source or credentials. */
export interface StackCaptureLlm {
  response_model: string;
}

type Environment = Omit<StackLock, "stack_id" | "fingerprint">;
const candidateSchema = StackLockSchema.omit({ fingerprint: true });
const harnessVersion = manifest.version;

// Do not attach raw IO/Git/schema errors as causes: callers can expose the entire error object.
class StackCaptureError extends Error {
  constructor(stage: string, path?: string) {
    super(`Stack capture ${stage} failed${path === undefined ? "" : `: ${path}`}`);
    this.name = "StackCaptureError";
  }
}

function requireText(value: unknown, key: string, absolute = false): void {
  if (typeof value !== "string" || value.length === 0 || (absolute && !isAbsolute(value))) {
    throw new StackCaptureError(`configuration ${key}`);
  }
}

function validateConfig(config: StackCaptureConfig, llm: StackCaptureLlm): void {
  requireText(config?.cwd, "cwd", true);
  for (const name of ["SHUD", "rSHUD", "AutoSHUD"] as const) {
    requireText(config?.stackRepos?.[name], `stackRepos.${name}`, true);
  }
  requireText(config?.hostVersion, "hostVersion");
  requireText(config?.llm?.base_url, "llm.base_url");
  requireText(config?.llm?.request_alias, "llm.request_alias");
  requireText(llm?.response_model, "response_model");
  if (config.sundialsRoot !== undefined) requireText(config.sundialsRoot, "sundialsRoot", true);
}

function repository(path: string): StackLock["repos"]["SHUD"] {
  try {
    return collectRepositoryRevision(path);
  } catch {
    throw new StackCaptureError("repository", path);
  }
}

function sundialsVersion(root: string | undefined): string | null {
  if (root === undefined) return null;
  const path = join(root, "include", "sundials", "sundials_config.h");
  let header: string;
  try {
    header = fs.readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw new StackCaptureError("SUNDIALS read", path);
  }
  const version =
    /^[\t ]*#[\t ]*define[\t ]+SUNDIALS_VERSION[\t ]+"([^"\r\n]+)"[\t ]*(?:\/\/[^\r\n]*|\/\*[^\r\n]*\*\/[\t ]*)?\r?$/mu.exec(
      header,
    )?.[1];
  if (version === undefined) throw new StackCaptureError("SUNDIALS version", path);
  return version;
}

function fingerprint(environment: Environment, id: StackId): string {
  const parsed = candidateSchema.safeParse({ ...environment, stack_id: id });
  if (!parsed.success) throw new StackCaptureError("candidate schema");
  return computeStackFingerprint(parsed.data);
}

function lockDirectory(cwd: string): string {
  const directory = join(cwd, "stacks");
  try {
    ensureDirectory(directory, "Stack capture");
  } catch {
    throw new StackCaptureError("directory", directory);
  }
  return directory;
}

function matchingLock(
  cwd: string,
  directory: string,
  environment: Environment,
): { selected: StackLock | undefined; digest: string | undefined } {
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch {
    throw new StackCaptureError("enumeration", directory);
  }
  let selected: StackLock | undefined;
  let digest: string | undefined;
  for (const name of names) {
    const parsedId = StackIdSchema.safeParse(
      name.endsWith(".json") ? name.slice(0, -5) : undefined,
    );
    if (!parsedId.success) throw new StackCaptureError("filename", directory);
    const id = parsedId.data;
    const path = join(directory, `${id}.json`);
    const existing = readWorkspaceRecord(cwd, "stack", id);
    if (existing.stack_id !== id) throw new StackCaptureError("identity", path);
    // The helper requires real identity metadata even though identity is excluded from its hash.
    // Reuse an existing id for comparison only; matching captures never allocate another id.
    digest ??= fingerprint(environment, id);
    if (existing.fingerprint === digest && (selected === undefined || id < selected.stack_id)) {
      selected = existing;
    }
  }
  return { selected, digest };
}

/** Return false only for a genuine open-time EEXIST; never own or remove a colliding file. */
function createLock(path: string, lock: StackLock): boolean {
  try {
    regularTarget(path, "Stack capture");
  } catch {
    throw new StackCaptureError("target", path);
  }
  let fd: number;
  try {
    fd = fs.openSync(path, "wx", 0o600);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
    throw new StackCaptureError("open", path);
  }
  let stage = "write";
  try {
    fs.writeFileSync(fd, `${JSON.stringify(lock)}\n`, "utf8");
    stage = "flush";
    fs.fsyncSync(fd);
    stage = "close";
    fs.closeSync(fd);
  } catch {
    const primary = new StackCaptureError(stage, path);
    const failures: Error[] = [primary];
    try {
      fs.closeSync(fd);
    } catch {
      failures.push(new StackCaptureError("cleanup close", path));
    }
    try {
      fs.rmSync(path);
    } catch {
      failures.push(new StackCaptureError("cleanup remove", path));
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, `Stack capture cleanup failed: ${path}`, {
        cause: primary,
      });
    }
    throw primary;
  }
  return true;
}

/**
 * Capture configured repositories and runtime, reusing the smallest matching immutable lock.
 * Every existing entry is validated before reuse. Fingerprints describe revision metadata,
 * not dirty-file contents; reused locks retain their original response model and timestamps.
 * New locks use private exclusive creation, with at most three id attempts. Failed writes
 * clean up only their owned output; this is not crash-atomic or cross-process snapshot isolation.
 */
export function captureStackLock(config: StackCaptureConfig, llm: StackCaptureLlm): StackLock {
  validateConfig(config, llm);
  const environment: Environment = {
    repos: {
      SHUD: repository(config.stackRepos.SHUD),
      rSHUD: repository(config.stackRepos.rSHUD),
      AutoSHUD: repository(config.stackRepos.AutoSHUD),
    },
    runtime: {
      os: `${type()} ${release()}`,
      sundials_version: sundialsVersion(config.sundialsRoot),
      host_version: config.hostVersion,
    },
    harness: { version: harnessVersion },
    llm: {
      base_url: config.llm.base_url,
      request_alias: config.llm.request_alias,
      response_model: llm.response_model,
    },
    created_at: new Date().toISOString(),
  };
  const directory = lockDirectory(config.cwd);
  const { selected, digest } = matchingLock(config.cwd, directory, environment);
  if (selected !== undefined) return selected;
  const id = createBrandedId("STACK");
  const parsed = StackLockSchema.safeParse({
    ...environment,
    stack_id: id,
    fingerprint: digest ?? fingerprint(environment, id),
  });
  if (!parsed.success) throw new StackCaptureError("candidate schema");
  let lock = parsed.data;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (createLock(join(directory, `${lock.stack_id}.json`), lock)) return lock;
    if (attempt < 2) lock = { ...lock, stack_id: createBrandedId("STACK") };
  }
  throw new StackCaptureError("id collision", directory);
}
