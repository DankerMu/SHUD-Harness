import { realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

type RawGuardCall = { name: string; arguments: unknown; cwd?: string };
type RawGuardDecision = {
  kind: "deny" | "ask" | "next";
  code: string;
  reason?: string;
  displayReason?: { en: string; zh: string };
};
const DENY: RawGuardDecision = {
  kind: "deny",
  code: "raw-immutable",
  reason:
    "Raw data is immutable. Use the read tool to read raw data; write derived data in the workspace.",
};
const NEXT: RawGuardDecision = { kind: "next", code: "unrelated" };
export const RAW_READ_PROVENANCE_REASON =
  "Reading raw data requires PI approval (provenance rule).";
const ASK: RawGuardDecision = {
  kind: "ask",
  code: "raw-read-provenance",
  reason: RAW_READ_PROVENANCE_REASON,
  displayReason: { en: "Read raw data — approve?", zh: "读取原始数据，是否批准？" },
};
// A verb or tool counts when the preceding character is not a path-name
// character, so path prefixes (/bin/rm), escapes (\rm), quotes ("rm"), leading
// words (sudo rm) and pipeline tails (| xargs rm) match, while arm, --rm and
// file-name suffixes (x.xz, a.tar -X) do not. Verbs and flags share one tail
// (end, whitespace, ; & | ) } ' " `) so subshells, sh -c '...' wrappers and pwsh
// script blocks match while verb-shaped substrings inside names (rivers) do not.
// Case-insensitive: case-insensitive filesystems resolve RM to /bin/rm.
// Redirects that write a file: > and >> (not <>); >&word unless word is an fd
// number, an fd number plus - (move) or a lone - (close) immediately followed by
// end of text, space, tab, newline or ; & | ( ) < >, as in 2>&1, >& 2, 2>&1-,
// 1>&- and $(... 2>&1); and read-write <>word, which creates or overwrites in
// place. A bash word breaks only there: quotes, backticks and } do not end it, and
// \r, \f and U+00A0 do not split it, so >&2x, >&2:x, >&2$x, >&2\x, >&2"x", >&2" ",
// >&2} and >&$fd name files. A regex cannot tell an opening quote from a closing
// one, so quoted wrappers such as sh -c '... >&2' count as files too (accepted
// deny-direction false positive). [^ \t\n] never matches the blanks [ \t\n]*
// skipped, so >& 2 stays.
const WRITE_VERBS =
  /(?<![A-Za-z0-9_.-])(rm|mv|cp|tee|touch|mkdir|chmod|chown|chgrp|truncate|dd|install|rsync|ln|unlink|rmdir|shred|gzip|gunzip|bzip2|xz|unzip)(?=$|[\s;&|)}'"`])|(^|\s)(-delete|--remove-files)(?=$|[\s;&|)}'"`])|(^|[^<])>{1,2}\s*[^&]|(^|[^<])>&[ \t\n]*(?!(?:[0-9]+-?|-)(?=$|[ \t\n;&|()<>]))[^ \t\n]|<>[ \t\n]*[^ \t\n]|(?<![A-Za-z0-9_.-])(?:git\s+(clean|checkout|restore)|g?tar\s+-[a-zA-Z]*x|sort\s+-o|g?awk\s+-i|g?sed\s+(-[a-zA-Z]*i|--in-place)|perl\s+-[a-zA-Z]*[ie]|i?python[0-9.]*\s+-c|Rscript\s+(-e|--expr)|node\s+(-e|--eval)|(python[0-9.]*|Rscript|node|perl)\s+-\s*<<)|\bopen\s*\(/i;
// PowerShell names are case-insensitive; same anchors as the POSIX verbs. The
// aliases are not bash commands, so they apply only to pwsh or a pwsh wrapper.
const PWSH_WRITES =
  /(?<![A-Za-z0-9_.-])(Remove-Item|Move-Item|Copy-Item|Rename-Item|New-Item|Set-Content|Add-Content|Clear-Content|Clear-Item|Out-File|del|erase|ri|rd|ren|rni|move|mi|copy|cpi|ni|clc|cli)(?=$|[\s;&|)}'"`])/i;
const PWSH_COMMAND = /\b(pwsh|powershell)\b/i;
// A redirect to /dev/null (>, >>, &>, &>>, >&, <>) writes no file, so it is
// stripped before WRITE_VERBS. It starts at &, > or <, never at a leading fd digit
// (bzip2>/dev/null stays bzip2), and the target must end there (/dev/nullx,
// /dev/null/x are real files). Used only with replace: the g flag makes
// test/exec stateful through lastIndex.
const DISCARD_REDIRECT = /(?:&?>{1,2}|>&|<>)\s*\/dev\/null(?![A-Za-z0-9._/-])/g;
// Quote splicing, \ escapes and \<newline> join one bash word, so a copy drops them.
function unquote(text: string): string {
  return text.replace(/\\\n|["'\\]/g, "");
}
// #279: tar extracts (writes) when, after tar in the same command segment, a
// short-option cluster holds x (tar -C <raw> -xf, tar -f a.tar -x), --extract or
// --get (or an abbreviation: --ext, --ge) appears, or the first word is an
// old-style cluster holding x (tar xf). x is case-sensitive: -X is
// --exclude-from. Segments end at ; | newline and at & except in >& and <&
// (&>word is already a write or a stripped /dev/null). Scanning from the first
// tar of each segment keeps the check linear.
const TAR_COMMAND = /(?<![A-Za-z0-9_.-])[gG]?[tT][aA][rR]\s/;
const TAR_EXTRACT_OPTION = /^\s+[A-Za-z]*x|\s(?:-[A-Za-z]*x|--(?:ext[a-z]*|get?)(?![A-Za-z0-9-]))/;
const COMMAND_SEGMENT = /[;|\n]|(?<![<>])&/;
function tarExtracts(text: string): boolean {
  return text.split(COMMAND_SEGMENT).some((segment) => {
    const tar = TAR_COMMAND.exec(segment);
    return tar !== null && TAR_EXTRACT_OPTION.test(segment.slice(tar.index + tar[0].length - 1));
  });
}
// #273 (PI 2026-10-21): a destructive command naming a strict ancestor of a raw dir,
// up to three levels (parent, grandparent, great-grandparent), is denied. Other
// writes (redirects, cp, mkdir, heredocs, interpreter one-liners) and reads pass
// through, so a script mentioning the word data is not blocked.
const RAW_ANCESTOR_LEVELS = 3;
// Verbs that remove, move or re-permission a whole directory tree (same anchors as
// WRITE_VERBS); pwsh adds its cmdlets and aliases.
const ANCESTOR_DESTRUCTIVE =
  /(?<![A-Za-z0-9_.-])(rm|rmdir|unlink|mv|chmod|chown|chgrp|shred|rsync)(?=$|[\s;&|)}'"`])|(^|\s)(-delete|--remove-files)(?=$|[\s;&|)}'"`])|(?<![A-Za-z0-9_.-])git\s+clean(?=$|[\s;&|)}'"`])/i;
const PWSH_ANCESTOR_DESTRUCTIVE =
  /(?<![A-Za-z0-9_.-])(Remove-Item|Move-Item|Rename-Item|del|erase|ri|rd|ren|rni|move|mi)(?=$|[\s;&|)}'"`])/i;
// Ancestor text stands alone: before it, start or a shell boundary (optionally ./);
// after it, end, a boundary, a glob, a brace, or / followed by those (data/, data/*,
// data/{raw,x}), never / plus a name (data/derived).
const ANCESTOR_BEFORE = String.raw`(?<![^\s;&|()<>'"\`=:,{])(?:\./)*`;
const ANCESTOR_AFTER = String.raw`(?=$|[\s;&|()<>'"\`,{}*?[\]]|/(?=$|[\s;&|()<>'"\`,{}*?[\]]))`;
// Changing directory is not naming: the operand of cd/pushd (pwsh: Set-Location,
// sl, Push-Location) is dropped before ancestor matching. Options never cross
// ; & | ( ) < >, so cd -P&&rm -rf data still names data. Used only with replace.
const CHDIR_OPERAND =
  /(^|[\s;&|(`{])(?:cd|pushd|set-location|push-location|sl)(?:\s+-[^\s;&|()<>]*)*\s+[^\s;&|()<>]+/gi;
const ANCESTOR_DENY: RawGuardDecision = {
  kind: "deny",
  code: "raw-ancestor-write",
  reason:
    "Raw data is immutable: this command deletes, moves or re-permissions while naming a directory that contains raw data. Target an explicit path inside that directory, or split the command so the destructive part does not name it.",
};

type RawGuardOptions = { rawDirs: string[] };

export function normalizeRawDirs(config: unknown = {}): RawGuardOptions {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("rawDirs configuration must be an object");
  }
  const fields = config as Record<string, unknown>;
  const dirs = "rawDirs" in fields ? fields.rawDirs : ["data/raw"];
  if (
    Object.keys(fields).some((key) => key !== "rawDirs") ||
    !Array.isArray(dirs) ||
    dirs.length === 0 ||
    dirs.some((dir: unknown) => typeof dir !== "string" || dir.length === 0)
  ) {
    throw new Error("rawDirs must be a non-empty array of non-empty strings, with no unknown keys");
  }
  // #277: configured text is normalized once, so mention, ancestor and canonical
  // checks compare the same spelling: `//` collapses, a `/.` segment (followed by
  // `/` or end) drops, then one leading `./` (the folding leaves at most one)
  // drops unless nothing follows it. Unlike commands, no shell boundary ends a
  // segment here, so `a/. b` stays a path to `. b`.
  return {
    rawDirs: (dirs as string[]).map(
      (dir) =>
        dir
          .replace(/\/{2,}/g, "/")
          .replace(/\/\.(?=\/|$)/g, "")
          .replace(/^\.\/(?=.)/, "")
          .replace(/\/+$/, "") || "/",
    ),
  };
}

function canonical(target: string, cwd: string): string {
  let candidate = isAbsolute(target) ? target : `${cwd}/${target}`;
  const missing: string[] = [];
  for (;;) {
    try {
      // Native realpath preserves physical symlink/.. traversal, like the host.
      return resolve(realpathSync.native(candidate), ...missing.reverse());
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      const split = candidate.lastIndexOf("/");
      if (candidate === "/" || split < 0) throw error;
      missing.push(candidate.slice(split + 1));
      candidate = candidate.slice(0, split) || "/";
    }
  }
}

// Component-boundary containment also handles a configured filesystem root.
function contains(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}

// Equivalent spellings: repeated separators collapse and a `/.` path segment
// (followed by /, end or a command boundary) drops. `./x` and `..` stay as written.
function normalizeCommandPaths(text: string): string {
  return text.replace(/\/{2,}/g, "/").replace(/\/\.(?=\/|$|[\s;&|)}'"`])/g, "");
}

// Lexical `..`: inside one shell word a `..` segment cancels the plain segment
// before it (not empty, `.` or `..`). Symlinks are not resolved.
function foldParentSegments(text: string): string {
  return text.replace(/[^\s;&|()<>'"`]+/g, (word) => {
    const kept: string[] = [];
    for (const segment of word.split("/")) {
      const top = kept.at(-1);
      if (segment === ".." && top !== undefined && top !== "" && top !== "." && top !== "..")
        kept.pop();
      else kept.push(segment);
    }
    return kept.join("/");
  });
}

// Strict ancestors, nearest first; "/" and spellings ending in . or .. are not.
function rawAncestors(path: string): string[] {
  const ancestors: string[] = [];
  let current = path;
  while (ancestors.length < RAW_ANCESTOR_LEVELS) {
    const cut = current.lastIndexOf("/");
    if (cut <= 0) break;
    current = current.slice(0, cut);
    if (/(?:^|\/)\.\.?$/.test(current)) break;
    ancestors.push(current);
  }
  return ancestors;
}

// A canonical root is on a case-insensitive filesystem when its other-case
// spelling (upper if that differs, else lower) natively resolves back to it.
// Missing roots, failed probes and letterless roots count as case-sensitive.
// Probed per decision, not cached: a root created later must be seen.
export function caseInsensitiveRoot(root: string): boolean {
  const upper = root.toUpperCase();
  const variant = upper !== root ? upper : root.toLowerCase();
  if (variant === root) return false;
  try {
    return realpathSync.native(variant) === root;
  } catch {
    return false;
  }
}

export function decideRawAccess(call: RawGuardCall, options: RawGuardOptions): RawGuardDecision {
  const args = call.arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) return NEXT;
  const fields = args as Record<string, unknown>;
  const cwd = call.cwd ?? process.cwd();
  const target =
    call.name === "str_replace_editor" && fields.command !== "view"
      ? fields.path
      : call.name === "write" || call.name === "edit"
        ? fields.file_path
        : undefined;
  if (
    typeof target === "string" &&
    options.rawDirs.some((raw) => contains(canonical(raw, cwd), canonical(target, cwd)))
  )
    return DENY;
  if ((call.name === "bash" || call.name === "pwsh") && typeof fields.command === "string") {
    const command = fields.command;
    const workdir = canonical(typeof fields.workdir === "string" ? fields.workdir : cwd, cwd);
    const pwsh = call.name === "pwsh" || PWSH_COMMAND.test(command);
    // Each spelling also gets an unquoted copy; pwsh alone also reads \ as a
    // separator (bash sub\x is subx).
    const bases = pwsh ? [command, command.replace(/\\/g, "/")] : [command];
    const texts = bases
      .flatMap((text) => [text, unquote(text)])
      .flatMap((text) => {
        const normalized = normalizeCommandPaths(text);
        return [text, normalized, foldParentSegments(normalized)];
      });
    for (const raw of options.rawDirs) {
      const root = canonical(raw, cwd);
      const flags = caseInsensitiveRoot(root) ? "i" : "";
      const mentioned = [raw, normalizeCommandPaths(raw), root].some((text) => {
        const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        // Any non-path-name character after raw text (glob, brace, backtick) is a mention.
        const pattern = new RegExp(`${escaped}(?![A-Za-z0-9._-])`, flags);
        return texts.some((candidate) => pattern.test(candidate));
      });
      if (!mentioned && !contains(root, workdir)) continue;
      const writes = [command, unquote(command)].some((text) => {
        const checked = text.replace(DISCARD_REDIRECT, " ");
        return WRITE_VERBS.test(checked) || tarExtracts(checked);
      });
      return writes || (pwsh && PWSH_WRITES.test(command)) ? DENY : ASK;
    }
    // Second pass, only when no raw dir is touched: a destructive verb naming an
    // ancestor. Ancestors come from the configured spelling, the canonical root and
    // the literal cwd join (a symlinked cwd), each up to RAW_ANCESTOR_LEVELS.
    if (
      [command, unquote(command)].some((text) => ANCESTOR_DESTRUCTIVE.test(text)) ||
      (pwsh && PWSH_ANCESTOR_DESTRUCTIVE.test(command))
    ) {
      const unchdired = texts.map((text) => text.replace(CHDIR_OPERAND, "$1"));
      for (const raw of options.rawDirs) {
        const root = canonical(raw, cwd);
        const flags = caseInsensitiveRoot(root) ? "i" : "";
        const spelled = normalizeCommandPaths(raw);
        const ancestors = new Set([
          ...rawAncestors(spelled),
          ...rawAncestors(root),
          ...rawAncestors(resolve(cwd, spelled)),
        ]);
        const named = [...ancestors].some((ancestor) => {
          const escaped = ancestor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const pattern = new RegExp(`${ANCESTOR_BEFORE}${escaped}${ANCESTOR_AFTER}`, flags);
          return unchdired.some((candidate) => pattern.test(candidate));
        });
        if (named) return ANCESTOR_DENY;
      }
    }
  }
  return NEXT;
}
