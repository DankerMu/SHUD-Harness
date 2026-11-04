import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { runGit } from "@shud-harness/dsh-shud-core";

/** Bind the fixed checkout and its pin to the physical workspace without changing source or index. */
export async function readSourceCheckout(cwd: string) {
  let stage = "directory validation";
  try {
    const physicalCwd = realpathSync.native(cwd);
    const sourceDir = join(physicalCwd, "repos", "SHUD");
    if (!lstatSync(sourceDir).isDirectory()) throw new Error();
    const physicalSource = realpathSync.native(sourceDir);

    // rev-parse is not among runGit's automatically root-checked commands.
    stage = "repository root validation";
    const rootOutput = (await runGit(sourceDir, ["rev-parse", "--show-toplevel"])).stdout.toString(
      "utf8",
    );
    const root = rootOutput.endsWith("\n") ? rootOutput.slice(0, -1) : rootOutput;
    if (realpathSync.native(root) !== physicalSource) throw new Error();

    stage = "HEAD validation";
    const headOutput = (await runGit(sourceDir, ["rev-parse", "HEAD"])).stdout.toString("utf8");
    const head = headOutput.endsWith("\n") ? headOutput.slice(0, -1) : headOutput;
    if (head.length !== 40 || !/^[0-9a-f]{40}$/u.test(head)) throw new Error();
    return { cwd: physicalCwd, sourceDir, head };
  } catch {
    throw new Error(`Source checkout repos/SHUD: ${stage} failed`);
  }
}
