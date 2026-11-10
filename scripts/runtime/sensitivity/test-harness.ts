import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOCATOR_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
];

/** Requires host git, PATH and HOME; absence fails the test rather than skipping it. */
export function git(directory: string, ...args: string[]): string {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  for (const name of LOCATOR_VARS) delete env[name];
  return execFileSync(
    "git",
    [
      "-C",
      directory,
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.invalid",
      ...args,
    ],
    { env, encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

export function hash(algorithm: "md5" | "sha256", bytes: Buffer): string {
  return createHash(algorithm).update(bytes).digest("hex");
}

/** POSIX relative file list, code-unit sorted, independent of the implementation's walk. */
export function fileList(directory: string): string[] {
  return fs
    .readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter((name) => fs.lstatSync(join(directory, name)).isFile())
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

export function fileHashes(directory: string, algorithm: "md5" | "sha256") {
  return Object.fromEntries(
    fileList(directory).map((name) => [
      name,
      hash(algorithm, fs.readFileSync(join(directory, name))),
    ]),
  );
}

export const SOURCE_FILES: Record<string, Buffer> = {
  "ccw.cfg.calib": Buffer.from("GEOL_KSATH\t1\r\nLC_ROUGH\t1\r\n"),
  "ccw.cfg.para": Buffer.from("START\t0\nEND\t1826\nNUM_OPENMP\t4\n"),
  "ccw.sp.att": Buffer.from([0, 255, 13, 10, 32, 128]),
  "forcing/ccw.tsd.forc": Buffer.from("1 20000101\n/forcing\n"),
  "forcing/nested/x1.csv": Buffer.from("Time,Prcp\n0,0.1\n"),
};

export interface SensitivityHarness {
  root: string;
  source: string;
  shudBin: string;
  dshHome: string;
  workspace: string;
  evidence: string;
  record: string;
  env: NodeJS.ProcessEnv;
  heads(): Record<"SHUD" | "rSHUD" | "AutoSHUD", string>;
  dispose(): void;
}

/** Initialise and commit `directory` (README only plus whatever already lies there). */
export function commitRepository(directory: string): void {
  fs.mkdirSync(directory, { recursive: true });
  git(directory, "init", "-q");
  fs.writeFileSync(join(directory, "README"), `${directory}\n`);
  git(directory, "add", "-A");
  git(directory, "commit", "-q", "-m", "fixture");
}

/**
 * Constructed harness root: three committed repositories and a nested ccw source; never the real
 * SHUD. Workspace and evidence live in a sibling scratch directory outside the harness root.
 */
export function makeSensitivityHarness(options: { source?: boolean } = {}): SensitivityHarness {
  const top = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "shud-sensitivity-")));
  const root = join(top, "harness");
  const scratch = join(top, "scratch");
  fs.mkdirSync(root);
  fs.mkdirSync(scratch);
  const source = join(root, "SHUD/input/ccw");
  for (const name of ["rSHUD", "AutoSHUD"]) commitRepository(join(root, name));
  fs.mkdirSync(join(root, "SHUD"));
  if (options.source !== false)
    for (const [name, bytes] of Object.entries(SOURCE_FILES)) {
      fs.mkdirSync(join(source, name, ".."), { recursive: true });
      fs.writeFileSync(join(source, name), bytes);
    }
  commitRepository(join(root, "SHUD"));
  const shudBin = join(root, "bin/shud");
  fs.mkdirSync(join(root, "bin"));
  fs.writeFileSync(shudBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const dshHome = join(root, "dsh-home");
  fs.mkdirSync(dshHome);
  fs.writeFileSync(join(dshHome, "sentinel"), "untouched\n");
  const evidence = join(scratch, "evidence");
  fs.mkdirSync(evidence);
  return {
    root,
    source,
    shudBin,
    dshHome,
    workspace: join(scratch, "workspace"),
    evidence,
    record: join(evidence, "preparation.json"),
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DSH_HOME: dshHome,
      SHUD_BIN: shudBin,
      DMXAPI_KEY: "fixture-key",
    },
    heads() {
      return {
        SHUD: git(join(root, "SHUD"), "rev-parse", "HEAD"),
        rSHUD: git(join(root, "rSHUD"), "rev-parse", "HEAD"),
        AutoSHUD: git(join(root, "AutoSHUD"), "rev-parse", "HEAD"),
      };
    },
    dispose() {
      fs.rmSync(top, { recursive: true, force: true });
    },
  };
}
