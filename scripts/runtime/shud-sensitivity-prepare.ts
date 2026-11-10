import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { runGit } from "../../packages/dsh-shud-core/src/stack-lock/repository-revision.ts";
import { readShudInputFile } from "../../packages/dsh-shud-records/src/shud-input-file.ts";
import { requireFact } from "./shud-restart-evidence.ts";
import { regular } from "./shud-session-log.ts";
import { HASH_LIMIT, rawTreeMd5, sortedEntries, walk } from "./shud-tree-digest.ts";
import { BUFFER_LIMIT, within } from "./shud-web-driver.ts";

const ROOT = fs.realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
const MANAGED_ROOTS = ["tasks", "runs", "reports", "stacks", "provenance", "analyses"] as const;
const SUBMODULES = ["SHUD", "rSHUD", "AutoSHUD"] as const;

export interface SensitivityPrepareInput {
  workspace: string | undefined;
  recordPath: string | undefined;
  /** Harness root holding the three submodules; defaults to this repository. */
  root?: string;
  env?: NodeJS.ProcessEnv;
  /** Total source byte budget; defaults to the replay HASH_LIMIT. */
  hashBudget?: number;
  /** Copy writer; must create exclusively. */
  writeFile?: (path: string, bytes: Buffer) => void;
}

const hex = (length: number) => z.string().regex(new RegExp(`^[0-9a-f]{${length}}$`, "u"));
const fileHashes = (length: number) => z.record(z.string().min(1), hex(length));
/** Writer (this module) and reader (the offline evaluator) share this one definition. */
export const SensitivityPreparationRecordSchema = z.strictObject({
  workspace: z.string().refine(isAbsolute),
  source: z.string().refine(isAbsolute),
  source_md5: fileHashes(32),
  source_sha256: fileHashes(64),
  copy_sha256: fileHashes(64),
  submodules: z.strictObject({ SHUD: hex(40), rSHUD: hex(40), AutoSHUD: hex(40) }),
  raw: z.strictObject({
    exists: z.boolean(),
    md5: fileHashes(32),
    roots: z.strictObject({ harness: z.boolean(), workspace: z.boolean() }),
  }),
});
export type SensitivityPreparationRecord = z.infer<typeof SensitivityPreparationRecordSchema>;

interface InventoryEntry {
  relative: string;
  bytes: Buffer;
  sha256: string;
}

function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : "error";
}

/** Only ENOENT means absent; every other inspection error fails naming the path. */
function inspect(path: string): fs.Stats | null {
  try {
    return fs.lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw new Error(`Cannot inspect ${path}: ${errorCode(error)}`, { cause: error });
  }
}

/**
 * Every regular file under a physical directory, read once through the records safe read
 * in code-unit order. Symlinks and special files fail naming the entry; the lstat size is
 * charged against the byte budget before each read.
 */
function inventory(directory: string, budget: { remaining: number }): InventoryEntry[] {
  const paths: string[] = [];
  walk(directory, (path) => paths.push(path), { remaining: BUFFER_LIMIT });
  return paths.sort().map((path) => {
    const size = fs.lstatSync(path).size;
    requireFact(size <= budget.remaining, `Hash byte budget exceeded: ${path}`);
    budget.remaining -= size;
    const name = relative(directory, path).split(sep).join("/");
    const read = readShudInputFile(directory, name);
    return { relative: name, bytes: read.bytes, sha256: read.sha256 };
  });
}

/** Per-file sha256 of a physical ccw tree keyed by POSIX relative path (criterion 12 receipts). */
export function ccwSha256(directory: string): Record<string, string> {
  const entries = inventory(directory, { remaining: HASH_LIMIT });
  return sortedEntries(Object.fromEntries(entries.map((entry) => [entry.relative, entry.sha256])));
}

