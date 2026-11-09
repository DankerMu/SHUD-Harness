import { basename } from "node:path";

/**
 * Effective SHUD project stem shared by shud_run and analysis_create: the explicit value, else
 * the basename of input_dir exactly as supplied. Empty, "." and ".." basenames require an
 * explicit project so a later plan binding compares identically derived values.
 */
export function effectiveProject(tool: string, inputDir: string, project?: string): string {
  const effective = project ?? basename(inputDir);
  if (project === undefined && (effective === "" || effective === "." || effective === "..")) {
    throw new Error(`${tool} requires an explicit project for this input_dir`);
  }
  return effective;
}
