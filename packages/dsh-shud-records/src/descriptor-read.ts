import { closeSync, constants, fstatSync, openSync, type Stats } from "node:fs";

type DescriptorReadPhase = "open" | "fstat" | "target" | "read" | "close";

/**
 * Shared comparator/input descriptor lifecycle. The caller supplies preflight identity,
 * a descriptor-only read, and its domain's controlled error classification. Ancestor
 * observations remain caller-owned; this is not an atomic filesystem snapshot.
 */
export function readVerifiedDescriptor<T>(
  path: string,
  inspected: Stats,
  read: (fd: number) => T,
  failure: (phase: DescriptorReadPhase, error: unknown) => Error,
): T {
  let fd: number | undefined;
  let closeAttempted = false;
  let phase: DescriptorReadPhase = "open";
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
      throw new Error("Descriptor identity changed");
    }
    phase = "read";
    const result = read(fd);
    phase = "close";
    // A failed close leaves ownership unknown; it must not trigger a second close attempt.
    closeAttempted = true;
    closeSync(fd);
    return result;
  } catch (error) {
    // Error factories must never attach an arbitrary native error or its cause.
    const primary = failure(phase, error);
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
