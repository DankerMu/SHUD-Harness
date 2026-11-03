import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import type { BuildDirectoryProducer } from "@shud-harness/dsh-shud-records";
import type { ChangeId, TaskId } from "@shud-harness/dsh-shud-core";
import {
  applyBuildPatch,
  BuildFailure,
  directoryOwnership,
  extractBuildSource,
} from "./archive.ts";

const PRODUCER_FILES = ["make.stderr.log", "make.stdout.log", "shud"] as const;

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface MakeLog extends FileIdentity {
  readonly path: string;
  readonly name: "make.stdout.log" | "make.stderr.log";
  postMakeSha256: string | null;
}

function capturedLog(fd: number, path: string, name: MakeLog["name"]): MakeLog {
  const stat = fs.fstatSync(fd);
  if (!stat.isFile()) throw new BuildFailure(`${name} is not an ordinary file`);
  return { path, name, dev: stat.dev, ino: stat.ino, postMakeSha256: null };
}

function assertLogIdentity(log: MakeLog) {
  let stat: fs.Stats | undefined;
  try {
    stat = fs.lstatSync(log.path);
  } catch {
    // Missing or unreadable evidence is rejected without exposing native causes.
  }
  if (!stat?.isFile() || stat.dev !== log.dev || stat.ino !== log.ino) {
    throw new BuildFailure(`${log.name} identity changed`);
  }
}

function logTail(path: string): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      path,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return "";
    const size = Math.min(stat.size, 16_384);
    const bytes = Buffer.alloc(size);
    const read = fs.readSync(fd, bytes, 0, size, stat.size - size);
    const text = bytes.subarray(0, read).toString("utf8");
    return stat.size > size ? text.slice(text.indexOf("\n") + 1) : text;
  } catch {
    return "";
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function redact(
  text: string,
  temporary: string,
  relativeTemporary: string,
  childEnvironment: NodeJS.ProcessEnv,
): string {
  let safe = text
    .replaceAll(temporary, "[build temporary]")
    .replaceAll(relativeTemporary, "[build temporary]");
  const values = [
    ...new Set(
      [...Object.values(process.env), ...Object.values(childEnvironment)].filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      ),
    ),
  ];
  for (const value of values.sort((left, right) => right.length - left.length)) {
    safe = safe.replaceAll(value, "[redacted]");
  }
  return safe;
}

async function hashProducerFile(
  path: string,
  subject: "copied binary" | MakeLog["name"],
  identity?: FileIdentity,
): Promise<string> {
  const fd = fs.openSync(
    path,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new BuildFailure(`${subject} is not an ordinary file`);
    if (identity !== undefined && (stat.dev !== identity.dev || stat.ino !== identity.ino)) {
      throw new BuildFailure(`${subject} identity changed`);
    }
    const hash = createHash("sha256");
    hash.setEncoding("hex");
    await pipeline(fs.createReadStream(path, { fd, autoClose: false }), hash);
    const digest: unknown = hash.read();
    if (typeof digest !== "string") throw new BuildFailure(`${subject} digest is unavailable`);
    return digest;
  } finally {
    fs.closeSync(fd);
  }
}

function validatePublicationFiles(temporary: string) {
  const names = fs.readdirSync(temporary).sort();
  if (
    names.length !== PRODUCER_FILES.length ||
    names.some((name, index) => name !== PRODUCER_FILES[index])
  ) {
    throw new BuildFailure(
      "build publication inventory must contain exactly shud and two make logs",
    );
  }
  for (const name of PRODUCER_FILES) {
    const path = join(temporary, name);
    const stat = fs.lstatSync(path);
    if (!stat.isFile()) {
      throw new BuildFailure(`build publication ${name} is not an ordinary file`);
    }
    if (name === "shud") {
      if ((stat.mode & 0o111) === 0) {
        throw new BuildFailure(
          "make exited 0 but copied shud is not executable before publication",
        );
      }
      try {
        fs.accessSync(path, fs.constants.X_OK);
      } catch {
        throw new BuildFailure("make exited 0 but copied shud executable permission denied");
      }
    }
  }
}

