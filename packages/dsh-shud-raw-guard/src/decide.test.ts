import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import {
  caseInsensitiveRoot,
  decideRawAccess,
  normalizeRawDirs,
  RAW_READ_PROVENANCE_REASON,
} from "./decide.ts";

test("rejects invalid rawDirs rather than silently using defaults", () => {
  for (const config of [
    null,
    [],
    "raw",
    { rawDir: ["raw"] },
    { rawDirs: [] },
    { rawDirs: [""] },
    { rawDirs: "raw" },
    { rawDirs: [1] },
  ]) {
    expect(() => normalizeRawDirs(config)).toThrow(/rawDirs/);
  }
  expect(normalizeRawDirs()).toEqual({ rawDirs: ["data/raw"] });
  expect(normalizeRawDirs({ rawDirs: ["data/raw/", "/"] })).toEqual({ rawDirs: ["data/raw", "/"] });
});

const cwd = mkdtempSync(join(tmpdir(), "shud-guard-"));
mkdirSync(join(cwd, "protected", "nested"), { recursive: true });
symlinkSync(join(cwd, "protected"), join(cwd, "alias"));
symlinkSync(cwd, join(cwd, "session"));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));
const options = normalizeRawDirs({ rawDirs: ["protected/"] });
function decide(name: string, args: unknown, config = options, sessionCwd = cwd) {
  return decideRawAccess({ name, arguments: args, cwd: sessionCwd }, config);
}

test("file mutations use canonical containment, including new files and symlinked cwd", () => {
  for (const name of ["write", "edit", "str_replace_editor"]) {
    for (const target of [
      "protected/new.csv",
      "alias/new.csv",
      "alias/nested/../new.csv",
      join(realpathSync(cwd), "protected/new.csv"),
    ]) {
      const args = {
        file_path: target,
        path: target,
        command: "create",
        sandbox_permissions: "require_escalated",
      };
      const decision = decide(name, args, options, join(cwd, "session"));
      expect(decision.kind).toBe("deny");
      expect(decision.reason).toMatch(/immutable/);
      expect(decision.reason).toMatch(/read/);
    }
    for (const target of ["protectedx/new.csv", "derived/new.csv"]) {
      expect(decide(name, { file_path: target, path: target, command: "create" }).kind).toBe(
        "next",
      );
    }
  }
  expect(decide("str_replace_editor", { path: "protected/x", command: "view" }).kind).toBe("next");
});

test("shell raw reads ask while write verbs deny, including escalation and copy-out", () => {
  const writes = "rm mv cp tee touch mkdir chmod chown truncate dd install rsync ln".split(" ");
  const commands = [
    ...writes.map((verb) => `${verb} protected/x derived/x`),
    "echo bad > protected/x",
    "echo bad >> protected/x",
    "sed -i s/a/b/ protected/x",
    "sed --in-place s/a/b/ protected/x",
    "perl -i -pe s/a/b/ protected/x",
    "python3 -c 'open(\"protected/x\")'",
    "open(protected/x)",
  ];
  for (const name of ["bash", "pwsh"]) {
    for (const command of commands) {
      expect(decide(name, { command, sandbox_permissions: "require_escalated" }).kind).toBe("deny");
    }
    for (const command of [
      "cat protected/x",
      "ls -la protected",
      `head ${realpathSync(cwd)}/protected/x`,
    ]) {
      const result = decide(name, { command });
      expect(result.kind).toBe("ask");
      expect(result.reason).toBe(RAW_READ_PROVENANCE_REASON);
      expect(result.displayReason?.en).toMatch(/raw/i);
      expect(result.displayReason?.zh).toMatch(/原始/);
    }
    for (const command of ["echo ok > derived.txt", "rm protectedx/x"]) {
      expect(decide(name, { command }).kind).toBe("next");
    }
    for (const [command, kind] of [
      ["wc -l x", "ask"],
      ["rm x", "deny"],
    ]) {
      expect(decide(name, { command, workdir: "alias" }).kind).toBe(kind);
    }
  }
  expect(decide("bash", { command: "cd protected" }).kind).toBe("ask");
  expect(decide("bash", { command: "rm x" }).kind).toBe("next");
});

