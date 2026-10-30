import { constants, lstatSync, readdirSync, realpathSync, type Stats } from "node:fs";
import * as io from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  containsPath,
  RunJobSchema,
  TaskIdSchema,
  type RunJob,
  type TaskId,
} from "@shud-harness/dsh-shud-core";

export interface SubmitShudRequest {
  cwd: string;
  input_dir: string;
  project: string;
  task_id?: TaskId;
  end_days?: RunJob["end_days"];
  label?: RunJob["label"];
  owner_session: RunJob["owner_session"];
  llm: RunJob["llm"];
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

export function isProjectComponent(project: string): boolean {
  return project.length > 0 && project !== "." && project !== ".." && !/[\\/\0]/u.test(project);
}

export function prepareInput(request: SubmitShudRequest, stateDir: string): PreparedInput {
  const task = request.task_id === undefined ? null : TaskIdSchema.safeParse(request.task_id);
  if (task !== null && !task.success) throw new Error("task_id must be a valid TaskId");
  const taskId = task === null ? null : task.data;
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
  return { cwd, inputDir, runsDir, project, taskId, endDays, label, ownerSession, llm, items };
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
