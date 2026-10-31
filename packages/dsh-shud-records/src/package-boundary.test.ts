import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { StackLockSchema } from "@shud-harness/dsh-shud-core";
import { expect, test } from "vitest";

// Uses the normal build-first contract; never rebuild shared lib output inside Vitest.
test("relocated records captures the canonical harness version and persists a valid lock", () => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "records-package-boundary-")));
  try {
    const checkout = fs.realpathSync(fileURLToPath(new URL("../../../", import.meta.url)));
    expect(relative(checkout, root).split(sep)[0]).toBe("..");
    const source = join(checkout, "packages", "dsh-shud-records");
    const copied = join(root, "packages", "records");
    const cwd = join(root, "workspace");
    fs.mkdirSync(copied, { recursive: true });
    fs.mkdirSync(cwd);
    for (const name of ["lib", "templates", "package.json"]) {
      fs.cpSync(join(source, name), join(copied, name), { recursive: true });
    }
    const dependencies = join(copied, "node_modules", "@shud-harness");
    fs.mkdirSync(dependencies, { recursive: true });
    fs.symlinkSync(
      join(checkout, "packages", "dsh-shud-core"),
      join(dependencies, "dsh-shud-core"),
      "dir",
    );

    const canonical = JSON.parse(fs.readFileSync(join(checkout, "package.json"), "utf8")) as {
      version: string;
    };
    const manifestPath = join(copied, "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    const packageVersion = "0.0.0-records-boundary";
    const cwdVersion = "0.0.0-cwd-boundary";
    expect(canonical.version).not.toBe(packageVersion);
    expect(canonical.version).not.toBe(cwdVersion);
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: packageVersion }));
    fs.writeFileSync(join(cwd, "package.json"), JSON.stringify({ version: cwdVersion }));
    // The old lib/capture-stack-lock.js ancestor import resolves here, not to either decoy.
    expect(fs.existsSync(join(root, "package.json"))).toBe(false);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: devNull,
      GIT_CONFIG_NOSYSTEM: "1",
      XDG_CONFIG_HOME: join(root, "no-xdg-config"),
      GIT_AUTHOR_DATE: "2026-10-27T08:00:00Z",
      GIT_COMMITTER_DATE: "2026-10-27T08:00:00Z",
    };
    for (const key of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_COMMON_DIR",
      "GIT_NAMESPACE",
      "GIT_CONFIG",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_PARAMETERS",
      "NODE_OPTIONS",
      "NODE_PATH",
    ]) {
      delete env[key];
    }
    function git(directory: string, ...args: string[]): string {
      return execFileSync("git", ["-C", directory, "-c", `core.hooksPath=${devNull}`, ...args], {
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5000,
        killSignal: "SIGKILL",
      }).trim();
    }
    const repo = join(root, "model-repo");
    git(root, "init", "-q", "-b", "main", repo);
    fs.writeFileSync(join(repo, "model.txt"), "package-boundary model bytes\n");
    git(repo, "add", "model.txt");
    git(
      repo,
      "-c",
      "user.name=Capture fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "-qm",
      "fixture",
    );
    const commit = git(repo, "rev-parse", "HEAD");
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
          // Exercise module linking at a temporary public-entry URL selected by the parent.
          const { captureStackLock, readWorkspaceRecord } = await import(process.argv[1]);
          const repo = process.argv[2];
          const captured = captureStackLock({
            cwd: process.cwd(),
            stackRepos: { SHUD: repo, rSHUD: repo, AutoSHUD: repo },
            hostVersion: "fixture-host-0.2.1",
            llm: { base_url: "https://capture.example.invalid/v1", request_alias: "requested-alias" },
          }, { response_model: "configured-response" });
          const persisted = readWorkspaceRecord(process.cwd(), "stack", captured.stack_id);
          process.stdout.write(JSON.stringify({ captured, persisted }));
        `,
        pathToFileURL(join(copied, "lib", "index.js")).href,
        repo,
      ],
      { cwd, env, encoding: "utf8", timeout: 10000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.signal, result.stderr).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as { captured: unknown; persisted: unknown };
    const captured = StackLockSchema.parse(output.captured);
    expect(captured.harness).toEqual({ version: canonical.version });
    expect(StackLockSchema.parse(output.persisted)).toEqual(captured);
    expect(
      JSON.parse(fs.readFileSync(join(cwd, "stacks", `${captured.stack_id}.json`), "utf8")),
    ).toEqual(captured);
    for (const name of ["SHUD", "rSHUD", "AutoSHUD"] as const) {
      expect(captured.repos[name]).toEqual({
        commit,
        branch: "main",
        dirty: false,
        dirty_paths: [],
        dirty_paths_truncated: false,
      });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 40000);
