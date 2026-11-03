import { createHash } from "node:crypto";
import { constants, lstatSync, readdirSync, type Stats } from "node:fs";
import * as io from "node:fs/promises";
import { join } from "node:path";
import type { BuildId, BuildRecord, TaskId } from "@shud-harness/dsh-shud-core";
import {
  readWorkspaceRecord,
  verifyBuildBinary,
  WorkspaceRecordError,
} from "@shud-harness/dsh-shud-records";
import { realDirectory } from "./shud-input.ts";

/** A replaced destination must survive the submission's recursive run rollback. */
export class BuildOwnershipError extends AggregateError {
  constructor(id: BuildId, errors: Error[]) {
    super(errors, `Build ${id}: binary destination ownership changed`);
  }
}

function buildFailure(id: BuildId, stage: string, error?: unknown): Error {
  const code =
    error instanceof WorkspaceRecordError
      ? error.stage
      : error instanceof Error &&
          "code" in error &&
          typeof error.code === "string" &&
          /^E[A-Z0-9]+$/u.test(error.code)
        ? error.code
        : undefined;
  return new Error(`Build ${id}: ${stage} failed${code ? ` (${code})` : ""}`);
}

/** Read only the selected build. Verification is not a snapshot: the copier reacquires safely. */
export async function prepareBuild(
  cwd: string,
  id: BuildId,
  taskId: TaskId | null,
  runDir: string,
  verifyOwnership: () => void,
): Promise<BuildRecord> {
  let record: BuildRecord;
  try {
    record = readWorkspaceRecord(cwd, "build", id, { readonly: true });
  } catch (error) {
    throw buildFailure(id, "build-record schema/path/identity read", error);
  }
  if (taskId !== null && record.task_id !== taskId) throw buildFailure(id, "task_id compatibility");
  try {
    verifyBuildBinary(cwd, record);
  } catch (error) {
    throw buildFailure(id, "source sha256/executable verification", error);
  }
  await copyBinary(cwd, record, runDir, verifyOwnership);
  return record;
}

