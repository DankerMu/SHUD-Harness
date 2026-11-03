import { closeSync, constants, fstatSync, openSync, type Stats } from "node:fs";
import { isAbsolute } from "node:path";
import { isProjectComponent } from "@shud-harness/dsh-shud-core";
import { hashDescriptor } from "./hash-descriptor.ts";
import { regularTarget } from "./workspace-paths.ts";
import { WorkspaceRecordError } from "./workspace-records.ts";

function inspectOutput(path: string): Stats {
  let inspected: Stats | undefined;
  try {
    inspected = regularTarget(path, "Rivqdown");
  } catch {
    throw new WorkspaceRecordError("target", path);
  }
  if (!inspected) throw new WorkspaceRecordError("missing", path);
  return inspected;
}

function hashOutput(path: string, inspected: Stats): string {
  let fd: number | undefined;
  let closeAttempted = false;
  let phase: "open" | "fstat" | "target" | "read" | "close" = "open";
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    phase = "fstat";
    const descriptor = fstatSync(fd);
    phase = "target";
    if (
      !descriptor.isFile() ||
      descriptor.dev !== inspected.dev ||
      descriptor.ino !== inspected.ino
    ) {
      throw new WorkspaceRecordError("target", path);
    }
    phase = "read";
    const digest = hashDescriptor(fd);
    phase = "close";
    // A failed close leaves ownership unknown; it must not trigger a second close attempt.
    closeAttempted = true;
    closeSync(fd);
    return digest;
  } catch {
    // Derive diagnostics from our phase, never from an arbitrary native error or its cause.
    const primary = new WorkspaceRecordError(phase === "target" ? "target" : "read", path);
    primary.message += `: ${phase} failed`;
    if (fd !== undefined && !closeAttempted) {
      try {
        closeSync(fd);
      } catch {
        primary.message += ": descriptor cleanup failed; descriptor state unknown";
      }
    } else if (closeAttempted) {
      primary.message += "; descriptor state unknown";
    }
    throw primary;
  }
}

/**
 * Compare only raw rivqdown bytes, returning exactly the relative POSIX path, both SHA256
 * digests and their equality. Missing/unsafe evidence or any read/close failure throws;
 * no partial verdict, numerical tolerance, other artifact/log reads or writes are involved.
 * Validate absolute string roots and the shared project component before paths or IO.
 * Caller-owned root aliases retain physical traversal semantics; final links are rejected.
 * Both targets are preflighted before sequential, identity-bound, bounded descriptor reads.
 * This observes bytes now, not a concurrent snapshot or proof of caller run identity.
 */
export function compareRivqdown(
  baseRunDir: string,
  candidateRunDir: string,
  project: string,
): { compared_path: string; base_sha256: string; candidate_sha256: string; equal: boolean } {
  if (
    typeof baseRunDir !== "string" ||
    !isAbsolute(baseRunDir) ||
    typeof candidateRunDir !== "string" ||
    !isAbsolute(candidateRunDir)
  ) {
    throw new WorkspaceRecordError("directory");
  }
  if (typeof project !== "string" || !isProjectComponent(project)) {
    throw new WorkspaceRecordError("target");
  }
  const compared_path = `output/${project}.out/${project}.rivqdown.dat`;
  // Do not collapse an alias followed by '..' with lexical join/resolve/normalize.
  const basePath = `${baseRunDir}/${compared_path}`;
  const candidatePath = `${candidateRunDir}/${compared_path}`;
  const baseTarget = inspectOutput(basePath);
  const candidateTarget = inspectOutput(candidatePath);
  const base_sha256 = hashOutput(basePath, baseTarget);
  const candidate_sha256 = hashOutput(candidatePath, candidateTarget);
  return { compared_path, base_sha256, candidate_sha256, equal: base_sha256 === candidate_sha256 };
}
