import { lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type GeneratedPathContext = {
  generatedRootPath: string;
};

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const generatedRoot = join(repoRoot, "docs/generated");
export const markdownDir = join(repoRoot, "docs/generated/schema");
export const jsonSchemaDir = join(repoRoot, "docs/generated/json-schema");

export const generatedPathContext: GeneratedPathContext = {
  generatedRootPath: generatedRoot,
};

export async function recreateGeneratedDirectory(
  path: string,
  context = generatedPathContext,
): Promise<void> {
  await assertGeneratedPathSafe(path, context);
  await rm(path, { recursive: true, force: true });
  await assertGeneratedPathSafe(path, context);
  await mkdir(path, { recursive: true });
}

export async function writeGeneratedFile(
  path: string,
  content: string,
  context = generatedPathContext,
): Promise<void> {
  await assertGeneratedPathSafe(path, context);
  await writeFile(path, content, "utf8");
}

async function assertGeneratedPathSafe(
  path: string,
  context = generatedPathContext,
): Promise<void> {
  const rootPath = resolve(context.generatedRootPath);
  const targetPath = resolve(path);

  if (!isPathInsideOrEqual(targetPath, rootPath)) {
    throw new Error(`Generated output path is unsafe: ${targetPath} is outside ${rootPath}`);
  }

  await assertExistingPathSegmentsNotSymlinks(rootPath);
  await assertExistingPathSegmentsNotSymlinks(targetPath);

  const rootStats = await lstat(rootPath);
  if (!rootStats.isDirectory()) {
    throw new Error(`Generated output path is unsafe: ${rootPath} must be a directory`);
  }

  const realRootPath = await realpath(rootPath);
  const existingTargetPath = await nearestExistingPath(targetPath);
  const realExistingTargetPath = await realpath(existingTargetPath);

  if (!isPathInsideOrEqual(realExistingTargetPath, realRootPath)) {
    throw new Error(
      `Generated output path is unsafe: ${realExistingTargetPath} resolves outside ${realRootPath}`,
    );
  }
}

async function assertExistingPathSegmentsNotSymlinks(path: string): Promise<void> {
  const segments: string[] = [];
  let current = resolve(path);

  while (true) {
    segments.push(current);
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  for (const segment of segments.reverse()) {
    let stats;
    try {
      stats = await lstat(segment);
    } catch (error) {
      if (isNotFoundError(error)) {
        return;
      }
      throw error;
    }

    if (stats.isSymbolicLink()) {
      throw new Error(`Generated output path is unsafe: ${segment} must not be a symlink`);
    }
  }
}

async function nearestExistingPath(path: string): Promise<string> {
  let current = resolve(path);

  while (true) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }

    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`Generated output path is unsafe: no existing ancestor for ${path}`);
    }
    current = parent;
  }
}

function isPathInsideOrEqual(path: string, rootPath: string): boolean {
  const pathRelativeToRoot = relative(rootPath, path);
  return (
    pathRelativeToRoot === "" ||
    (!pathRelativeToRoot.startsWith("..") && !isAbsolute(pathRelativeToRoot))
  );
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
