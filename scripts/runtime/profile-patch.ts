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
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import type { Config } from "../../packages/dsh-shud-jobs/src/registry.ts";
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

type Target = { id: string; node: Node; map: YAMLMap };
type ParsedPatch = {
  document: Document.Parsed;
  lines: LineCounter;
  root: YAMLSeq | null;
  targets: Target[];
};
type JobsPatch = { id: "shud-jobs"; config: Config };
type OwnedPatch = JobsPatch | { id: "preset-coordinator" | "preset-worker"; disabled: true };
// Read Loader expressions as inert metadata; only the runtime Loader evaluates them.
const inertTags = [{ tag: "tag:yaml.org,2002:js", resolve: (source: string) => source }];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sourceText(value: unknown, key: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PatchError(`profile:install ${key} must be a nonempty string`);
  }
  return value;
}

function existingDirectory(path: string, key: string): string {
  if (isAbsolute(path)) {
    try {
      if (statSync(path).isDirectory()) return path;
    } catch {
      // Report the configured source, never an arbitrary filesystem error payload.
    }
  }
  throw new PatchError(`profile:install ${key} must name an existing absolute directory`);
}

function modelValue(rows: unknown, id: string, key: string): string {
  const matches = Array.isArray(rows)
    ? rows.filter((row: unknown) => isObject(row) && row.id === id)
    : [];
  const row: unknown = matches[0];
  if (matches.length !== 1 || !isObject(row) || !isObject(row.config)) {
    throw new PatchError(`profile:install bundle ${id}.config is missing or ambiguous`);
  }
  return sourceText(row.config[key], `bundle ${id}.config.${key}`);
}

function installationConfig(shudBin: string, stateDir: string): Config {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const stackRepos = {
    SHUD: join(root, "SHUD"),
    rSHUD: join(root, "rSHUD"),
    AutoSHUD: join(root, "AutoSHUD"),
  };
  for (const path of Object.values(stackRepos)) existingDirectory(path, path);
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(join(root, "profile/shud/package.json"), "utf8"));
  } catch {
    throw new PatchError("profile:install cannot read bundle package.json");
  }
  const peers =
    isObject(manifest) && isObject(manifest.peerDependencies) ? manifest.peerDependencies : {};
  const hostVersion = sourceText(peers["@deepseek-ai/dsh"], "bundle peer @deepseek-ai/dsh");
  let rows: unknown;
  try {
    const document = parseDocument(
      readFileSync(join(root, "profile/shud/cordis.patch.yml"), "utf8"),
      {
        prettyErrors: false,
        merge: false,
        schema: "core",
        customTags: inertTags,
      },
    );
    if (document.errors.length) throw new PatchError("invalid bundle YAML");
    rows = document.toJS({ maxAliasCount: 100 });
  } catch {
    throw new PatchError("profile:install cannot read bundle cordis.patch.yml");
  }
  const llm = {
    base_url: modelValue(rows, "llm-deepseek", "baseURL"),
    request_alias: modelValue(rows, "agent-default-model", "model"),
  };
  const sundials = process.env.SUNDIALS_ROOT;
  return {
    shudBin,
    stateDir,
    stackRepos,
    hostVersion,
    llm,
    ...(sundials === undefined
      ? {}
      : { sundialsRoot: existingDirectory(sundials, "SUNDIALS_ROOT") }),
  };
}

function fail(file: string, lines: LineCounter, offset: number, reason: string): never {
  const line = Math.max(1, lines.linePos(offset).line);
  throw new PatchError(`${file}:${line}: ${reason}`);
}

function parsePatch(file: string, source: string, ids: readonly string[]): ParsedPatch {
  const lines = new LineCounter();
  const document = parseDocument(source, {
    keepSourceTokens: true,
    prettyErrors: false,
    merge: false,
    schema: "core",
    customTags: inertTags,
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
    if (
      isScalar(resolvedId) &&
      typeof resolvedId.value === "string" &&
      ids.includes(resolvedId.value)
    ) {
      const id = resolvedId.value;
      if (targets.some((target) => target.id === id)) {
        fail(file, lines, item.range?.[0] ?? 0, `duplicate ${id} patch items`);
      }
      targets.push({ id, node: item, map });
    }
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
        fail(file, parsed.lines, offset, `cannot rewrite a shared ${target.id} anchor`);
      }
    },
  });
}

function insertFlow(
  file: string,
  parsed: ParsedPatch,
  source: string,
  collection: YAMLMap | YAMLSeq,
  item: string,
): string {
  const token = collection.srcToken;
  const kind = isSeq(collection) ? "sequence" : "mapping";
  if (token?.type !== "flow-collection") fail(file, parsed.lines, 0, `missing flow ${kind} tokens`);
  const close = token.end.find(
    (part) => part.type === (isSeq(collection) ? "flow-seq-end" : "flow-map-end"),
  );
  if (!close) fail(file, parsed.lines, token.offset, `missing flow ${kind} terminator`);
  const tail = token.items.at(-1);
  const trailingComma =
    tail?.value === undefined &&
    tail?.key === undefined &&
    tail?.start.some((part) => part.type === "comma");
  const separator = collection.items.length > 0 && !trailingComma ? ", " : "";
  return source.slice(0, close.offset) + separator + item + source.slice(close.offset);
}

