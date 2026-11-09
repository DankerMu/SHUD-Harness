import { constants, lstatSync, readdirSync, realpathSync, type Stats } from "node:fs";
import * as io from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  AnalysisPlanSchema,
  BuildIdSchema,
  CALIB_WHITELIST,
  containsPath,
  isProjectComponent,
  RunJobSchema,
  TaskIdSchema,
  type BuildId,
  type RunJob,
  type TaskId,
} from "@shud-harness/dsh-shud-core";
import { readShudInputFile } from "@shud-harness/dsh-shud-records";

interface CalibOverride {
  key: keyof typeof CALIB_WHITELIST;
  multiplier: number;
}

export interface SubmitShudRequest {
  cwd: string;
  input_dir: string;
  project: string;
  task_id?: TaskId;
  /** Execute a verified run-local copy of this workspace build; never fall back on failure. */
  build_id?: BuildId;
  /** Independent positive safe integer; omitted threads inherit the host environment. */
  threads?: number;
  end_days?: RunJob["end_days"];
  label?: RunJob["label"];
  owner_session: RunJob["owner_session"];
  llm: RunJob["llm"];
  // Internal plan binding, never model-visible; shud_run resolves a plan into these fields.
  analysis_plan_id?: RunJob["analysis_plan_id"];
  parameter_set_id?: RunJob["parameter_set_id"];
  /** Empty or exactly one already-resolved whitelist key and multiplier. */
  calib_overrides?: CalibOverride[];
  /** Plan-checked sha256 of baseline input files, keyed by POSIX path relative to input_dir. */
  input_digests?: Record<string, string> | null;
}

export interface PlanBinding {
  analysisPlanId: RunJob["analysis_plan_id"];
  parameterSetId: RunJob["parameter_set_id"];
  calibOverride: CalibOverride | null;
  inputDigests: Record<string, string> | null;
}

interface InputItem {
  relative: string;
  directory: boolean;
}

export interface PreparedInput {
  cwd: string;
  inputDir: string;
  runsDir: string;
  project: string;
  taskId: TaskId | null;
  buildId: BuildId | null;
  threads: number | null;
  plan: PlanBinding;
  endDays: RunJob["end_days"];
  label: RunJob["label"];
  ownerSession: RunJob["owner_session"];
  llm: RunJob["llm"];
  items: InputItem[];
}