test("missing paths, defaults, absolute and multiple roots retain decision boundaries", () => {
  const future = normalizeRawDirs({ rawDirs: ["absent/raw"] });
  const roots = normalizeRawDirs({ rawDirs: ["elsewhere", join(cwd, "protected")] });
  for (const config of [future, roots, normalizeRawDirs()]) {
    const raw = config.rawDirs.at(-1)!;
    expect(decide("write", { file_path: `${raw}/new.csv` }, config).kind).toBe("deny");
    expect(decide("write", { file_path: `${raw}x/new.csv` }, config).kind).toBe("next");
    expect(decide("bash", { command: "echo ok" }, config).kind).toBe("next");
  }
  const call = { name: "write", arguments: { file_path: "data/raw/new.csv" } };
  expect(decideRawAccess(call, normalizeRawDirs()).kind).toBe("deny");
  expect(decide("write", { file_path: "new.csv" }, normalizeRawDirs({ rawDirs: ["/"] })).kind).toBe(
    "deny",
  );
  expect(decide("bash", { command: "cat x" }, roots, join(cwd, "protected")).kind).toBe("ask");
});

test("unrelated tools and malformed arguments delegate without touching paths", () => {
  for (const name of ["read", "run_code", "present", "write", "bash", "pwsh"]) {
    for (const args of [
      null,
      undefined,
      [],
      7,
      "raw",
      {},
      { file_path: 7, command: false, workdir: {} },
    ]) {
      expect(decide(name, args).kind).toBe("next");
    }
  }
  for (const name of ["read", "run_code", "present"]) {
    expect(decide(name, { file_path: "protected/x", command: "rm protected/x" }).kind).toBe("next");
  }
});

test("physical symlink-parent traversal agrees across targets, roots and workdirs", () => {
  symlinkSync(join(cwd, "protected/nested"), join(cwd, "deep-link"));
  mkdirSync(join(cwd, "outside/nested"), { recursive: true });
  symlinkSync(join(cwd, "outside/nested"), join(cwd, "protected/out-link"));
  writeFileSync(join(cwd, "protected/existing.csv"), "fixture");
  for (const name of ["write", "edit", "str_replace_editor"]) {
    for (const leaf of ["existing.csv", "new.csv"]) {
      const path = `deep-link/../${leaf}`;
      expect(decide(name, { file_path: path, path, command: "create" }).kind).toBe("deny");
    }
    const path = "protected/out-link/../new.csv";
    expect(decide(name, { file_path: path, path, command: "create" }).kind).toBe("next");
  }
  const physicalRoot = normalizeRawDirs({ rawDirs: ["deep-link/.."] });
  expect(decide("write", { file_path: "protected/new.csv" }, physicalRoot).kind).toBe("deny");
  expect(decide("write", { file_path: "outside/new.csv" }, physicalRoot).kind).toBe("next");
  for (const [command, kind] of [
    ["cat existing.csv", "ask"],
    ["rm existing.csv", "deny"],
  ]) {
    expect(decide("bash", { command, workdir: "deep-link/.." }).kind).toBe(kind);
    const config = normalizeRawDirs({ rawDirs: [join(cwd, "protected")] });
    expect(decide("bash", { command }, config, `${cwd}/deep-link/..`).kind).toBe(kind);
  }
});

test.runIf(process.platform === "darwin")(
  "macOS var alias and private spelling share raw identity",
  () => {
    const aliasCwd = mkdtempSync("/var/tmp/shud-guard-");
    try {
      const physical = realpathSync.native(aliasCwd);
      expect(physical.startsWith("/private/var/")).toBe(true);
      const config = normalizeRawDirs({ rawDirs: [join(physical, "protected")] });
      expect(decide("write", { file_path: "protected/new.csv" }, config, aliasCwd).kind).toBe(
        "deny",
      );
    } finally {
      rmSync(aliasCwd, { recursive: true, force: true });
    }
  },
);

type Kind = "deny" | "ask" | "next";
const POSIX_WRITES =
  "rm mv cp tee touch mkdir chmod chown chgrp truncate dd install rsync ln unlink rmdir shred gzip gunzip bzip2 xz unzip".split(
    " ",
  );
