import { isUtf8 } from "node:buffer";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  LineCounter,
  parseDocument,
  visit,
  type Document,
  type Node,
  type YAMLMap,
  type YAMLSeq,
} from "yaml";

class PatchError extends Error {}

type Target = { node: Node; map: YAMLMap };
type ParsedPatch = {
  document: Document.Parsed;
  lines: LineCounter;
  root: YAMLSeq | null;
  targets: Target[];
};

function fail(file: string, lines: LineCounter, offset: number, reason: string): never {
  const line = Math.max(1, lines.linePos(offset).line);
  throw new PatchError(`${file}:${line}: ${reason}`);
}

function parsePatch(file: string, source: string): ParsedPatch {
  const lines = new LineCounter();
  const document = parseDocument(source, {
    keepSourceTokens: true,
    prettyErrors: false,
    lineCounter: lines,
  });
  const error = document.errors[0];
  if (error) fail(file, lines, error.pos[0], `invalid YAML (${error.code})`);
  const root = document.contents;
  const targets: Target[] = [];
  if (
    root === null ||
    (isScalar(root) && root.value === null && root.range?.[0] === root.range?.[1])
  ) {
    return { document, lines, root: null, targets };
  }
  if (!isSeq(root)) fail(file, lines, root.range?.[0] ?? 0, "expected a root patch sequence");
  for (const item of root.items) {
    if (!isNode(item)) fail(file, lines, root.range?.[0] ?? 0, "expected a mapping patch item");
    const map = isAlias(item) ? item.resolve(document) : item;
    if (!isMap(map)) fail(file, lines, item.range?.[0] ?? 0, "expected a mapping patch item");
    const id = map.get("id", true);
    const resolvedId = isAlias(id) ? id.resolve(document) : id;
    if (isScalar(resolvedId) && resolvedId.value === "shud-jobs") targets.push({ node: item, map });
  }
  if (targets.length > 1) {
    fail(file, lines, targets[1].node.range?.[0] ?? 0, "duplicate shud-jobs patch items");
  }
  // Resolve aliases without printing parser exceptions, which may contain user source text.
  try {
    document.toJS({ maxAliasCount: 100 });
  } catch {
    fail(file, lines, root.range?.[0] ?? 0, "invalid or excessive YAML alias references");
  }
  return { document, lines, root, targets };
}

function assertUnsharedTarget(file: string, parsed: ParsedPatch, target: Target): void {
  const anchors = new Set<Node>();
  visit(target.node, {
    Node(_key, node) {
      if (node.anchor) anchors.add(node);
    },
  });
  const range = target.node.range;
  if (!range) fail(file, parsed.lines, 0, "missing target source range");
  visit(parsed.document, {
    Alias(_key, alias) {
      const offset = alias.range?.[0] ?? 0;
      if (offset >= range[0] && offset < range[1]) return;
      const resolved = alias.resolve(parsed.document);
      if (resolved && anchors.has(resolved)) {
        fail(file, parsed.lines, offset, "cannot rewrite a shared shud-jobs anchor");
      }
    },
  });
}

function updatePatch(file: string, source: string, shudBin: string, stateDir: string): string {
  const parsed = parsePatch(file, source);
  const desired = { id: "shud-jobs", config: { shudBin, stateDir } };
  const serialized = JSON.stringify(desired);
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const target = parsed.targets[0];
  let rendered: string;
  if (target) {
    const value: unknown = target.map.toJS(parsed.document);
    if (isDeepStrictEqual(value, desired)) return source;
    assertUnsharedTarget(file, parsed, target);
    const range = target.node.range;
    if (!range) fail(file, parsed.lines, 0, "missing target source range");
    const old = source.slice(range[0], range[1]);
    const separator = old.endsWith("\r\n") ? "\r\n" : old.endsWith("\n") ? "\n" : "";
    rendered = source.slice(0, range[0]) + serialized + separator + source.slice(range[1]);
  } else if (parsed.root?.flow) {
    const token = parsed.root.srcToken;
    if (token?.type !== "flow-collection")
      fail(file, parsed.lines, 0, "missing flow sequence tokens");
    const close = token.end.find((part) => part.type === "flow-seq-end");
    if (!close) fail(file, parsed.lines, token.offset, "missing flow sequence terminator");
    const tail = token.items.at(-1);
    const trailingComma =
      tail?.value === undefined &&
      tail?.key === undefined &&
      tail?.start.some((part) => part.type === "comma");
    const separator = parsed.root.items.length > 0 && !trailingComma ? ", " : "";
    rendered = source.slice(0, close.offset) + separator + serialized + source.slice(close.offset);
  } else {
    // Keep all existing bytes, including trailing comments. An explicit document end stays last.
    const offset = parsed.document.directives.docEnd ? parsed.document.range[1] : source.length;
    const prefix = source.slice(0, offset);
    const separator = prefix.length > 0 && !prefix.endsWith("\n") ? newline : "";
    rendered = prefix + separator + `- ${serialized}${newline}` + source.slice(offset);
  }
  const checked = parsePatch(file, rendered);
  if (
    checked.targets.length !== 1 ||
    !isDeepStrictEqual(checked.targets[0].map.toJS(checked.document), desired)
  ) {
    fail(
      file,
      checked.lines,
      0,
      "rendered patch does not contain the requested jobs configuration",
    );
  }
  return rendered;
}

function replaceAtomically(file: string, content: string, mode: number): void {
  const temporary = join(dirname(file), `.${basename(file)}.${randomBytes(8).toString("hex")}.tmp`);
  const descriptor = openSync(temporary, "wx", mode);
  let open = true;
  let renamed = false;
  try {
    writeFileSync(descriptor, content, "utf8");
    fchmodSync(descriptor, mode);
    fsyncSync(descriptor);
    closeSync(descriptor);
    open = false;
    renameSync(temporary, file);
    renamed = true;
  } finally {
    if (open) closeSync(descriptor);
    if (!renamed) unlinkSync(temporary);
  }
}

const checking = process.argv[2] === "--check";
const [file, shudBin, stateDir] = process.argv.slice(checking ? 3 : 2);
try {
  if (!file || !shudBin || !stateDir || !isAbsolute(shudBin) || !isAbsolute(stateDir)) {
    throw new PatchError(
      "profile:install patch update requires a file and absolute shudBin/stateDir",
    );
  }
  const stats = lstatSync(file, { throwIfNoEntry: false });
  if (stats && !stats.isFile()) throw new PatchError(`${file}:1: expected a regular patch file`);
  const original = stats ? readFileSync(file) : Buffer.alloc(0);
  if (!isUtf8(original)) throw new PatchError(`${file}:1: invalid UTF-8 YAML`);
  const source = original.toString("utf8");
  const rendered = updatePatch(file, source, shudBin, stateDir);
  if (!checking && rendered !== source)
    replaceAtomically(file, rendered, stats ? stats.mode & 0o7777 : 0o600);
} catch (error) {
  if (error instanceof PatchError) console.error(error.message);
  else {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "operation failed";
    console.error(`${file ?? "profile patch"}:1: patch update failed (${code}); source suppressed`);
  }
  process.exitCode = 1;
}