export function existingPath(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export function realDirectory(path: string): Stats {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error(`Expected a real directory, not a symlink: ${path}`);
  return stat;
}

/** Pure validation of the internal plan fields; it runs before any filesystem operation. */
function planBinding(request: SubmitShudRequest, threads: number | null): PlanBinding {
  const plan = RunJobSchema.shape.analysis_plan_id.safeParse(request.analysis_plan_id ?? null);
  if (!plan.success) throw new Error("analysis_plan_id must be a valid AnalysisPlanId or null");
  const set = RunJobSchema.shape.parameter_set_id.safeParse(request.parameter_set_id ?? null);
  if (!set.success) throw new Error("parameter_set_id must be PSET-1..PSET-5 or null");
  if ((plan.data === null) !== (set.data === null))
    throw new Error("analysis_plan_id and parameter_set_id must both be set or both be null");
  const bound = plan.data !== null;
  const overrides: unknown = request.calib_overrides ?? [];
  if (!Array.isArray(overrides) || overrides.length > 1)
    throw new Error("calib_overrides must be an array of at most one override");
  let calibOverride: CalibOverride | null = null;
  if (overrides.length === 1) {
    const [entry] = overrides as unknown[];
    const fields = typeof entry === "object" && entry !== null ? Object.keys(entry) : [];
    const { key, multiplier } = (entry ?? {}) as Partial<CalibOverride>;
    // The plan schema owns the whitelist and the [0.5, 2], != 1 multiplier rule.
    const changes = AnalysisPlanSchema.shape.parameter_sets.element.shape.changes;
    if (
      fields.length !== 2 ||
      typeof key !== "string" ||
      !Object.hasOwn(CALIB_WHITELIST, key) ||
      !changes.safeParse({ [key]: multiplier }).success
    )
      throw new Error("calib_overrides entry must be a whitelisted key with a valid multiplier");
    if (!bound) throw new Error("calib_overrides require analysis_plan_id and parameter_set_id");
    calibOverride = { key, multiplier: multiplier as number };
  }
  const digests: unknown = request.input_digests ?? null;
  if (!bound) {
    if (digests !== null) throw new Error("input_digests must be null without a plan binding");
    return { analysisPlanId: null, parameterSetId: null, calibOverride, inputDigests: null };
  }
  if (threads === null) throw new Error("threads is required for a plan-bound submission");
  const parsed = AnalysisPlanSchema.shape.input_digests.safeParse(digests);
  if (!parsed.success || Object.keys(parsed.data).length === 0)
    throw new Error(
      "input_digests must map POSIX-relative input paths to lowercase sha256 digests",
    );
  return {
    analysisPlanId: plan.data,
    parameterSetId: set.data,
    calibOverride,
    inputDigests: parsed.data,
  };
}

/**
 * `bound` runs synchronously right after the pure plan validation, before any filesystem
 * operation, so a caller can decide on the binding before the input is resolved or walked.
 */
export function prepareInput(
  request: SubmitShudRequest,
  stateDir: string,
  bound: (plan: PlanBinding) => void,
): PreparedInput {
  const task = request.task_id === undefined ? null : TaskIdSchema.safeParse(request.task_id);
  if (task !== null && !task.success) throw new Error("task_id must be a valid TaskId");
  const taskId = task === null ? null : task.data;
  const build = request.build_id === undefined ? null : BuildIdSchema.safeParse(request.build_id);
  if (build !== null && !build.success) throw new Error("build_id must be a valid BuildId");
  const buildId = build === null ? null : build.data;
  const parsedThreads = RunJobSchema.shape.threads.safeParse(request.threads);
  if (!parsedThreads.success || (request.threads !== undefined && parsedThreads.data === null))
    throw new Error("threads must be a positive safe integer");
  const threads = parsedThreads.data;
  const plan = planBinding(request, threads);
  bound(plan);
  const project = RunJobSchema.shape.project.parse(request.project);
  if (!isProjectComponent(project)) {
    throw new Error("project must be one contained path component");
  }
  const endDays = RunJobSchema.shape.end_days.parse(request.end_days ?? null);
  const label = RunJobSchema.shape.label.parse(request.label ?? null);
  const ownerSession = RunJobSchema.shape.owner_session.parse(request.owner_session);
  const llm = RunJobSchema.shape.llm.parse(request.llm);
  if (typeof request.cwd !== "string" || !request.cwd)
    throw new Error("cwd must name the session directory");
  if (typeof request.input_dir !== "string" || !request.input_dir)
    throw new Error("input_dir must name an input directory");
  // Do not path.resolve/join an uncanonicalized user path: alias/.. has physical semantics.
  const cwd = realpathSync.native(request.cwd);
  realDirectory(cwd);
  const inputDir = realpathSync.native(
    isAbsolute(request.input_dir) ? request.input_dir : `${cwd}/${request.input_dir}`,
  );
  realDirectory(inputDir);
  let runsDir = join(cwd, "runs");
  if (existingPath(runsDir)) {
    // Reject links before realpath can hide them, then preserve the existing physical spelling.
    realDirectory(runsDir);
    runsDir = realpathSync.native(runsDir);
  }
  if (containsPath(inputDir, runsDir))
    throw new Error(`Run root is inside input directory: ${inputDir}`);
  if (containsPath(inputDir, realpathSync.native(stateDir))) {
    throw new Error(`stateDir is inside input directory: ${inputDir}`);
  }
  for (const name of ["stacks", "provenance"]) {
    let destination = join(cwd, name);
    if (existingPath(destination)) {
      realDirectory(destination);
      destination = realpathSync.native(destination);
    }
    if (containsPath(inputDir, destination)) {
      throw new Error(`${name} root is inside input directory: ${inputDir}`);
    }
  }
  const parameter = join(inputDir, `${project}.cfg.para`);
  const para = existingPath(parameter);
  if (!para?.isFile() || para.isSymbolicLink())
    throw new Error(`Expected regular project parameter file ${project}.cfg.para`);
  const items: InputItem[] = [];
  function visit(relative: string) {
    const directory = relative ? join(inputDir, relative) : inputDir;
    for (const name of readdirSync(directory)) {
      const child = relative ? join(relative, name) : name;
      const stat = lstatSync(join(inputDir, child));
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw new Error(`Unsafe input entry: ${child}`);
      }
      items.push({ relative: child, directory: stat.isDirectory() });
      if (stat.isDirectory()) visit(child);
    }
  }
  visit("");
  return {
    cwd,
    inputDir,
    runsDir,
    project,
    taskId,
    buildId,
    threads,
    plan,
    endDays,
    label,
    ownerSession,
    llm,
    items,
  };
}

/**
 * Read-only check that the run copy is the plan's baseline input: each listed file is read once
 * through the records SHUD input reader (contained relative path, real-directory ancestors,
 * regular no-follow file) and its sha256 must equal the plan digest.
 */
export function verifyInputDigests(copyDir: string, digests: Record<string, string>): void {
  for (const [relative, expected] of Object.entries(digests)) {
    let actual: string;
    try {
      actual = readShudInputFile(copyDir, relative).sha256;
    } catch (error) {
      throw new Error(`Cannot verify input digest of ${relative}`, { cause: error });
    }
    if (actual !== expected) throw new Error(`Input digest mismatch: ${relative}`);
  }
}

export async function copyInput(input: PreparedInput, runDir: string): Promise<number> {
  const destination = join(runDir, "input", input.project);
  await io.mkdir(destination, { recursive: true });
  let bytes = 0;
  for (const item of input.items) {
    const source = join(input.inputDir, item.relative);
    const target = join(destination, item.relative);
    try {
      const stat = lstatSync(source);
      if (stat.isSymbolicLink() || (item.directory ? !stat.isDirectory() : !stat.isFile())) {
        throw new Error("input entry changed type after preflight");
      }
      if (item.directory) await io.mkdir(target);
      else {
        await io.copyFile(source, target, constants.COPYFILE_EXCL);
        bytes += (await io.stat(target)).size;
      }
    } catch (error) {
      throw new Error(`Cannot copy input entry ${item.relative}`, { cause: error });
    }
  }
  return bytes;
}

export function verifyRun(runsDir: string, parent: Stats, runDir: string, owned: Stats): void {
  const currentParent = realDirectory(runsDir);
  const current = realDirectory(runDir);
  if (
    currentParent.dev !== parent.dev ||
    currentParent.ino !== parent.ino ||
    current.dev !== owned.dev ||
    current.ino !== owned.ino
  ) {
    throw new Error(`Run directory ownership changed: ${runDir}`);
  }
}