const PWSH_WRITES =
  "Remove-Item Move-Item Copy-Item Rename-Item New-Item Set-Content Add-Content Clear-Content Clear-Item Out-File del erase ri rd ren rni move mi copy cpi ni clc cli".split(
    " ",
  );
const shellCases: [string, Kind][] = [
  ["rm -rf protected*", "deny"],
  ["rm -rf protected?", "deny"],
  ["rm -rf {protected,x}", "deny"],
  ["rm -rf protected/*", "deny"],
  ["cat protected*", "ask"],
  ["cat protected?", "ask"],
  ["ls {protected,derived}", "ask"],
  ["cat `echo protected`", "ask"],
  ["ls `echo protected`", "ask"],
  ["rm protectedx/x", "next"],
  ["rm protected.bak", "next"],
  ["rm protected_old/x", "next"],
  ["rm protected-2/x", "next"],
  ["rm protected2/x", "next"],
  ["cat protected_old/x", "next"],
  ["rm -rf protecte*", "next"],
  ...POSIX_WRITES.map((verb): [string, Kind] => [`${verb} protected/x derived/x`, "deny"]),
  ...POSIX_WRITES.map((verb): [string, Kind] => [`${verb.toUpperCase()} protected/x`, "deny"]),
  ["sh -c 'ls protected | xargs rm'", "deny"],
  ["echo $(ls protected | xargs rm)", "deny"],
  ["ls protected | xargs rm;echo", "deny"],
  ["ls protected | xargs rm&&echo", "deny"],
  ['"rm" protected/x', "deny"],
  ['bash -c "find protected -delete"', "deny"],
  ["echo `find protected -delete`", "deny"],
  ["Rscript -e 'unlink(\"protected\", recursive=TRUE)'", "deny"],
  ["Rscript -e 'file.remove(\"protected/x\")'", "deny"],
  ['node -e \'require("fs").rmSync("protected",{recursive:true})\'', "deny"],
  ["perl -e 'unlink(\"protected/x\")'", "deny"],
  ["python3 - <<'EOF'\nimport shutil\nshutil.rmtree(\"protected\")\nEOF", "deny"],
  ["gzip protected/x", "deny"],
  ["git clean -fdx protected", "deny"],
  ["tar -xzf a.tgz -C protected", "deny"],
  ["sort -o protected/x protected/x", "deny"],
  ["git checkout -- protected/x", "deny"],
  ["git restore protected/x", "deny"],
  ["awk -i inplace 1 protected/x", "deny"],
  ["node --eval 'x' protected/x", "deny"],
  ["Rscript --expr 'x' protected/x", "deny"],
  ["cat protected/model x", "ask"],
  ["ls protected/rivers", "ask"],
  ["/bin/rm protected/x", "deny"],
  ["\\rm protected/x", "deny"],
  ["sudo rm protected/x", "deny"],
  ["echo $(rm protected/x)", "deny"],
  ["rmdir protected", "deny"],
  ["find protected -delete", "deny"],
  ["find protected -delete; echo", "deny"],
  ["tar -cf a.tar protected --remove-files", "deny"],
  ["find protected -type f | xargs rm", "deny"],
  ["docker run --rm -v protected:/d img", "ask"],
  ["arm protected/x", "ask"],
  ["add protected/x", "ask"],
  ["sudo cat protected/x", "ask"],
  ["find protected --delete-after", "ask"],
];
const pwshCases: [string, Kind][] = [
  ...PWSH_WRITES.map((cmdlet): [string, Kind] => [`${cmdlet} protected/x`, "deny"]),
  ...PWSH_WRITES.filter((cmdlet) => cmdlet !== cmdlet.toLowerCase()).map(
    (cmdlet): [string, Kind] => [`${cmdlet.toLowerCase()} protected/x`, "deny"],
  ),
  ["Set-Content protected/x 1", "deny"],
  ["Get-ChildItem protected | Remove-Item", "deny"],
  ["Get-ChildItem protected", "ask"],
  ['pwsh -c "Get-ChildItem protected | Remove-Item"', "deny"],
  ["ren protected/x y", "deny"],
  ["ni protected/x", "deny"],
  ["Clear-Item protected/x", "deny"],
  ["Get-ChildItem protected/third x", "ask"],
  ["gci protected | %{$_|del}", "deny"],
  ["Get-ChildItem protected | ForEach-Object {$_ | Remove-Item}", "deny"],
];
// Bash-only: pwsh aliases (move, copy, ni) are not bash commands.
const bashCases: [string, Kind][] = [
  ["grep -r move protected", "ask"],
  ["grep -n copy protected/README", "ask"],
  ["file protected/ni", "ask"],
  ["cat protected/x.xz", "ask"],
  ["xzcat protected/x.xz", "ask"],
  ["tar -tzf protected/a.tgz", "ask"],
  ["tar -tvf protected/a.tar -X excl", "ask"],
  ["git log -- protected", "ask"],
  ["awk '{print $1}' protected/x", "ask"],
  ["sed -n 1,5p protected/x", "ask"],
  ["Rscript analyse.R protected/x", "ask"],
  ["gsed -i s/a/b/ protected/x", "deny"],
  ["/opt/homebrew/bin/gsed -i s/a/b/ protected/x", "deny"],
  ["gawk -i inplace 1 protected/x", "deny"],
  ["gtar -xf a.tar -C protected", "deny"],
  ["ipython -c x protected", "deny"],
  ["pwsh -c 'gci protected | del'", "deny"],
  ["Rscript - <<'EOF'\nunlink(\"protected/x\")\nEOF", "deny"],
  ['node - <<\'EOF\'\nrequire("fs").rmSync("protected")\nEOF', "deny"],
  ["perl - <<'EOF'\nunlink \"protected/x\"\nEOF", "deny"],
];

