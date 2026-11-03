import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { devNull } from "node:os";
import { dirname, join } from "node:path";

export const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

export function fixtureGit(cwd: string, ...args: string[]): Buffer {
  return execFileSync(realGit, ["-C", cwd, ...args], {
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: devNull,
      GIT_OPTIONAL_LOCKS: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function putSource(repo: string, path: string, bytes: string | Uint8Array): void {
  const target = join(repo, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
}

export function commitSource(repo: string): void {
  fixtureGit(repo, "add", "--all");
  fixtureGit(
    repo,
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "source fixture",
  );
}

export function sourceRepo(
  root: string,
  files: Record<string, string> = { "model.cpp": "before\n" },
): string {
  const repo = join(root, "repo");
  fixtureGit(root, "init", "-q", "-b", "main", repo);
  for (const [path, bytes] of Object.entries(files)) putSource(repo, path, bytes);
  commitSource(repo);
  return repo;
}

export function sourceSnapshot(path: string) {
  const { ino, mode, mtimeNs } = lstatSync(path, { bigint: true });
  return { ino, mode, mtimeNs, bytes: readFileSync(path) };
}
