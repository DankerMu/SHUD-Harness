import { constants } from "node:fs";
import * as io from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";

export type ExitEvidence =
  | { code: number; error?: never; kind?: never }
  | { error: Error; kind: "invalid" | "unreadable"; code?: never };

/** Shared descriptor-bound file authority. Only a missing open is absence. */
export async function readExit(runDir: string): Promise<ExitEvidence | undefined> {
  const path = join(runDir, "exit_code");
  let text: string;
  try {
    let handle: FileHandle;
    try {
      handle = await io.open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
    try {
      if (!(await handle.stat()).isFile()) throw new Error("exit_code is not a regular file");
      text = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    return {
      kind: "unreadable",
      error: new Error(`Unreadable exit_code at ${path}`, { cause: error }),
    };
  }
  const token = text.trim();
  const code = Number(token);
  if (!/^[+-]?\d+$/u.test(token) || !Number.isSafeInteger(code)) {
    return { kind: "invalid", error: new Error(`Invalid exit_code integer at ${path}`) };
  }
  return { code };
}
