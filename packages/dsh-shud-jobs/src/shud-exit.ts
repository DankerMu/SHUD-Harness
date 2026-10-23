import * as io from "node:fs/promises";
import { join } from "node:path";

export type ExitEvidence =
  | { code: number; error?: never; kind?: never }
  | { error: Error; kind: "invalid" | "unreadable"; code?: never };

/** Shared file authority for settlement and collection. Only ENOENT is absence. */
export async function readExit(runDir: string): Promise<ExitEvidence | undefined> {
  const path = join(runDir, "exit_code");
  let text: string;
  try {
    text = await io.readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
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
