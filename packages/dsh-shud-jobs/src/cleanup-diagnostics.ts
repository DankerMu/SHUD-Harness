import { spawnSync } from "node:child_process";
import { inspect } from "node:util";

const diagnostics = new WeakSet<Error>();
const TEXT_LIMIT = 32768;

function bounded(text: string): string {
  return text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}\n[diagnostic truncated]` : text;
}

function describeFailures(failures: readonly unknown[]): string {
  const seen = new Set<object>();
  const lines: string[] = [];
  let remaining = 128;
  function visit(value: unknown, path: string, depth: number): void {
    if (remaining-- <= 0 || depth > 16) {
      lines.push(`${path}: [diagnostic truncated]`);
      return;
    }
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) {
        lines.push(`${path}: [circular or repeated reference]`);
        return;
      }
      seen.add(value);
    }
    if (value instanceof Error) {
      lines.push(`${path}: ${value.name}: ${bounded(value.message)}`);
      // Already-captured diagnostics contain the complete bounded evidence and snapshot.
      if (diagnostics.has(value)) return;
      if (value.stack) lines.push(bounded(value.stack));
      if (value instanceof AggregateError) {
        const members: unknown[] = value.errors;
        for (const [index, error] of members.entries()) {
          visit(error, `${path}.errors[${index}]`, depth + 1);
          if (remaining <= 0) {
            lines.push(`${path}.errors: [diagnostic truncated]`);
            break;
          }
        }
      }
      if ("cause" in value) visit(value.cause, `${path}.cause`, depth + 1);
    } else {
      lines.push(
        `${path}: ${inspect(value, {
          depth: 3,
          maxArrayLength: 20,
          maxStringLength: 2000,
          customInspect: false,
          getters: false,
        })}`,
      );
    }
  }
  failures.forEach((failure, index) => visit(failure, `failure[${index}]`, 0));
  return bounded(lines.join("\n"));
}

function processSnapshot(pids: Iterable<number>): string {
  const known = new Set(pids);
  const identity = known.size
    ? [...known].map((pid) => `pid=${pid} pgid=${pid}`).join("; ")
    : "identity unknown";
  const heading = `Native cleanup context: ${identity}\nps pid pgid stat`;
  try {
    const result = spawnSync("ps", ["-axo", "pid=,pgid=,stat="], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" },
      timeout: 1000,
      maxBuffer: 1024 * 1024,
    });
    if (result.error || result.signal || result.status !== 0 || result.stderr.trim()) {
      const code = result.error && "code" in result.error ? String(result.error.code) : "unknown";
      return `${heading}: unavailable status=${result.status} code=${code} signal=${result.signal ?? "none"}`;
    }
    const rows = result.stdout.trim().split("\n");
    if (!result.stdout.trim() || rows.some((row) => !/^\s*\d+\s+\d+\s+\S+\s*$/u.test(row))) {
      return `${heading}: unavailable (empty or malformed process state)`;
    }
    const relevant = known.size
      ? rows.filter((row) => known.has(Number(row.trim().split(/\s+/u)[1])))
      : rows;
    return `${heading}\n${bounded(relevant.join("\n")) || "(no rows for known groups)"}`;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
    return `${heading}: unavailable code=${code}`;
  }
}

/** Capture at the catch boundary, before a collecting surface attempts its next release. */
export function captureCleanupFailure(error: unknown, pids: Iterable<number> = []): Error {
  if (error instanceof Error && diagnostics.has(error)) return error;
  const captured = new Error(`${describeFailures([error])}\n${processSnapshot(pids)}`, {
    // Keep cyclic original causes behind an aggregate member, not the reporter's cause chain.
    cause: new AggregateError([error], "Captured cleanup failure"),
  });
  diagnostics.add(captured);
  return captured;
}

/** A plain Error survives the runner's one-level AggregateError unwrapping. */
export function cleanupDiagnostic(message: string, failures: readonly unknown[]): Error {
  const error = new Error(`${message}\n${describeFailures(failures)}`, {
    cause: new AggregateError(failures, message),
  });
  diagnostics.add(error);
  return error;
}

/** Observe pending immediately, but compose primary evidence only when cleanup itself fails. */
export async function preserveCleanupErrors(
  body: (observe: <T>(pending: Promise<T>) => Promise<T>) => Promise<void>,
  cleanup: () => Promise<void>,
  pids: () => Iterable<number> = () => [],
): Promise<void> {
  const primary: unknown[] = [];
  const pendingFailures: unknown[] = [];
  try {
    await body(<T>(pending: Promise<T>): Promise<T> => {
      void pending.catch((error: unknown) => {
        pendingFailures.push(error);
      });
      return pending;
    });
  } catch (error) {
    primary.push(error);
  }
  try {
    await cleanup();
  } catch (error) {
    throw cleanupDiagnostic("Test body/pending and cleanup failed", [
      ...primary,
      ...pendingFailures,
      captureCleanupFailure(error, pids()),
    ]);
  }
  if (primary.length) throw primary[0];
}
