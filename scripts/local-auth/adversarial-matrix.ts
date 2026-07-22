import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

const DEADLINE_MS = 30_000;
const testDirectory = join(process.cwd(), "packages/backend/src/local-auth");
const testFiles = readdirSync(testDirectory)
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => join(testDirectory, name));

if (testFiles.length === 0) {
  throw new Error("No local-auth adversarial tests were found.");
}

const child = spawn(process.execPath, ["test", ...testFiles], {
  detached: true,
  stdio: "inherit"
});

let deadlineExpired = false;
const deadline = setTimeout(() => {
  deadlineExpired = true;
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}, DEADLINE_MS);

const exitCode = await new Promise<number>((resolvePromise, rejectPromise) => {
  child.once("error", rejectPromise);
  child.once("exit", (code, signal) => {
    if (deadlineExpired) {
      resolvePromise(124);
      return;
    }
    if (signal !== null) {
      rejectPromise(new Error(`Local-auth adversarial matrix exited on ${signal}.`));
      return;
    }
    resolvePromise(code ?? 1);
  });
});

clearTimeout(deadline);
if (exitCode === 124) {
  console.error(`Local-auth adversarial matrix exceeded ${DEADLINE_MS} ms.`);
}
process.exit(exitCode);
