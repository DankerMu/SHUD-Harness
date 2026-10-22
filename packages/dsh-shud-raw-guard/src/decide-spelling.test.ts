import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { decideRawAccess, normalizeRawDirs, RAW_READ_PROVENANCE_REASON } from "./decide.ts";

type Kind = "deny" | "ask" | "next";

// #279: a write verb spelled with quotes or escapes (r"m", c\p, r\<newline>m) and a
// tar extract (any x short-option cluster, --extract/--get and abbreviations, old-style
// xf) deny; tar listing/creation, -X, a later command's -x and a.tar -x stay reads.
const spellWs = mkdtempSync(join(tmpdir(), "shud-guard-spell-"));
mkdirSync(join(spellWs, "prot", "sub"), { recursive: true });
mkdirSync(join(spellWs, "raw2"));
mkdirSync(join(spellWs, "ref", "raw"), { recursive: true });
afterAll(() => rmSync(spellWs, { recursive: true, force: true }));
const prot = normalizeRawDirs({ rawDirs: ["prot"] });
function decide(command: string) {
  return decideRawAccess({ name: "bash", arguments: { command }, cwd: spellWs }, prot);
}
const spellingWriteCases: [string, Kind][] = [
  ['r"m" -rf prot', "deny"],
  ["r'm' -rf prot", "deny"],
  ["r\\m -rf prot", "deny"],
  ['m"v" a prot/b', "deny"],
  ["c\\p a prot/b", "deny"],
  ["r\\\nm -rf prot", "deny"],
  ["tar -C prot -xf a.tar", "deny"],
  ["tar -f a.tar -x -C prot", "deny"],
  ["tar --extract -f a.tar -C prot", "deny"],
  ["tar --get -f a.tar -C prot", "deny"],
  ["tar xf a.tar -C prot", "deny"],
  ["gtar -C prot -xzf a.tgz", "deny"],
  ["TAR -C prot -xf a.tar", "deny"],
  // Review fixture r1 pins: x inside a cluster, quoted tar or x, a tab, redirect &
  // inside one segment, and long-option abbreviations.
  ["tar -C prot -zxf a.tgz", "deny"],
  ["tar zxf a.tgz -C prot", "deny"],
  ['"tar" -C prot -xf a.tar', "deny"],
  ['tar -C prot -"x"f a.tar', "deny"],
  ["tar\t-C prot -xf a.tar", "deny"],
  ["tar 2>&1 -C prot -xf a.tar", "deny"],
  ["tar >&2 -C prot -xf a.tar", "deny"],
  ["tar <&0 -C prot -xf a.tar", "deny"],
  ["tar -C prot --ext -f a.tar", "deny"],
  ["tar -C prot --ge -f a.tar", "deny"],
  // Review round 1 pins: a later segment, uppercase cluster letters, a trailing long
  // option, a path prefix, extra or tab whitespace, uppercase GTAR, and a stripped
  // discard redirect glued to tar.
  ["cd w && tar -C prot -xf a.tar", "deny"],
  ["ls; tar -C prot -xf a.tar", "deny"],
  ["tar -C prot -Jxf a.txz", "deny"],
  ["tar Jxf a.txz -C prot", "deny"],
  ["tar -f a.tar -C prot --extract", "deny"],
  ["/usr/bin/tar -C prot -xf a.tar", "deny"],
  ["tar  xf a.tar -C prot", "deny"],
  ["tar -C prot\t-xf a.tar", "deny"],
  ["GTAR -C prot -xf a.tar", "deny"],
  ["tar>/dev/null -C prot -xf a.tar", "deny"],
  // Review round 2 pins: x third in an old-style or short-option cluster.
  ["tar zvxf a.tgz -C prot", "deny"],
  ["tar -C prot -zvxf a.tgz", "deny"],
  // Review round 3 pins: a tab after tar before an old-style cluster, x fourth in a
  // cluster, gtar's longer word before the cluster, and --extract before ).
  ["tar\txf a.tar -C prot", "deny"],
  ["tar zvvxf a.tgz -C prot", "deny"],
  ["tar -C prot -zvvxf a.tgz", "deny"],
  ["gtar xzf a.tgz -C prot", "deny"],
  ["(tar -C prot -f a.tar --extract)", "deny"],
  ["cat prot/x", "ask"],
  ["tar -tf prot/a.tar", "ask"],
  ["tar -tvf prot/a.tar -X excl", "ask"],
  ["tar -cf o.tar prot", "ask"],
  ["tar -cf o.tar -C prot .", "ask"],
  ["tar -tf prot/a.tar | grep -x foo", "ask"],
  ["ls prot/a.tar -x", "ask"],
  // A later command's -x after && ; & or a newline is not tar's.
  ["tar -tf prot/a.tar && grep -x foo", "ask"],
  ["tar -tf prot/a.tar; ls -x", "ask"],
  ["tar -tf prot/a.tar & ls -x", "ask"],
  ["tar -tf prot/a.tar\nls -x", "ask"],
  ["rm protx/x", "next"],
  ["echo ok > derived.txt", "next"],
  // Accepted false positives: a quoted or escaped verb as data, an x after a tar word
  // (-Xexcl, extracted), and extracting an archive read from raw.
  ["grep 'r''m' prot/log", "deny"],
  ["grep -rn tar prot -x", "deny"],
  ['grep "c\\p" prot/log', "deny"],
  ["tar -tvf prot/a.tar -Xexcl", "deny"],
  ['grep "tar extracted" prot/log', "deny"],
  ["tar -C work -xzf prot/x.tgz", "deny"],
  // Documented gap: a | inside quotes still ends the tar segment.
  ['tar -C prot --exclude="a|b" -xf a.tar', "ask"],
];
test.each(spellingWriteCases)("bash `%j` -> %s (#279 write spelling)", (command, kind) => {
  const result = decide(command);
  expect(result.kind).toBe(kind);
  if (kind === "ask") expect(result.reason).toBe(RAW_READ_PROVENANCE_REASON);
  if (kind === "deny") expect(result.code).toBe("raw-immutable");
});

