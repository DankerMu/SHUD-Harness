// omp extension shim for large-file-guard. Installed at
// <config>/hooks/pre/large-file-guard.ts; delegates to the canonical shell
// guard copied to ../large-file-guard/large-file-guard.sh. omp's exec API has
// no stdin option, so the Claude-style tool JSON is piped in via bash argv.
// Only an explicit exit code 2 blocks, mirroring Claude Code hook semantics.
const SCRIPT = decodeURIComponent(
  new URL("../large-file-guard/large-file-guard.sh", import.meta.url).pathname
);

export default function hook(pi: any): void {
  pi.on("tool_call", async (event: any) => {
    if (event.toolName !== "bash") return;
    const payload = JSON.stringify({
      tool_name: "bash",
      tool_input: { command: String(event.input?.command ?? "") },
      cwd: process.cwd()
    });
    try {
      const result = await pi.exec(
        "bash",
        ["-c", 'printf %s "$1" | bash "$2"', "omp-hook", payload, SCRIPT],
        { timeout: 20000 }
      );
      if (result.code === 2) {
        return {
          block: true,
          reason: result.stderr.trim() || "large-file-guard: commit blocked"
        };
      }
    } catch {
      // Script or runtime failure is non-blocking, same as a non-2 exit code.
    }
  });
}