test.each([
  ...shellCases.map(([command, kind]) => ["bash", command, kind]),
  ...shellCases.map(([command, kind]) => ["pwsh", command, kind]),
  ...pwshCases.map(([command, kind]) => ["pwsh", command, kind]),
  ...bashCases.map(([command, kind]) => ["bash", command, kind]),
])("%s `%s` -> %s (#245 boundary and write verbs)", (name, command, kind) => {
  const result = decide(name, { command });
  expect(result.kind).toBe(kind);
  if (kind === "ask") expect(result.reason).toBe(RAW_READ_PROVENANCE_REASON);
  if (kind === "deny") expect(result.reason).toMatch(/immutable/);
});

const defaultRaw = normalizeRawDirs().rawDirs[0];
// #248: a redirect to /dev/null writes no file; only a real target is a write.
const discardRedirectCases: [string, Kind, typeof options][] = [
  ["head protected/obs.csv 2>/dev/null", "ask", options],
  ["ls protected >/dev/null", "ask", options],
  ["cat protected/x 2>/dev/null | wc -l", "ask", options],
  ["ls protected &>/dev/null", "ask", options],
  ["head protected/a 1>/dev/null 2>&1", "ask", options],
  ["head protected/a >>/dev/null", "ask", options],
  ["head protected/a 2> /dev/null", "ask", options],
  [`cat ${defaultRaw}/obs.csv 2>/dev/null`, "ask", normalizeRawDirs()],
  ["head protected/obs.csv 2>&1", "ask", options],
  ["echo bad >> protected/x", "deny", options],
  ["cat protected/x | sort > out.txt", "deny", options],
  ["cat protected/a 2>/dev/null > protected/b", "deny", options],
  ["head protected/a > /dev/nullx", "deny", options],
  ["head protected/a > /dev/null/x", "deny", options],
  ["head protected/a >/dev/null; rm protected/a", "deny", options],
  ["cat protected/a 2>/dev/null | tee protected/b", "deny", options],
  ["bzip2>/dev/null protected/x", "deny", options],
  [`echo bad >> ${defaultRaw}/obs.csv`, "deny", normalizeRawDirs()],
];
test.each(discardRedirectCases)(
  "bash `%s` -> %s (#248 discarding redirect)",
  (command, kind, config) => {
    const result = decide("bash", { command }, config);
    expect(result.kind).toBe(kind);
    if (kind === "ask") expect(result.reason).toBe(RAW_READ_PROVENANCE_REASON);
    if (kind === "deny") expect(result.reason).toMatch(/immutable/);
  },
);