/** One bounded buffer, sequential descriptor I/O, and exactly one close attempt per owned handle. */
async function copyBinary(
  cwd: string,
  record: BuildRecord,
  runDir: string,
  verifyOwnership: () => void,
): Promise<void> {
  const id = record.build_id;
  const buildRoot = join(cwd, "builds");
  const buildDir = join(buildRoot, id);
  const sourcePath = join(buildDir, "shud");
  const bin = join(runDir, "bin");
  const temporary = join(bin, ".shud.tmp");
  const target = join(bin, "shud");
  let directory: Stats | undefined;
  let copied: Stats | undefined;
  let source: io.FileHandle | undefined;
  let destination: io.FileHandle | undefined;
  let stage = "binary destination creation";
  const failures: Error[] = [];
  function verifyDestination() {
    try {
      verifyOwnership();
      if (directory) {
        const current = realDirectory(bin);
        if (current.dev !== directory.dev || current.ino !== directory.ino)
          throw new Error("Binary directory ownership changed");
      }
    } catch {
      throw new BuildOwnershipError(id, []);
    }
  }
  function failPreparation(): never {
    // Recursive run rollback is permitted only while every observed binary child is ours.
    // Acquisition errors may leave an observed foreign entry without any captured identity.
    try {
      verifyOwnership();
      const current = lstatSync(bin, { throwIfNoEntry: false });
      if (!directory) {
        if (current) throw new Error("Unowned binary directory");
      } else {
        if (
          !current?.isDirectory() ||
          current.dev !== directory.dev ||
          current.ino !== directory.ino
        )
          throw new Error("Binary directory ownership changed");
        if (readdirSync(bin).some((name) => name !== ".shud.tmp" && name !== "shud"))
          throw new Error("Unowned binary directory entry");
        const pending = lstatSync(temporary, { throwIfNoEntry: false });
        const published = lstatSync(target, { throwIfNoEntry: false });
        if (!copied) {
          if (pending || published) throw new Error("Unowned binary file");
        } else {
          // A failed rename may already have moved the owned inode to its final name.
          const file = pending ?? published;
          if (
            (pending && published) ||
            !file?.isFile() ||
            file.dev !== copied.dev ||
            file.ino !== copied.ino
          )
            throw new Error("Binary file ownership changed");
        }
      }
    } catch {
      failures.push(new BuildOwnershipError(id, []));
    }
    if (failures.some((error) => error instanceof BuildOwnershipError))
      throw new BuildOwnershipError(id, failures);
    if (failures.length === 1) throw failures[0];
    throw new AggregateError(failures, `Build ${id}: binary preparation and cleanup failed`);
  }
  try {
    verifyDestination();
    await io.mkdir(bin);
    verifyDestination();
    directory = realDirectory(bin);
    stage = "source descriptor acquisition";
    realDirectory(buildRoot);
    realDirectory(buildDir);
    const inspected = lstatSync(sourcePath);
    if (!inspected.isFile() || (inspected.mode & 0o111) === 0)
      throw new Error("Expected regular executable source");
    source = await io.open(
      sourcePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    verifyDestination();
    realDirectory(buildRoot);
    realDirectory(buildDir);
    const current = lstatSync(sourcePath);
    const descriptor = await source.stat();
    verifyDestination();
    if (
      !descriptor.isFile() ||
      !current.isFile() ||
      (descriptor.mode & 0o111) === 0 ||
      descriptor.dev !== inspected.dev ||
      descriptor.ino !== inspected.ino ||
      current.dev !== inspected.dev ||
      current.ino !== inspected.ino
    )
      throw new Error("Source descriptor identity changed");
    stage = "binary temporary acquisition";
    destination = await io.open(
      temporary,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    verifyDestination();
    copied = await destination.stat();
    verifyDestination();
    if (!copied.isFile()) throw new Error("Expected regular temporary binary");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    stage = "binary copy read/write";
    for (;;) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
      verifyDestination();
      if (bytesRead === 0) break;
      let offset = 0;
      while (offset < bytesRead) {
        const { bytesWritten } = await destination.write(buffer, offset, bytesRead - offset, null);
        verifyDestination();
        if (bytesWritten <= 0) throw new Error("Binary copy made no write progress");
        offset += bytesWritten;
      }
    }
    stage = "binary chmod";
    await destination.chmod(0o755);
    verifyDestination();
    stage = "copied binary sha256";
    const hash = createHash("sha256");
    let position = 0;
    for (;;) {
      const { bytesRead } = await destination.read(buffer, 0, buffer.length, position);
      verifyDestination();
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    if (hash.digest("hex") !== record.binary_sha256)
      throw new Error("Copied binary sha256 mismatch");
  } catch (error) {
    failures.push(error instanceof BuildOwnershipError ? error : buildFailure(id, stage, error));
  } finally {
    // Both handles are attempted even if the first close fails. A rejection is never retried or
    // reported as proof of closure. No outstanding read/write exists before these closes begin.
    for (const [handle, name] of [
      [source, "source"],
      [destination, "copy"],
    ] as const) {
      if (!handle) continue;
      try {
        await handle.close();
      } catch (error) {
        failures.push(buildFailure(id, `${name} descriptor close`, error));
      }
    }
  }
  if (failures.length > 0) failPreparation();
  try {
    verifyDestination();
    const file = lstatSync(temporary);
    if (
      !copied ||
      !file.isFile() ||
      file.dev !== copied.dev ||
      file.ino !== copied.ino ||
      (file.mode & 0o7777) !== 0o755
    )
      throw new BuildOwnershipError(id, []);
    // Refuse an observed external target; this is not rename-no-replace against arbitrary writers.
    if (lstatSync(target, { throwIfNoEntry: false })) throw new BuildOwnershipError(id, []);
    await io.rename(temporary, target);
    verifyDestination();
    const published = lstatSync(target);
    if (
      !published.isFile() ||
      published.dev !== copied.dev ||
      published.ino !== copied.ino ||
      (published.mode & 0o7777) !== 0o755
    )
      throw new BuildOwnershipError(id, []);
  } catch (error) {
    // Audit both temporary and final paths even when publication failed after its syscall.
    failures.push(
      error instanceof BuildOwnershipError
        ? error
        : buildFailure(id, "binary publication/ownership", error),
    );
    failPreparation();
  }
}
