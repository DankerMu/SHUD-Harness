#!/usr/bin/env bun
import { runCheck } from "./lib/checker";

const exitCode = await runCheck(Bun.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text)
});
process.exit(exitCode);