export function buildProducer(input: {
  cwd: string;
  source: string;
  commit: string;
  branch: string;
  taskId: TaskId;
  sundialsRoot: string;
  rhsOpenmp: boolean;
  change: {
    changeId: ChangeId;
    patchSha256: string;
    paths: string[];
    patch: Buffer;
  } | null;
  env: NodeJS.ProcessEnv;
  diagnostic(message: string): void;
}): BuildDirectoryProducer {
  return async (temporary, buildId) => {
    const started = performance.now();
    const relativeTemporary = `builds/.tmp-${buildId}`;
    const src = join(temporary, "src");
    const stdout = join(temporary, "make.stdout.log");
    const stderr = join(temporary, "make.stderr.log");
    let stage = "build directory preparation";
    const assertPublicationOwned = directoryOwnership([dirname(temporary), temporary]);
    let assertOwned = assertPublicationOwned;
    try {
      fs.mkdirSync(src);
      assertOwned = directoryOwnership([dirname(temporary), temporary, src]);
      stage = "archive integrity";
      const archived = await extractBuildSource(
        input.source,
        input.commit,
        temporary,
        input.env,
        assertOwned,
      );
      assertOwned();
      if (input.change !== null) {
        stage = "patch application";
        await applyBuildPatch(
          input.source,
          temporary,
          input.change.patch,
          input.change.paths,
          archived,
          assertOwned,
        );
        assertOwned();
      }
      const variables = [
        `SUNDIALS_DIR=${input.sundialsRoot}`,
        ...(input.rhsOpenmp ? ["SHUD_ENABLE_OPENMP_RHS=1"] : []),
      ];
      const makeArgv = ["make", "-C", `${relativeTemporary}/src`, "shud", ...variables];
      stage = "make";
      let out: number | undefined;
      let err: number | undefined;
      const logs: MakeLog[] = [];
      try {
        out = fs.openSync(stdout, "wx", 0o600);
        logs.push(capturedLog(out, stdout, "make.stdout.log"));
        err = fs.openSync(stderr, "wx", 0o600);
        logs.push(capturedLog(err, stderr, "make.stderr.log"));
        const result = spawnSync("make", makeArgv.slice(1), {
          cwd: input.cwd,
          env: input.env,
          stdio: ["ignore", out, err],
        });
        if (result.error || result.status !== 0) {
          throw new BuildFailure(
            `make failed (exit ${result.status ?? "unavailable"}${result.signal ? `, signal ${result.signal}` : ""})`,
          );
        }
      } finally {
        try {
          if (err !== undefined) fs.closeSync(err);
        } finally {
          if (out !== undefined) fs.closeSync(out);
        }
      }
      assertOwned();
      for (const log of logs) assertLogIdentity(log);
      stage = "executable validation";
      const binary = join(src, "shud");
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(binary);
      } catch {
        throw new BuildFailure("make exited 0 but shud executable validation failed");
      }
      if (!stat.isFile() || (stat.mode & 0o111) === 0) {
        throw new BuildFailure("make exited 0 but shud is not an ordinary executable");
      }
      try {
        fs.accessSync(binary, fs.constants.X_OK);
      } catch {
        throw new BuildFailure("make exited 0 but shud executable permission denied");
      }
      const copiedBinary = join(temporary, "shud");
      fs.copyFileSync(binary, copiedBinary, fs.constants.COPYFILE_EXCL);
      try {
        fs.accessSync(copiedBinary, fs.constants.X_OK);
      } catch {
        throw new BuildFailure("make exited 0 but copied shud executable permission denied");
      }
      stage = "binary hashing";
      const binarySha = await hashProducerFile(copiedBinary, "copied binary");
      assertOwned();
      // Main make owns writes to these descriptors; freeze content only after it exits.
      for (const log of logs) {
        stage = `${log.name} evidence hashing`;
        assertLogIdentity(log);
        log.postMakeSha256 = await hashProducerFile(log.path, log.name, log);
        assertOwned();
        assertLogIdentity(log);
      }
      stage = "compiler selection";
      const probe = join(temporary, "print-cxx.mk");
      fs.writeFileSync(probe, ".PHONY: print-cxx\nprint-cxx:\n\t@printf '%s\\n' '$(CXX)'\n", {
        flag: "wx",
        mode: 0o600,
      });
      const selected = spawnSync(
        "make",
        [
          "-s",
          "-C",
          `${relativeTemporary}/src`,
          "-f",
          "Makefile",
          "-f",
          resolve(probe),
          "print-cxx",
          ...variables,
        ],
        {
          cwd: input.cwd,
          env: input.env,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      if (selected.error || selected.status !== 0) {
        throw new BuildFailure(
          `compiler selection failed (exit ${selected.status ?? "unavailable"})`,
        );
      }
      const compilerCommand = selected.stdout.trim();
      if (!compilerCommand || /\s/u.test(compilerCommand) || compilerCommand.includes("\0")) {
        throw new BuildFailure(
          "compiler selection exited 0 but requires a nonempty single-word CXX",
        );
      }
      stage = "compiler version";
      const version = spawnSync(compilerCommand, ["--version"], {
        cwd: src,
        env: input.env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const compiler = version.stdout?.split(/\r?\n/u)[0];
      if (version.error || version.status !== 0 || !compiler?.trim()) {
        throw new BuildFailure(`compiler version failed (exit ${version.status ?? "unavailable"})`);
      }
      assertOwned();
      stage = "build transient cleanup";
      fs.unlinkSync(probe);
      if (input.change !== null) fs.unlinkSync(join(temporary, "change.patch"));
      fs.rmSync(src, { recursive: true });
      // Keep the original parent/reservation identities; src is intentionally gone.
      assertOwned = assertPublicationOwned;
      assertOwned();
      stage = "build publication validation";
      validatePublicationFiles(temporary);
      for (const log of logs) {
        stage = `${log.name} evidence validation`;
        assertLogIdentity(log);
        const digest = await hashProducerFile(log.path, log.name, log);
        assertOwned();
        assertLogIdentity(log);
        if (digest !== log.postMakeSha256) {
          throw new BuildFailure(`${log.name} changed after main make`);
        }
      }
      stage = "build publication validation";
      const finalSha = await hashProducerFile(copiedBinary, "copied binary");
      assertOwned();
      validatePublicationFiles(temporary);
      for (const log of logs) assertLogIdentity(log);
      if (finalSha !== binarySha) {
        throw new BuildFailure("copied binary changed after its initial digest");
      }
      return {
        build_id: buildId,
        task_id: input.taskId,
        change_id: input.change?.changeId ?? null,
        patch_sha256: input.change?.patchSha256 ?? null,
        source_path: "repos/SHUD",
        source_commit: input.commit,
        source_branch: input.branch,
        dirty_paths: input.change?.paths ?? [],
        make_argv: makeArgv,
        sundials_dir: input.sundialsRoot,
        rhs_openmp: input.rhsOpenmp,
        compiler,
        exit_code: 0,
        duration_seconds: (performance.now() - started) / 1000,
        binary_path: `builds/${buildId}/shud`,
        binary_sha256: binarySha,
        stdout_path: `builds/${buildId}/make.stdout.log`,
        stderr_path: `builds/${buildId}/make.stderr.log`,
        created_at: new Date().toISOString(),
      };
    } catch (error) {
      let tail = "";
      try {
        assertOwned();
        tail = [logTail(stdout), logTail(stderr)]
          .join("\n")
          .trim()
          .split(/\r?\n/u)
          .slice(-40)
          .join("\n");
      } catch {
        // Never read logs through a namespace whose ownership has changed.
      }
      const reason = error instanceof BuildFailure ? error.message : `${stage} failed`;
      // These paths were validated against the repository tree or admitted CR, not
      // copied from subprocess output. Environment substrings must not corrupt them.
      const repositoryPath = error instanceof BuildFailure ? error.repositoryPath : undefined;
      const location = repositoryPath === undefined ? "" : `: ${repositoryPath}`;
      const detail = error instanceof BuildFailure ? error.detail : undefined;
      const untrusted = [detail, tail].filter(Boolean).join("\n");
      input.diagnostic(
        `${reason}${location}${untrusted ? `\n${redact(untrusted, temporary, relativeTemporary, input.env)}` : ""}`,
      );
      throw new BuildFailure("build producer failed");
    }
  };
}