function prerequisites(input: SensitivityPrepareInput, env: NodeJS.ProcessEnv, root: string) {
  const { workspace, recordPath } = input;
  requireFact(typeof workspace === "string" && workspace.trim(), "Missing workspace argument");
  requireFact(typeof recordPath === "string" && recordPath.trim(), "Missing record path argument");
  const shudBin = env.SHUD_BIN;
  requireFact(shudBin, "Missing SHUD_BIN");
  requireFact(isAbsolute(shudBin), `SHUD_BIN must be absolute: ${shudBin}`);
  try {
    requireFact(fs.lstatSync(shudBin).isFile(), "not regular");
    regular(fs.realpathSync(shudBin), "SHUD_BIN");
    fs.accessSync(shudBin, fs.constants.X_OK);
  } catch (error) {
    throw new Error(`SHUD_BIN must be an executable regular file: ${shudBin}`, { cause: error });
  }
  requireFact(env.DMXAPI_KEY?.trim(), "Missing DMXAPI_KEY");
  const source = join(root, "SHUD/input/ccw");
  const stat = inspect(source);
  requireFact(
    stat?.isDirectory() && fs.realpathSync(source) === source,
    `Missing SHUD/input/ccw source directory: ${source}`,
  );
  return { workspace: resolve(workspace), recordPath: resolve(recordPath), source };
}

/**
 * Final component ordinary; outer ancestors may be aliases (macOS /var -> /private/var). The
 * native realpath also folds a case-alias spelling, as `analysis_create` resolves `input_dir`.
 */
function physicalWorkspace(requested: string): string {
  requireFact(requested !== sep, "Unsafe root workspace");
  const own = inspect(requested);
  if (own) {
    requireFact(!own.isSymbolicLink(), `Workspace must not be a symlink: ${requested}`);
    requireFact(own.isDirectory(), `Workspace must be a directory: ${requested}`);
    return fs.realpathSync.native(requested);
  }
  let ancestor = dirname(requested);
  while (!inspect(ancestor)) ancestor = dirname(ancestor);
  requireFact(
    fs.statSync(ancestor).isDirectory(),
    `Workspace ancestor must be a directory: ${ancestor}`,
  );
  return join(fs.realpathSync.native(ancestor), requested.slice(ancestor.length));
}

/** `<ws>/input`, when present, must be an ordinary directory at its own physical path. */
function requireRealInput(workspace: string): void {
  const workspaceInput = join(workspace, "input");
  const stat = inspect(workspaceInput);
  requireFact(
    !stat ||
      (stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        fs.realpathSync(workspaceInput) === workspaceInput),
    `Workspace input must be a real directory: ${workspaceInput}`,
  );
}

function physicalRecord(path: string, workspace: string, root: string): string {
  const parent = dirname(path);
  requireFact(
    inspect(parent)?.isDirectory(),
    `Record parent must be an existing directory: ${path}`,
  );
  const record = join(fs.realpathSync(parent), basename(path));
  requireFact(!inspect(record), `Record path already exists: ${path}`);
  requireFact(
    record !== workspace &&
      !["input", ...MANAGED_ROOTS].some((name) => within(join(workspace, name), record)),
    `Record path must be outside workspace input and managed roots: ${path}`,
  );
  requireFact(
    ![root, workspace].some((base) => within(join(base, "data/raw"), record)),
    `Record path must be outside harness and workspace data/raw: ${path}`,
  );
  return record;
}

export async function submoduleHead(root: string, name: string): Promise<string> {
  const repository = join(root, name);
  let lines: string[];
  try {
    const output = await runGit(repository, ["rev-parse", "--show-toplevel", "HEAD"], {
      maxBuffer: BUFFER_LIMIT,
    });
    lines = output.stdout.toString("utf8").trim().split("\n");
  } catch (error) {
    throw new Error(`Cannot read submodule ${name} HEAD: ${repository}`, { cause: error });
  }
  requireFact(
    lines.length === 2 &&
      lines[0] === fs.realpathSync(repository) &&
      /^[0-9a-f]{40}$/u.test(lines[1]),
    `Cannot read submodule ${name} HEAD: ${repository}`,
  );
  return lines[1];
}

