import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, lstat } from "node:fs/promises";
import { sep, join, resolve } from "node:path";
import {
  resolveWorkspacePath,
  WorkspacePathSafetyError
} from "./workspace-path-safety";

export interface HashingServiceInput {
  workspaceRoot: string;
  inputPath: string;
  evidenceRef: string;
}

function workspacePathSafetyError(message: string, evidenceRef: string): never {
  throw new WorkspacePathSafetyError(message, evidenceRef);
}

async function assertRegularFileEntry(path: string, evidenceRef: string): Promise<void> {
  let entry;
  try {
    entry = await lstat(path);
  } catch {
    workspacePathSafetyError("Workspace path does not exist.", evidenceRef);
  }

  if (entry.isSymbolicLink()) {
    workspacePathSafetyError("Workspace path cannot follow symlinks.", evidenceRef);
  }
  if (!entry.isFile()) {
    workspacePathSafetyError("Workspace path must reference a regular file.", evidenceRef);
  }
}

async function assertRegularDirectoryEntry(path: string, evidenceRef: string): Promise<void> {
  let entry;
  try {
    entry = await lstat(path);
  } catch {
    workspacePathSafetyError("Workspace path does not exist.", evidenceRef);
  }

  if (entry.isSymbolicLink()) {
    workspacePathSafetyError("Workspace path cannot follow symlinks.", evidenceRef);
  }
  if (!entry.isDirectory()) {
    workspacePathSafetyError("Workspace path must reference a directory.", evidenceRef);
  }
}

async function resolveHashInput(input: HashingServiceInput): Promise<string> {
  return (
    await resolveWorkspacePath({
      workspaceRoot: input.workspaceRoot,
      inputPath: input.inputPath,
      evidenceRef: input.evidenceRef,
      access: "read"
    })
  ).absolutePath;
}

async function hashFileByStream(filePath: string, evidenceRef: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);

  try {
    for await (const chunk of stream) {
      hash.update(chunk);
    }
  } catch {
    workspacePathSafetyError(`Workspace file could not be hashed: ${resolve(filePath)}.`, evidenceRef);
  }

  return hash.digest("hex");
}

async function collectRegularRelativeFiles(
  absoluteDirectoryPath: string,
  absoluteWorkspaceRoot: string,
  evidenceRef: string,
  relativeDirectoryPath = ""
): Promise<string[]> {
  const absoluteCurrentDirectory = resolve(absoluteDirectoryPath, relativeDirectoryPath);
  const entries = await readdir(absoluteCurrentDirectory, { withFileTypes: true });
  const regularFiles: string[] = [];

  for (const entry of entries) {
    const relativePath = join(relativeDirectoryPath, entry.name);
    const childPath = resolve(absoluteWorkspaceRoot, relativePath);
    const childEntry = await lstat(childPath);

    if (childEntry.isSymbolicLink()) {
      workspacePathSafetyError("Workspace directory traversal rejected a symbolic link.", evidenceRef);
    }

    if (childEntry.isDirectory()) {
      regularFiles.push(
        ...(
          await collectRegularRelativeFiles(
            absoluteDirectoryPath,
            absoluteWorkspaceRoot,
            evidenceRef,
            relativePath
          )
        )
      );
      continue;
    }

    if (!childEntry.isFile()) {
      workspacePathSafetyError("Workspace directory traversal rejected a non-regular file.", evidenceRef);
    }

    regularFiles.push(relativePath.split(sep).join("/"));
  }

  return regularFiles;
}

export async function hashFileSha256(input: HashingServiceInput): Promise<string> {
  const absolutePath = await resolveHashInput(input);
  await assertRegularFileEntry(absolutePath, input.evidenceRef);
  return await hashFileByStream(absolutePath, input.evidenceRef);
}

export async function hashDirectorySha256(input: HashingServiceInput): Promise<string> {
  const absoluteDirectoryPath = await resolveHashInput(input);
  await assertRegularDirectoryEntry(absoluteDirectoryPath, input.evidenceRef);

  const relativeFilePaths = (
    await collectRegularRelativeFiles(
      absoluteDirectoryPath,
      absoluteDirectoryPath,
      input.evidenceRef
    )
  ).sort();

  if (relativeFilePaths.length === 0) {
    workspacePathSafetyError("Directory has no regular files.", input.evidenceRef);
  }

  const hash = createHash("sha256");
  for (const relativeFilePath of relativeFilePaths) {
    const absoluteFilePath = resolve(absoluteDirectoryPath, ...relativeFilePath.split("/"));
    const fileHash = await hashFileSha256({
      workspaceRoot: absoluteDirectoryPath,
      inputPath: relativeFilePath,
      evidenceRef: input.evidenceRef
    });
    hash.update(relativeFilePath);
    hash.update("\n");
    hash.update(fileHash);
    hash.update("\n");
  }

  return hash.digest("hex");
}