// #255: a file-target >&word and a read-write <>word write a file; fd
// duplication, moving and closing (>&2, 2>&1-, 1>&-) and /dev/null do not.
const fdRedirectCases: [string, Kind, typeof options, string?][] = [
  ["echo x >&protected/b", "deny", options],
  ["echo x >& protected/b", "deny", options],
  ["echo x 1>&protected/b", "deny", options],
  ["cat protected/a >&out.txt", "deny", options],
  ["echo x >&2x protected/a", "deny", options],
  ["echo XY 1<>protected/a", "deny", options],
  [": <>protected/newfile", "deny", options],
  ["exec 3<>protected/newfile", "deny", options],
  ["cat protected/a 0<>protected/b", "deny", options],
  ["cat protected/a 2>/dev/null >&protected/b", "deny", options],
  ["echo XY 1<>protected/a 2>/dev/null", "deny", options],
  ["head protected/a >&/dev/nullx", "deny", options],
  [`echo x >&${defaultRaw}/b`, "deny", normalizeRawDirs()],
  ["head protected/a 2>&1", "ask", options],
  ["head protected/a >&2", "ask", options],
  ["head protected/a >& 2", "ask", options],
  ["head protected/a 1>&-", "ask", options],
  ["head protected/a 2>&1-", "ask", options],
  ["cat protected/a 3>&1-", "ask", options],
  ["head protected/a 2>&1 | wc -l", "ask", options],
  ["head protected/a 2>&1;", "ask", options],
  ["head protected/a >&/dev/null", "ask", options],
  ["head protected/a 3<>/dev/null", "ask", options],
  ["head protected/a <protected/b", "ask", options],
  ["diff <(cat protected/a) b", "ask", options],
  ["cat protected/a <<EOF", "ask", options],
  [`head ${defaultRaw}/a 2>&1`, "ask", normalizeRawDirs()],
  ["echo x &>protected/b", "deny", options],
  ["echo x &>>protected/b", "deny", options],
  ["bzip2<>/dev/null protected/x", "deny", options],
  // A bash word breaks only at whitespace and metacharacters, so an fd number
  // followed by any other character (: , $ \ or quoted text) names a file.
  ["echo x >&1,/../protected/x", "deny", options],
  ["cat protected/a >&2:out", "deny", options],
  ["cat protected/a >&2,", "deny", options],
  ["cat protected/a >&2$x", "deny", options],
  ["cat protected/a >&2\\x", "deny", options],
  ['cat protected/a >&2-"q"', "deny", options],
  ['cat protected/a >&2"/../protected/b"', "deny", options],
  ["cat protected/a >&2'y'", "deny", options],
  ['echo x >&2"x"', "deny", options, "protected"],
  [`cat ${defaultRaw}/a >&2:out`, "deny", normalizeRawDirs()],
  ["cat protected/a 2>&1)", "ask", options],
  ["cat protected/a 2>&1&&x", "ask", options],
  ["{ cat protected/a >&2; }", "ask", options],
  ['x "$(cat protected/a 2>&1)"', "ask", options],
  ["cat protected/a 2>&1>/dev/null", "ask", options],
  ["cat protected/a 2>&1<x", "ask", options],
  ["cat protected/a 2>&1\n", "ask", options],
  ["cat protected/a 2>&1\t#c", "ask", options],
  // Fail closed: a regex cannot tell an opening quote from a closing one, so no
  // quote, backtick or } ends an fd number. Bash splits words only at space, tab
  // and newline (not \r, \f or U+00A0), so each row writes a file in bash or, in
  // the quoted forms, fails closed as one (>&2` x` is fd duplication when x is not
  // a command); the quoted read wrappers are accepted deny-direction false positives.
  ['cat protected/a >&2" "', "deny", options],
  ['cat protected/a >&2" x"', "deny", options],
  ['cat protected/a >&2";x"', "deny", options],
  ["cat protected/a >&2' '", "deny", options],
  ["cat protected/a >&2` x`", "deny", options],
  ['cat protected/a >&2" /../protected/b"', "deny", options],
  ["cat protected/a >&2}", "deny", options],
  ["cat protected/a >&2\r", "deny", options],
  ["cat protected/a >&2\fx", "deny", options],
  ["cat protected/a >&2\u00a0x", "deny", options],
  ['echo x >&2" "', "deny", options, "protected"],
  ["sh -c 'head protected/a >&2'", "deny", options],
  ['sh -c "head protected/a >&2"', "deny", options],
  ["x `cat protected/a 2>&1`", "deny", options],
  ["cat protected/a >&2''", "deny", options],
];
test.each(fdRedirectCases)(
  "bash `%s` -> %s (#255 fd redirect)",
  (command, kind, config, workdir) => {
    const result = decide("bash", workdir ? { command, workdir } : { command }, config);
    expect(result.kind).toBe(kind);
    if (kind === "ask") expect(result.reason).toBe(RAW_READ_PROVENANCE_REASON);
    if (kind === "deny") expect(result.reason).toMatch(/immutable/);
  },
);