function updatePatch(
  file: string,
  source: string,
  desired: OwnedPatch,
  ids: readonly string[],
): string {
  const parsed = parsePatch(file, source, ids);
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const target = parsed.targets.find((target) => target.id === desired.id);
  const value: unknown = target?.map.toJS(parsed.document);
  const expected =
    desired.id === "shud-jobs" ? desired : { ...(isObject(value) ? value : {}), ...desired };
  if (target && isDeepStrictEqual(value, expected)) return source;
  const serialized = JSON.stringify(expected);
  let rendered: string;
  if (target) {
    assertUnsharedTarget(file, parsed, target);
    const range = target.node.range;
    if (!range) fail(file, parsed.lines, 0, "missing target source range");
    if (desired.id === "shud-jobs") {
      const old = source.slice(range[0], range[1]);
      const separator = old.endsWith("\r\n") ? "\r\n" : old.endsWith("\n") ? "\n" : "";
      rendered = source.slice(0, range[0]) + serialized + separator + source.slice(range[1]);
    } else {
      // Preset ownership is one field: retain every other token, tag, alias and comment.
      if (isAlias(target.node))
        fail(file, parsed.lines, range[0], `cannot rewrite an aliased ${desired.id} target`);
      const fields = target.map.items.filter((pair) => {
        const key = isAlias(pair.key) ? pair.key.resolve(parsed.document) : pair.key;
        return isScalar(key) && key.value === "disabled";
      });
      if (fields.length > 1)
        fail(file, parsed.lines, range[0], `ambiguous ${desired.id} disabled field`);
      if (fields.length === 1) {
        const field = fields[0].value;
        if (!isNode(field) || !field.range)
          fail(file, parsed.lines, range[0], "missing disabled source range");
        rendered = source.slice(0, field.range[0]) + "true" + source.slice(field.range[1]);
      } else if (target.map.flow) {
        rendered = insertFlow(file, parsed, source, target.map, "disabled: true");
      } else {
        const token = target.map.srcToken;
        if (token?.type !== "block-map")
          fail(file, parsed.lines, range[0], "missing block mapping tokens");
        const offset = range[2],
          prefix = source.slice(0, offset);
        const separator = prefix.endsWith("\n") ? "" : newline;
        rendered =
          prefix +
          separator +
          `${" ".repeat(token.indent)}disabled: true${newline}` +
          source.slice(offset);
      }
    }
  } else if (parsed.root?.flow) {
    rendered = insertFlow(file, parsed, source, parsed.root, serialized);
  } else {
    // Keep all existing bytes, including trailing comments. An explicit document end stays last.
    const offset = parsed.document.directives.docEnd ? parsed.document.range[1] : source.length;
    const prefix = source.slice(0, offset);
    const separator = prefix.length > 0 && !prefix.endsWith("\n") ? newline : "";
    const token = parsed.root?.srcToken;
    if (parsed.root && token?.type !== "block-seq") {
      fail(file, parsed.lines, offset, "missing block sequence tokens");
    }
    const indentation = token?.type === "block-seq" ? " ".repeat(token.indent) : "";
    rendered =
      prefix + separator + `${indentation}- ${serialized}${newline}` + source.slice(offset);
  }
  const checked = parsePatch(file, rendered, ids);
  const updated = checked.targets.find((target) => target.id === desired.id);
  if (!updated || !isDeepStrictEqual(updated.map.toJS(checked.document), expected)) {
    fail(
      file,
      checked.lines,
      0,
      `rendered patch does not contain the requested ${desired.id} configuration`,
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
  const desired: OwnedPatch[] = [
    { id: "shud-jobs", config: installationConfig(shudBin, stateDir) },
  ];
  if (process.env.PROFILE_TEMPLATE === "headless") {
    desired.push(
      { id: "preset-coordinator", disabled: true },
      { id: "preset-worker", disabled: true },
    );
  }
  const stats = lstatSync(file, { throwIfNoEntry: false });
  if (stats && !stats.isFile()) throw new PatchError(`${file}:1: expected a regular patch file`);
  const original = stats ? readFileSync(file) : Buffer.alloc(0);
  if (!isUtf8(original)) throw new PatchError(`${file}:1: invalid UTF-8 YAML`);
  const source = original.toString("utf8");
  const ids = desired.map((item) => item.id);
  if (desired.length > 1) {
    // Headless ownership requires safe targets even when their values already match.
    const parsed = parsePatch(file, source, ids);
    for (const target of parsed.targets) {
      if (isAlias(target.node)) {
        fail(
          file,
          parsed.lines,
          target.node.range?.[0] ?? 0,
          `cannot rewrite an aliased ${target.id} target`,
        );
      }
      assertUnsharedTarget(file, parsed, target);
    }
  }
  // Validate every target and complete all range edits in memory before the one publication.
  const rendered = desired.reduce((source, item) => updatePatch(file, source, item, ids), source);
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
