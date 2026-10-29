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

function inputStat(path: string): fs.Stats {
  try {
    return fs.lstatSync(path);
  } catch {
    throw new ProvenanceError("input stat", path);
  }
}

function requireDirectory(path: string): void {
  if (!inputStat(path).isDirectory()) throw new ProvenanceError("input directory", path);
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

async function hashInput(path: string, relative: string): Promise<InputFile> {
  let stream: fs.ReadStream;
  try {
    stream = fs.createReadStream(path);
  } catch {
    throw new ProvenanceError("input open", path);
  }
  const closed = new Promise<void>((resolve) => {
    stream.once("close", resolve);
  });
  const hash = createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of stream) {
      // The stream has no text encoding: every consumed chunk contributes its actual bytes.
      if (!Buffer.isBuffer(chunk)) throw new ProvenanceError("input bytes", path);
      hash.update(chunk);
      size += chunk.length;
    }
  } catch {
    throw new ProvenanceError("input read", path);
  } finally {
    stream.destroy();
    // End/error alone does not imply descriptor closure. Do not start another input yet.
    await closed;
  }
  return { path: relative, sha256: hash.digest("hex"), size_bytes: size };
}

async function inventory(directory: string, relative: string, files: InputFile[]): Promise<void> {
  for (const name of inputNames(directory)) {
    const path = join(directory, name);
    const entry = relative === "" ? name : `${relative}/${name}`;
    const stat = inputStat(path);
    if (stat.isDirectory()) {
      await inventory(path, entry, files);
    } else if (stat.isFile()) {
      files.push(await hashInput(path, entry));
    } else {
      throw new ProvenanceError("input type", path);
    }
  }
}

/**
 * Inventory only the prepared run's input copy, after the caller's END rewrite. The caller
 * supplies M2's physical absolute run directory and validated project component; inputDir is
 * original absolute metadata only and need not exist. No project grammar or solver parsing
 * is duplicated here. Links/special files and unrepresentable filename bytes fail closed.
 * Reads are incremental with one active file at a time. A new provenance is allocated only
 * after complete inventory, at the physical run directory's workspace grandparent. This is
 * not snapshot isolation against concurrent input replacement or modification.
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
  return createDataProvenance(dirname(dirname(runDir)), {
    basin: project,
    sources: { input_root: inputDir, files },
    event_window: { start: null, end: null },
    preprocess: null,
    uncertainty_notes: null,
  });
}