function exclusiveWrite(path: string, bytes: Buffer): void {
  fs.writeFileSync(path, bytes, { flag: "wx" });
}

/**
 * Prepare a sensitivity scratch workspace (design "Issue #669 ... contract" steps 1-7).
 * Nothing is written before every check and the source inventory succeed; a record
 * exists only when the copy is complete and verified. Copies already written before a
 * later failure are left in place.
 */
export async function prepareSensitivityWorkspace(
  input: SensitivityPrepareInput,
): Promise<SensitivityPreparationRecord> {
  const root = input.root ?? ROOT;
  const checked = prerequisites(input, input.env ?? process.env, root);
  const workspace = physicalWorkspace(checked.workspace);
  const physicalRoot = fs.realpathSync(root);
  requireFact(
    !within(physicalRoot, workspace),
    `Workspace must be outside the harness root: ${checked.workspace}`,
  );
  if (inspect(workspace)) requireRealInput(workspace);
  const recordPath = physicalRecord(checked.recordPath, workspace, physicalRoot);
  for (const name of [...MANAGED_ROOTS, "input/ccw"]) {
    const path = join(workspace, name);
    requireFact(!inspect(path), `Occupied workspace path: ${path}; never overwritten`);
  }

  const budget = { remaining: input.hashBudget ?? HASH_LIMIT };
  const entries = inventory(checked.source, budget);
  const submodules = {} as SensitivityPreparationRecord["submodules"];
  for (const name of SUBMODULES) submodules[name] = await submoduleHead(root, name);
  const raw = rawTreeMd5(root, workspace, budget);

  const copy = join(workspace, "input/ccw");
  fs.mkdirSync(join(workspace, "input"), { recursive: true });
  requireFact(fs.realpathSync(workspace) === workspace, `Workspace changed: ${workspace}`);
  requireRealInput(workspace);
  fs.mkdirSync(copy);
  const write = input.writeFile ?? exclusiveWrite;
  for (const entry of entries) {
    const path = join(copy, entry.relative);
    fs.mkdirSync(dirname(path), { recursive: true });
    try {
      write(path, entry.bytes);
    } catch (error) {
      throw new Error(`Copy write failed: ${path}: ${errorCode(error)}`, { cause: error });
    }
  }
  const copySha256 = ccwSha256(copy);
  for (const entry of entries)
    requireFact(
      copySha256[entry.relative] === entry.sha256,
      `Copy verification failed: ${join(copy, entry.relative)}`,
    );
  requireFact(
    Object.keys(copySha256).length === entries.length,
    `Copy verification failed: ${copy}`,
  );

  const record: SensitivityPreparationRecord = {
    workspace,
    source: checked.source,
    source_md5: sortedEntries(
      Object.fromEntries(
        entries.map((entry) => [
          entry.relative,
          createHash("md5").update(entry.bytes).digest("hex"),
        ]),
      ),
    ),
    source_sha256: sortedEntries(
      Object.fromEntries(entries.map((entry) => [entry.relative, entry.sha256])),
    ),
    copy_sha256: copySha256,
    submodules,
    raw,
  };
  try {
    fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    throw new Error(`Record write failed: ${recordPath}: ${errorCode(error)}`, { cause: error });
  }
  return record;
}

/** Thin CLI: `<workspace> <record-path>`; every failure is stderr naming the item and exit 1. */
export async function runSensitivityPrepareCli(
  argv: string[],
  options: { root?: string } = {},
): Promise<number> {
  try {
    requireFact(argv.length <= 2, "usage: shud-sensitivity-prepare.ts <workspace> <record-path>");
    const record = await prepareSensitivityWorkspace({
      workspace: argv[0],
      recordPath: argv[1],
      root: options.root,
    });
    process.stdout.write(
      `shud:sensitivity: prepared ${join(record.workspace, "input/ccw")}; record ${resolve(argv[1])}\n`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Preparation failed";
    process.stderr.write(`shud:sensitivity: ${message}\n`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runSensitivityPrepareCli(process.argv.slice(2));
}
