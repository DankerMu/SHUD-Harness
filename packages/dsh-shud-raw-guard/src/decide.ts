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
// A verb counts when the preceding character is not part of a word, so path
// prefixes (/bin/rm), escapes (\rm), leading words (sudo rm) and pipeline
// tails (| xargs rm) match, while arm and --rm do not.
const WRITE_VERBS =
  /(?<![A-Za-z0-9_-])(rm|mv|cp|tee|touch|mkdir|chmod|chown|truncate|dd|install|rsync|ln|unlink|rmdir|shred)(?=\s|$)|(^|\s)(-delete|--remove-files)(?=$|[\s;&|)])|(^|[^<])>{1,2}\s*[^&]|sed\s+(-[a-zA-Z]*i|--in-place)|perl\s+-[a-zA-Z]*i|python[0-9.]*\s+-c|\bopen\s*\(/;
// PowerShell names are case-insensitive; TS rejects inline (?i:), hence a separate regex.
const PWSH_WRITES =
  /(?<![A-Za-z0-9_-])(Remove-Item|Move-Item|Copy-Item|Rename-Item|New-Item|Set-Content|Add-Content|Clear-Content|Out-File|del|erase|ri|rd)(?=\s|$)/i;

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
  return { rawDirs: (dirs as string[]).map((dir) => dir.replace(/\/+$/, "") || "/") };
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
    for (const raw of options.rawDirs) {
      const root = canonical(raw, cwd);
      const mentioned = [raw, root].some((text) => {
        const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        // Any non-path-name character after raw text (glob, brace, backtick) is a mention.
        return new RegExp(`${escaped}(?![A-Za-z0-9._-])`).test(command);
      });
      if (mentioned || contains(root, workdir))
        return WRITE_VERBS.test(command) || PWSH_WRITES.test(command) ? DENY : ASK;
    }
  }
  return NEXT;
}
