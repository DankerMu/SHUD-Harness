// omp extension shim for worktree-guard. Installed at
// <config>/hooks/pre/worktree-guard.ts; delegates to the canonical shell guard
// copied to ../worktree-guard/worktree-guard.sh. omp normalizes edit events so
// `path`/`paths` are present even in hashline mode; each candidate is checked
// separately. omp's exec API has no stdin option, so the Claude-style tool
// JSON is piped in via bash argv. Only exit code 2 blocks.
const SCRIPT = decodeURIComponent(
  new URL("../worktree-guard/worktree-guard.sh", import.meta.url).pathname
);

export default function hook(pi: any): void {
  pi.on("tool_call", async (event: any) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    const input = event.input ?? {};
    const candidates = Array.isArray(input.paths) ? input.paths : input.path ? [input.path] : [];
    for (const candidate of candidates) {
      const payload = JSON.stringify({
        tool_name: event.toolName,
        tool_input: { file_path: String(candidate) },
        cwd: process.cwd()
      });
      try {
        const result = await pi.exec(
          "bash",
          ["-c", 'printf %s "$1" | bash "$2"', "omp-hook", payload, SCRIPT],
          { timeout: 15000 }
        );
        if (result.code === 2) {
          return {
            block: true,
            reason: result.stderr.trim() || "worktree-guard: write blocked"
          };
        }
      } catch {
        // Script or runtime failure is non-blocking, same as a non-2 exit code.
      }
    }
  });
}
