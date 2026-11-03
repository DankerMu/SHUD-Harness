import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { containsPath, type DataProvenance } from "@shud-harness/dsh-shud-core";
import { createDataProvenance } from "./workspace-records.ts";

type InputFile = DataProvenance["sources"]["files"][number];
const filenameDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// Input bytes, native error payloads and original input contents never become diagnostics.
class ProvenanceError extends Error {
  constructor(stage: string, path?: string) {
    super(`Provenance ${stage} failed${path === undefined ? "" : `: ${path}`}`);
    this.name = "ProvenanceError";
  }
}

function fileStat(path: string, stage = "input"): fs.Stats {
  try {
    return fs.lstatSync(path);
  } catch {
    throw new ProvenanceError(`${stage} stat`, path);
  }
}

function requireDirectory(path: string): void {
  if (!fileStat(path).isDirectory()) throw new ProvenanceError("input directory", path);
}

function inputNames(directory: string): string[] {
  let names: Buffer[];
  try {
    names = fs.readdirSync(directory, { encoding: "buffer" });
  } catch {
    throw new ProvenanceError("input enumeration", directory);
  }
  try {
    return names.map((name) => filenameDecoder.decode(name));
  } catch {
    throw new ProvenanceError("filename UTF-8", directory);
  }
}

async function consumeFile(
  path: string,
  stage: string,
  consume: (chunk: Buffer) => void,
): Promise<void> {
  let stream: fs.ReadStream;
  try {
    stream = fs.createReadStream(path);
  } catch {
    throw new ProvenanceError(`${stage} open`, path);
  }
  const closed = new Promise<void>((resolve) => {
    stream.once("close", resolve);
  });
  try {
    for await (const chunk of stream) {
      if (!Buffer.isBuffer(chunk)) throw new ProvenanceError(`${stage} bytes`, path);
      consume(chunk);
    }
  } catch (error) {
    if (error instanceof ProvenanceError) throw error;
    throw new ProvenanceError(`${stage} read`, path);
  } finally {
    stream.destroy();
    // End/error alone does not imply descriptor closure. Do not start another file yet.
    await closed;
  }
}

async function hashFile(path: string, entry: string, stage = "input"): Promise<InputFile> {
  const hash = createHash("sha256");
  let size = 0;
  await consumeFile(path, stage, (chunk) => {
    hash.update(chunk);
    size += chunk.length;
  });
  return { path: entry, sha256: hash.digest("hex"), size_bytes: size };
}

async function inventory(directory: string, relative: string, files: InputFile[]): Promise<void> {
  for (const name of inputNames(directory)) {
    const path = join(directory, name);
    const entry = relative === "" ? name : `${relative}/${name}`;
    const stat = fileStat(path);
    if (stat.isDirectory()) {
      await inventory(path, entry, files);
    } else if (stat.isFile()) {
      files.push(await hashFile(path, entry));
    } else {
      throw new ProvenanceError("input type", path);
    }
  }
}

async function readForcingManifest(path: string): Promise<{
  directory: string;
  references: string[];
}> {
  if (!fileStat(path, "manifest").isFile()) throw new ProvenanceError("manifest type", path);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let lineNumber = 0;
  let count = 0;
  let directory = "";
  let width = 0;
  const references: string[] = [];
  const fragments: string[] = [];

  function consumeLine(line: string): void {
    lineNumber += 1;
    if (lineNumber === 1) {
      const token = /^\s*(\S+)/u.exec(line)?.[1];
      if (token === undefined || !/^[0-9]+$/u.test(token)) {
        throw new ProvenanceError("manifest station count", path);
      }
      count = Number(token);
      if (!Number.isSafeInteger(count)) throw new ProvenanceError("manifest station count", path);
    } else if (lineNumber === 2) {
      directory = line.trim();
      if (directory === "" || directory.includes("\0")) {
        throw new ProvenanceError("manifest directory", path);
      }
    } else if (lineNumber === 3) {
      const header = line.trim().split(/\s+/u);
      if (header.at(-1) !== "Filename") throw new ProvenanceError("manifest header", path);
      width = header.length;
    } else if (line.trim() !== "") {
      const fields = line.trim().split(/\s+/u);
      const filename = fields.at(-1);
      if (fields.length !== width || filename === undefined || filename.includes("\0")) {
        throw new ProvenanceError("manifest row", path);
      }
      references.push(filename);
      if (references.length > count) throw new ProvenanceError("manifest station count", path);
    }
  }

  function decode(bytes?: Buffer): string {
    try {
      return decoder.decode(bytes, { stream: bytes !== undefined });
    } catch {
      throw new ProvenanceError("manifest UTF-8", path);
    }
  }

  function consumeText(text: string): void {
    let start = 0;
    for (let end = text.indexOf("\n"); end !== -1; end = text.indexOf("\n", start)) {
      const suffix = text.slice(start, end);
      if (fragments.length === 0) {
        consumeLine(suffix);
      } else {
        fragments.push(suffix);
        consumeLine(fragments.join(""));
        fragments.length = 0;
      }
      start = end + 1;
    }
    // Retain only an unfinished line, without repeatedly copying a growing prefix.
    if (start < text.length) fragments.push(text.slice(start));
  }

  await consumeFile(path, "manifest", (chunk) => consumeText(decode(chunk)));
  consumeText(decode());
  if (fragments.length !== 0) consumeLine(fragments.join(""));
  if (lineNumber < 3 || references.length !== count) {
    throw new ProvenanceError("manifest station count or structure", path);
  }
  return { directory, references };
}