// #279 resource limit: tarExtracts scans each segment from its first tar only.
test.each([
  ["'tar ' x 2e5 + prot", "tar ".repeat(2e5) + "prot"],
  ["'tar -' + 'a' x 5e5 + ' prot'", "tar -" + "a".repeat(5e5) + " prot"],
])("bash %s -> ask (#279 adversarial)", (_label, command) => {
  const result = decide(command);
  expect(result.kind).toBe("ask");
  expect(result.reason).toBe(RAW_READ_PROVENANCE_REASON);
});

// #283: tar writes an archive (c r u A, --create ... --delete) whose operand (first f
// of a short cluster, --file/--fil, old-style first cluster) is under any raw dir;
// raw as a packing source, -C and - (stdout) stay reads. bsdtar counts as tar.
type Setup = { rawDirs?: string[]; workdir?: string };
const multiRaw: Setup = { rawDirs: ["prot", "raw2"] };
const refRaw: Setup = { rawDirs: ["ref/raw"] };
const inProt: Setup = { workdir: "prot" };
function decideIn(command: string, setup: Setup = {}) {
  const args = setup.workdir === undefined ? { command } : { command, workdir: setup.workdir };
  const options = normalizeRawDirs({ rawDirs: setup.rawDirs ?? ["prot"] });
  return decideRawAccess({ name: "bash", arguments: args, cwd: spellWs }, options);
}
function expectKind(result: ReturnType<typeof decideIn>, kind: Kind) {
  expect(result.kind).toBe(kind);
  if (kind === "ask") expect(result.reason).toBe(RAW_READ_PROVENANCE_REASON);
  if (kind === "deny") expect(result.code).toBe("raw-immutable");
}
const tarArchiveCases: [string, Kind, Setup?][] = [
  ["tar -cf prot/a.tar x", "deny"],
  ["tar -rf prot/a.tar x", "deny"],
  ["tar -uf prot/a.tar x", "deny"],
  ["tar -Af prot/a.tar b.tar", "deny"],
  ["tar --delete -f prot/a.tar x", "deny"],
  ["tar cf prot/a.tar x", "deny"],
  ["tar --create --file=prot/a.tar x", "deny"],
  ["tar --append --file prot/a.tar x", "deny"],
  ["tar --up -f prot/a.tar x", "deny"],
  ["tar --cat -f prot/a.tar b.tar", "deny"],
  ["tar --conc -f prot/a.tar b.tar", "deny"],
  ["tar --cr --fil=prot/a.tar x", "deny"],
  ["tar -c -f prot/sub/a.tar x", "deny"],
  ["tar -f prot/a.tar -c x", "deny"],
  ["tar -cfprot/a.tar x", "deny"],
  ['tar -c -f "prot/a.tar" x', "deny"],
  ["tar -cf prot/a.tar x 2>/dev/null", "deny"],
  ["gtar -rf prot/a.tar x", "deny"],
  ["bsdtar -cf prot/a.tar x", "deny"],
  ["BSDTAR -cf prot/a.tar x", "deny"],
  // Fixture review r1 pins: the mode letter or f not first/last in its cluster, --ca.
  ["tar -zcf prot/a.tgz x", "deny"],
  ["tar zcf prot/a.tgz x", "deny"],
  ["tar cfv prot/a.tar x", "deny"],
  ["tar --ca -f prot/a.tar b.tar", "deny"],
  // The archive under another raw dir than the one touched; the first f of a cluster.
  ["tar -cf raw2/a.tar prot/x", "deny", multiRaw],
  ["tar -cfref/raw/a.tar x", "deny", refRaw],
  ["bsdtar -xf a.tar -C prot", "deny"],
  ["/usr/bin/bsdtar -xf a.tar -C prot", "deny"],
  // The operand resolves against workdir.
  ["tar -cf a.tar x", "deny", inProt],
  ["tar -cf o.tar prot", "ask"],
  ["tar -cf o.tar -C prot .", "ask"],
  ["tar -C prot -cf o.tar .", "ask"],
  ["tar -cf - prot | wc -c", "ask"],
  ["bsdtar -tf prot/a.tar", "ask"],
  ["cat prot/mybsdtar.log", "ask"],
  ["tar -tvf prot/a.tar -C work", "ask"],
  ["tar -tf prot/a.tar | grep -c -f prot/pat", "ask"],
  ["tar -tf prot/a.tar --delay", "ask"],
  ["tar -cf - x", "ask", inProt],
  ["tar -cf protx/a.tar x", "next"],
  // Accepted false positives: a glued option argument holding a mode letter, tar as text.
  ["tar -tf prot/a.tar -Hustar", "deny"],
  ['grep "tar -cf prot/a.tar" prot/log', "deny"],
];
test.each(tarArchiveCases)("bash `%j` -> %s (#283 tar archive)", (command, kind, setup) => {
  expectKind(decideIn(command, setup), kind);
});

// #283 resource limit: operands are deduplicated and every scan is linear.
test.each<[string, string, Kind]>([
  ["'tar -c ' + '-f x ' x 2e5", "tar -c " + "-f x ".repeat(2e5), "next"],
  ["'tar -c ' + '-f x ' x 2e5 + prot", "tar -c " + "-f x ".repeat(2e5) + "prot", "ask"],
  ["'tar -c -' + 'a' x 5e5 + ' prot'", "tar -c -" + "a".repeat(5e5) + " prot", "ask"],
  ["'tar c' + 'f' x 5e5 + '/ prot'", "tar c" + "f".repeat(5e5) + "/ prot", "ask"],
])("bash %s -> %s (#283 adversarial)", (_label, command, kind) => {
  expectKind(decideIn(command), kind);
});
