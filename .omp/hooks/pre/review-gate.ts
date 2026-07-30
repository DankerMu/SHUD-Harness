// omp extension shim for review-gate. Installed at
// <config>/hooks/pre/review-gate.ts; delegates to the canonical shell guard
// copied to ../review-gate/review-gate.sh. The script scans several agent-name
// keys (including `agent`, which omp's task tool uses), so the event input is
// forwarded verbatim. omp's exec API has no stdin option, so the Claude-style
// tool JSON is piped in via bash argv. Only exit code 2 blocks.
const SCRIPT = decodeURIComponent(
  new URL("../review-gate/review-gate.sh", import.meta.url).pathname
);

export default function hook(pi: any): void {
  pi.on("tool_call", async (event: any) => {
    if (event.toolName !== "task") return;
    const payload = JSON.stringify({
      tool_name: "task",
      tool_input: event.input ?? {},
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
          reason: result.stderr.trim() || "review-gate: subagent spawn blocked"
        };
      }
    } catch {
      // Script or runtime failure is non-blocking, same as a non-2 exit code.
    }
  });
}