function canonicalPath(path: string, stage: string): string {
  try {
    return fs.realpathSync.native(path);
  } catch {
    throw new ProvenanceError(`${stage} realpath`, path);
  }
}

function forcingReference(directory: string, filename: string): string {
  const reference = `${directory}/${filename}`;
  const components = filename.split("/");
  const last = components.at(-1);
  if (last === "" || last === "." || last === "..") {
    throw new ProvenanceError("forcing reference file", reference);
  }
  let current = directory;
  for (let index = 0; index < components.length; index += 1) {
    const component = components[index];
    // Leading separators retain SHUD's concatenation semantics, rather than replacing root.
    if (component === "" || component === ".") continue;
    if (component === "..") {
      current = dirname(current);
      continue;
    }
    current = `${current}/${component}`;
    const stat = fileStat(current, "forcing reference");
    if (index === components.length - 1 ? !stat.isFile() : !stat.isDirectory()) {
      throw new ProvenanceError("forcing reference type", current);
    }
  }
  return canonicalPath(current, "forcing reference");
}

async function externalForcing(
  runDir: string,
  copyRoot: string,
  project: string,
): Promise<InputFile[]> {
  const manifest = await readForcingManifest(join(copyRoot, `${project}.tsd.forc`));
  // Do not normalize away a directory alias followed by '..' before native traversal.
  const directory = canonicalPath(
    isAbsolute(manifest.directory) ? manifest.directory : `${runDir}/${manifest.directory}`,
    "forcing directory",
  );
  if (!fileStat(directory, "forcing directory").isDirectory()) {
    throw new ProvenanceError("forcing directory type", directory);
  }
  const physicalCopy = canonicalPath(copyRoot, "input root");
  const external = new Set<string>();
  for (const filename of manifest.references) {
    // Validate each spelling before deduplication, even after a good canonical duplicate.
    const path = forcingReference(directory, filename);
    if (!containsPath(physicalCopy, path)) external.add(path);
  }
  const ordered = Array.from(external, (path) => ({ path, key: Buffer.from(path, "utf8") }));
  ordered.sort((left, right) => Buffer.compare(left.key, right.key));
  const files: InputFile[] = [];
  // All references have passed preflight before any external content is opened.
  for (const { path } of ordered) files.push(await hashFile(path, path, "forcing"));
  return files;
}

/**
 * Inventory the prepared input copy after the caller's END rewrite, then parse its required
 * <project>.tsd.forc incrementally. Relative forcing directories use runDir as cwd; each
 * path-valued Filename is checked component-by-component and classified against the physical
 * copy root. Only referenced external ordinary files are hashed, without copying or writing
 * them. The caller supplies M2's physical absolute runDir and validated project component;
 * inputDir remains original absolute metadata only and need not exist.
 * One shared stream lifecycle awaits closure before reading another file. A new provenance
 * is allocated at the physical workspace grandparent only after the inventory, all reference
 * checks and hashes succeed. This is not snapshot isolation against concurrent replacement.
 */
export async function generateProvenance(
  runDir: string,
  project: string,
  inputDir: string,
): Promise<DataProvenance> {
  if (typeof runDir !== "string" || !isAbsolute(runDir)) throw new ProvenanceError("runDir");
  if (typeof inputDir !== "string" || !isAbsolute(inputDir)) throw new ProvenanceError("inputDir");
  if (typeof project !== "string") throw new ProvenanceError("project");
  const inputRoot = resolve(runDir, "input");
  const copyRoot = resolve(inputRoot, project);
  if (copyRoot === inputRoot || !containsPath(inputRoot, copyRoot)) {
    throw new ProvenanceError("project containment");
  }
  requireDirectory(runDir);
  requireDirectory(inputRoot);
  requireDirectory(copyRoot);
  const files: InputFile[] = [];
  await inventory(copyRoot, "", files);
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const externalFiles = await externalForcing(runDir, copyRoot, project);
  return createDataProvenance(dirname(dirname(runDir)), {
    basin: project,
    sources: { input_root: inputDir, files, external_files: externalFiles },
    event_window: { start: null, end: null },
    preprocess: null,
    uncertainty_notes: null,
  });
}