// #255 resource limit: whitespace-only or fd-only redirect tails stay linear reads.
test.each([
  ["'>&' + 1e6 spaces", ">&" + " ".repeat(1e6)],
  ["'1>&' x 3e5", "1>&".repeat(3e5)],
  ["'<>' + 1e6 spaces", "<>" + " ".repeat(1e6)],
])("bash `cat protected/a ` + %s -> ask (#255 adversarial)", (_label, tail) => {
  const result = decide("bash", { command: `cat protected/a ${tail}` });
  expect(result.kind).toBe("ask");
  expect(result.reason).toBe(RAW_READ_PROVENANCE_REASON);
});

test.each([
  [`rm -rf ${defaultRaw}*`, "deny"],
  [`rm -rf ${defaultRaw}?`, "deny"],
  [`rm -rf {${defaultRaw},x}`, "deny"],
  [`cat ${defaultRaw}*`, "ask"],
])("default rawDirs bash `%s` -> %s", (command, kind) => {
  expect(decide("bash", { command }, normalizeRawDirs()).kind).toBe(kind);
});

// #247: equivalent spellings of a raw path decide like the configured text.
// Filesystem case sensitivity is read with existsSync before any differently
// cased directory exists: macOS APFS takes the insensitive branch, Linux the other.
const defaultWs = mkdtempSync(join(tmpdir(), "shud-guard-default-"));
mkdirSync(join(defaultWs, defaultRaw), { recursive: true });
const defaultInsensitive = existsSync(join(defaultWs, defaultRaw.toUpperCase()));
const caseWs = mkdtempSync(join(tmpdir(), "shud-guard-case-"));
mkdirSync(join(caseWs, "protected"));
const caseInsensitive = existsSync(join(caseWs, "PROTECTED"));
const caseRoot = realpathSync.native(join(caseWs, "protected"));
afterAll(() => {
  for (const dir of [defaultWs, caseWs]) rmSync(dir, { recursive: true, force: true });
});
const defaults = normalizeRawDirs();
const missing = normalizeRawDirs({ rawDirs: ["missing/raw"] });
const caseKind = (kind: Kind): Kind => (caseInsensitive ? kind : "next");
const spellingCases: [string, Kind, typeof options, string][] = [
  ["rm -rf DATA/RAW", defaultInsensitive ? "deny" : "next", defaults, defaultWs],
  ["rm -rf data/./raw", "deny", defaults, defaultWs],
  ["rm -rf data//raw", "deny", defaults, defaultWs],
  ["rm -rf ./data//./raw/", "deny", defaults, defaultWs],
  ["cat data/./raw/x", "ask", defaults, defaultWs],
  ["rm data/raw-x", "next", defaults, defaultWs],
  ["rm data/rawx/y", "next", defaults, defaultWs],
  ["rm data/raw.bak", "next", defaults, defaultWs],
  ["rm -rf data/x/../raw", "next", defaults, defaultWs],
  ["rm -rf PROTECTED", caseKind("deny"), options, caseWs],
  ["rm -rf Protected/x", caseKind("deny"), options, caseWs],
  ["cat PROTECTED/x", caseKind("ask"), options, caseWs],
  ["cat Protected/x", caseKind("ask"), options, caseWs],
  ["rm -rf MISSING/RAW", "next", missing, caseWs],
  ["rm -rf missing/./raw", "deny", missing, caseWs],
];
test.each(spellingCases)("bash `%s` -> %s (#247 path spelling)", (command, kind, config, ws) => {
  const result = decide("bash", { command }, config, ws);
  expect(result.kind).toBe(kind);
  if (kind === "ask") expect(result.reason).toBe(RAW_READ_PROVENANCE_REASON);
  if (kind === "deny") expect(result.reason).toMatch(/immutable/);
});

