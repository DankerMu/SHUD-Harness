import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { runGit } from "@shud-harness/dsh-shud-core";

export class BuildFailure extends Error {
  constructor(
    message: string,
    readonly repositoryPath?: string,
    readonly detail?: string,
  ) {
    super(message);
  }
}

export async function buildGit(
  source: string,
  argv: string[],
  stage: string,
  options: Parameters<typeof runGit>[2] = {},
) {
  try {
    return (await runGit(source, argv, options)).stdout;
  } catch (error) {
    const exit =
      error instanceof Error ? /^git failed \(exit (\d+)\)/u.exec(error.message)?.[1] : undefined;
    throw new BuildFailure(`${stage} failed${exit === undefined ? "" : ` (exit ${exit})`}`);
  }
}

/** Check ancestors before descending into the namespace after any asynchronous Git operation. */
export function directoryOwnership(paths: string[]) {
  const identities = paths.map((path) => {
    const stat = fs.lstatSync(path);
    if (!stat.isDirectory()) throw new BuildFailure("build directory ownership failed");
    return { path, dev: stat.dev, ino: stat.ino };
  });
  return () => {
    for (const expected of identities) {
      const stat = fs.lstatSync(expected.path);
      if (!stat.isDirectory() || stat.dev !== expected.dev || stat.ino !== expected.ino) {
        throw new BuildFailure("build directory ownership changed");
      }
    }
  };
}

interface ArchivedSourceEntry {
  readonly mode: string;
  readonly blob: string;
}

type ArchivedSource = ReadonlyMap<string, ArchivedSourceEntry>;

/** Hash source bytes with Git, including symlink target bytes, without buffering file contents. */
async function sourceBlob(
  repository: string,
  temporary: string,
  path: string,
  assertOwned: () => void,
) {
  const source = join(temporary, "src");
  const absolute = join(source, path);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() && !stat.isSymbolicLink()) {
    throw new BuildFailure("source entry is not an ordinary file or symlink", path);
  }
  const within = relative(fs.realpathSync.native(source), fs.realpathSync.native(absolute));
  if (isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`)) {
    throw new BuildFailure("source entry escapes archive", path);
  }
  let hashPath = absolute;
  if (stat.isSymbolicLink()) {
    hashPath = join(temporary, "symlink-blob");
    fs.writeFileSync(hashPath, fs.readlinkSync(absolute, { encoding: "buffer" }), {
      flag: "wx",
      mode: 0o600,
    });
  }
  const blob = (
    await buildGit(
      repository,
      ["hash-object", "--no-filters", "--", hashPath],
      "source blob verification",
    )
  )
    .toString("utf8")
    .trim();
  assertOwned();
  if (hashPath !== absolute) fs.unlinkSync(hashPath);
  if (!/^[0-9a-f]{40}$/u.test(blob)) {
    throw new BuildFailure("source blob verification returned an invalid identity", path);
  }
  return blob;
}

export async function extractBuildSource(
  source: string,
  commit: string,
  temporary: string,
  env: NodeJS.ProcessEnv,
  assertOwned: () => void,
): Promise<ArchivedSource> {
  const destination = join(temporary, "src");
  const listing = await buildGit(source, ["ls-tree", "-r", "-z", commit], "source tree listing");
  assertOwned();
  const expected = new Map<string, ArchivedSourceEntry>();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const records = decoder.decode(listing).split("\0");
  if (records.pop() !== "") throw new BuildFailure("source tree listing is incomplete");
  for (const record of records) {
    const match = /^(100644|100755|120000) blob ([0-9a-f]{40})\t([\s\S]+)$/u.exec(record);
    if (!match) throw new BuildFailure("source tree contains an unsupported entry type");
    const [, mode, blob, path] = match;
    if (
      !mode ||
      !blob ||
      !path ||
      isAbsolute(path) ||
      path
        .split("/")
        .some((part) => part === ".." || part === "." || part === ".git" || part === "")
    ) {
      throw new BuildFailure("source tree contains an unsafe path");
    }
    expected.set(path, { mode, blob });
  }
  const archive = await buildGit(source, ["archive", "--format=tar", commit], "source archive");
  assertOwned();
  const extraction = spawnSync("tar", ["-x", "-C", destination], {
    input: archive,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (extraction.error || extraction.status !== 0) {
    throw new BuildFailure(
      `archive extraction failed (exit ${extraction.status ?? "unavailable"})`,
    );
  }
  assertOwned();
  const leaves: Array<{ path: string; mode: string }> = [];
  function walk(directory: string, prefix: string) {
    for (const name of fs.readdirSync(directory)) {
      const absolute = join(directory, name);
      const path = prefix ? `${prefix}/${name}` : name;
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) walk(absolute, path);
      else if (stat.isFile() || stat.isSymbolicLink()) {
        leaves.push({
          path,
          mode: stat.isSymbolicLink() ? "120000" : (stat.mode & 0o111) !== 0 ? "100755" : "100644",
        });
      } else {
        throw new BuildFailure(
          "archive entry type mismatch",
          expected.has(path) ? path : undefined,
          expected.has(path) ? undefined : path,
        );
      }
    }
  }
  walk(destination, "");
  const extracted = new Set(leaves.map((leaf) => leaf.path));
  for (const path of expected.keys()) {
    if (!extracted.has(path)) {
      throw new BuildFailure("archive is missing a source tree path", path);
    }
  }
  for (const leaf of leaves) {
    const entry = expected.get(leaf.path);
    if (!entry)
      throw new BuildFailure("archive contains an unexpected entry", undefined, leaf.path);
    if (entry.mode !== leaf.mode) {
      throw new BuildFailure("archive entry mismatch", leaf.path);
    }
    const blob = await sourceBlob(source, temporary, leaf.path, assertOwned);
    if (blob !== entry.blob) throw new BuildFailure("archive blob mismatch", leaf.path);
  }
  return expected;
}

/** Apply only the bytes admitted before reservation; never reread the workspace patch. */
export async function applyBuildPatch(
  repository: string,
  temporary: string,
  patch: Buffer,
  paths: string[],
  archived: ArchivedSource,
  assertOwned: () => void,
) {
  const source = join(temporary, "src");
  for (const path of paths) {
    if (!archived.has(path)) {
      throw new BuildFailure("patch target is missing from verified source tree", path);
    }
  }
  const patchPath = resolve(temporary, "change.patch");
  fs.writeFileSync(patchPath, patch, { flag: "wx", mode: 0o600 });
  const options = { applyCeiling: fs.realpathSync.native(temporary) };
  await buildGit(source, ["apply", "--check", patchPath], "patch check", options);
  assertOwned();
  await buildGit(source, ["apply", patchPath], "patch application", options);
  assertOwned();
  for (const path of paths) {
    const blob = await sourceBlob(repository, temporary, path, assertOwned);
    if (blob === archived.get(path)?.blob) {
      throw new BuildFailure("patch did not take effect", path);
    }
  }
}
