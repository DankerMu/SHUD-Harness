import * as fs from "node:fs";
import { dirname, join } from "node:path";
import type { ToolCallId } from "@deepseek-ai/dsh-llm";
import { fileSnapshot, git, type ChangeHarness } from "../change-create/test-harness.ts";

export function seedBuildSource(
  cwd: string,
  files: Record<string, string> = {
    Makefile:
      "CXX := cc\nshud:\n\tprintf '%s\\n' '#!/bin/sh' 'printf \"base-tracer\\n\"' > shud\n\tchmod 755 shud\n",
  },
) {
  const source = join(cwd, "repos", "SHUD");
  fs.mkdirSync(source, { recursive: true });
  git(source, "init", "-q", "--template=", "--initial-branch=main", "--object-format=sha1");
  for (const [path, bytes] of Object.entries(files)) {
    fs.mkdirSync(dirname(join(source, path)), { recursive: true });
    fs.writeFileSync(join(source, path), bytes);
  }
  fs.writeFileSync(join(source, ".gitignore"), "shud\nshud.*\n");
  git(source, "add", "--all");
  git(
    source,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-qm",
    "base build fixture",
  );
  // A non-phony shud target would keep this executable if built in the checkout.
  fs.writeFileSync(join(source, "shud"), '#!/bin/sh\nprintf "stale-checkout\\n"\n', {
    mode: 0o755,
  });
  return { source, head: git(source, "rev-parse", "HEAD").toString("utf8").trim() };
}

export function allSourceFiles(source: string) {
  const files: Array<{ path: string; bytes: Buffer; mtime: bigint; mode: bigint }> = [];
  function visit(directory: string, relative: string) {
    for (const name of fs.readdirSync(directory).sort()) {
      const path = join(directory, name);
      const key = relative ? `${relative}/${name}` : name;
      const stat = fs.lstatSync(path, { bigint: true });
      if (stat.isDirectory()) visit(path, key);
      else {
        if (!stat.isFile()) throw new Error(`Expected ordinary fixture file: ${key}`);
        files.push({ path: key, ...fileSnapshot(path), mode: stat.mode });
      }
    }
  }
  visit(source, "");
  return files;
}

export function invokeTool(
  h: Pick<ChangeHarness, "runtime" | "agent">,
  name: string,
  arguments_: unknown,
) {
  return h.runtime.execute({
    callId: "shud-build-runtime-tracer" as ToolCallId,
    name,
    arguments: arguments_,
    agent: h.agent,
    signal: new AbortController().signal,
  });
}