// #260: quote splicing, backslash escapes and continuations join one bash word;
// pwsh also accepts \ as a separator (bash reads sub\x as subx).
const subX = normalizeRawDirs({ rawDirs: ["sub/x"] });
const subx = normalizeRawDirs({ rawDirs: ["subx"] });
const quoteSplitCases: [string, string, Kind, typeof options][] = [
  ["bash", 'rm -rf prot"ected"', "deny", options],
  ["bash", "rm -rf prot'ected'", "deny", options],
  ["bash", "rm -rf prot\\ected", "deny", options],
  ["bash", 'rm -rf "prot"ected/obs.csv', "deny", options],
  ["bash", 'rm -rf prot""ected', "deny", options],
  ["bash", "rm -rf prot\\\nected", "deny", options],
  ["bash", "cat prot''ected/obs.csv", "ask", options],
  ["bash", `rm -rf ${defaultRaw.slice(0, -2)}"${defaultRaw.slice(-2)}"`, "deny", defaults],
  ["pwsh", "Remove-Item sub\\x", "deny", subX],
  ["bash", 'pwsh -c "Remove-Item sub\\x"', "deny", subX],
  ["pwsh", "Get-Content sub\\x\\obs.csv", "ask", subX],
  // Documented gap: a glob or brace inside the raw name needs expansion.
  ["bash", "rm -rf p*d", "next", options],
  ["bash", "rm -rf protecte?", "next", options],
  ["bash", "rm -rf prot[e]cted", "next", options],
  ["bash", "rm -rf prot{e,}cted", "next", options],
  ["bash", "rm -rf protect{ed,}", "next", options],
  ["bash", 'rm "prot ected"', "next", options],
  ["bash", "rm sub\\x", "next", subX],
  ["pwsh", "Remove-Item sub\\xy", "next", subX],
  ["pwsh", "Get-Content sub\\x.bak", "next", subX],
  // Accepted deny-direction false positives of the stripped and pwsh spellings.
  ["bash", "rm 'prot\\ected'", "deny", options],
  ["pwsh", "Remove-Item 'prot''ected'", "deny", options],
  ["pwsh", "Remove-Item sub\\x", "deny", subx],
  ["bash", "grep -l pwsh notes; rm sub\\x", "deny", subX],
];
test.each(quoteSplitCases)("%s `%s` -> %s %j (#260 quote split)", (name, command, kind, config) => {
  const result = decide(name, { command }, config);
  expect(result.kind).toBe(kind);
  if (kind === "ask") expect(result.reason).toBe(RAW_READ_PROVENANCE_REASON);
  if (kind === "deny") expect(result.reason).toMatch(/immutable/);
});

test("file tools already canonicalize dot spellings (#247 sibling surface)", () => {
  expect(decide("write", { file_path: "data/./raw/x" }, defaults, defaultWs).kind).toBe("deny");
});

test("caseInsensitiveRoot matches the independently observed filesystem sensitivity", () => {
  expect(caseInsensitiveRoot(caseRoot)).toBe(caseInsensitive);
});

test("caseInsensitiveRoot treats a root without letters as case-sensitive", () => {
  expect(caseInsensitiveRoot("/1/2")).toBe(false);
});

test.runIf(!caseInsensitive)("case-sensitive filesystem: a separate PROTECTED/ is not raw", () => {
  mkdirSync(join(caseWs, "PROTECTED"));
  expect(caseInsensitiveRoot(caseRoot)).toBe(false);
  expect(decide("bash", { command: "rm -rf PROTECTED" }, options, caseWs).kind).toBe("next");
});
