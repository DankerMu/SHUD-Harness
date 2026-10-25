import { write } from "node:fs";
import { Logger, type Context, type Exporter } from "@deepseek-ai/cordis";

// Public Cordis WARN level; its const enum is not a runtime import.
const WARN_LEVEL = 2;

function completeDiagnosticWrite(): void {
  // One best-effort attempt: errors or short writes lose the diagnostic, not the host.
  // Owning this write's completion avoids an unhandled stderr stream error; no retry.
}

/** Forward only this facade's recovery diagnostics; Cordis owns the sink's disposal. */
export function createRecoveryReporter(ctx: Context): (message: string) => void {
  const logger = ctx.logger("shud-recovery");
  const fiber = logger.meta?.fiber;
  const exporter: Exporter = {
    levels: { [logger.name]: WARN_LEVEL },
    export(message) {
      if (message.name !== logger.name || message.fiber !== fiber) return;
      write(
        process.stderr.fd,
        `${new Date(message.ts).toISOString()} WARN ${message.name}: ${Logger.format(exporter, message)}\n`,
        completeDiagnosticWrite,
      );
    },
  };
  ctx.logger.exporter(exporter);
  return (message) => logger.warn(message);
}
