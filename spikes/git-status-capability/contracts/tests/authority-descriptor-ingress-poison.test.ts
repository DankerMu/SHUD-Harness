import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";

type Entry = "direct" | "checker";
type RawCounts = Readonly<{
  open_sync: number;
  openat: number;
  fstat_sync: number;
  read_sync: number;
  close_sync: number;
}>;
type EntryOutcome = Readonly<{ code: string; exit: number | null; stdout: string; stderr: string }>;
type PoisonReceipt = Readonly<{
  outerEntry: Entry;
  nestedEntry: Entry;
  outer: EntryOutcome;
  nested: EntryOutcome;
  laterDirect: EntryOutcome;
  laterChecker: EntryOutcome;
  nestedStarted: boolean;
  nestedMediatedCloseCalls: number;
  outerCloseAttempts: number;
  nestedCloseAttempts: readonly Readonly<{ owner: string; ordinal: number }>[];
  rawAtPoison: RawCounts;
  rawAfterOuter: RawCounts;
  rawAfterLater: RawCounts;
  postPoisonRaw: RawCounts;
  laterRaw: RawCounts;
  fdBaseline: number;
  fdAfterPoison: number;
  fdAfterLater: number;
}>;

const childPath = join(import.meta.dir, "authority-descriptor-ingress-poison-child.ts");
const ingressSourcePath = join(import.meta.dir, "../lib/ingress.ts");
const ERROR_RECEIPT = "{\"schema_version\":\"shud.git-status-capability.contract-error.v1\",\"status\":\"error\",\"code\":\"CONTRACT_SCHEMA_INVALID\"}\n";
const ZERO_RAW: RawCounts = Object.freeze({ open_sync: 0, openat: 0, fstat_sync: 0, read_sync: 0, close_sync: 0 });
const EVERY_OWNER_RETENTION = `    for (const owner of context.liveOwners.values()) {
      retainedPoisonedIngressOwners.set(owner.descriptor, owner);
    }`;

function poisonRetainsEveryActiveOwner(source: string): boolean {
  const tree = ts.createSourceFile("ingress.ts", source, ts.ScriptTarget.ES2022, true);
  let retainsEveryOwner = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === "poisonIngressAndRetainActiveOwners" &&
      node.body
    ) {
      retainsEveryOwner = node.body.getText(tree).includes(EVERY_OWNER_RETENTION);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return retainsEveryOwner;
}

function replaceEveryOwnerRetentionWithFirstOwnerOnly(source: string): string {
  if (!source.includes(EVERY_OWNER_RETENTION)) throw new Error("owner-retention loop anchor is absent");
  return source.replace(
    EVERY_OWNER_RETENTION,
    `    const owner = context.liveOwners.values().next().value;
    if (owner) retainedPoisonedIngressOwners.set(owner.descriptor, owner);`
  );
}

async function runPoisonProbe(outerEntry: Entry, nestedEntry: Entry): Promise<PoisonReceipt> {
  const child = Bun.spawn([process.execPath, childPath, outerEntry, nestedEntry], { stdout: "pipe", stderr: "pipe" });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ]);
  expect(exit).toBe(0);
  expect(stderr).toBe("");
  return JSON.parse(stdout) as PoisonReceipt;
}

function expectedEntry(entry: Entry): EntryOutcome {
  if (entry === "direct") {
    return { code: "CONTRACT_SCHEMA_INVALID", exit: null, stdout: "", stderr: "" };
  }
  return { code: "CONTRACT_SCHEMA_INVALID", exit: 2, stdout: "", stderr: ERROR_RECEIPT };
}

describe("ingress terminal close poison", () => {
  test("a nested refusal terminally blocks the outer close and later ingress work", async () => {
    for (const [outerEntry, nestedEntry] of [
      ["direct", "direct"],
      ["direct", "checker"],
      ["checker", "direct"]
    ] as const) {
      const receipt = await runPoisonProbe(outerEntry, nestedEntry);
      expect(receipt.outerEntry).toBe(outerEntry);
      expect(receipt.nestedEntry).toBe(nestedEntry);
      expect(receipt.outer).toEqual(expectedEntry(outerEntry));
      expect(receipt.nested).toEqual(expectedEntry(nestedEntry));
      expect(receipt.nestedStarted).toBe(true);
      expect(receipt.nestedMediatedCloseCalls).toBe(2);
      expect(receipt.outerCloseAttempts).toBe(1);
      expect(receipt.nestedCloseAttempts).toEqual([
        { owner: "unretained", ordinal: 1 },
        { owner: "unretained", ordinal: 2 }
      ]);
      expect(receipt.rawAtPoison.open_sync + receipt.rawAtPoison.openat).toBeGreaterThan(0);
      expect(receipt.postPoisonRaw).toEqual(ZERO_RAW);
      expect(receipt.laterRaw).toEqual(ZERO_RAW);
      expect(receipt.laterDirect).toEqual(expectedEntry("direct"));
      expect(receipt.laterChecker).toEqual(expectedEntry("checker"));
      expect(receipt.fdAfterPoison).toBeGreaterThan(receipt.fdBaseline);
      expect(receipt.fdAfterLater).toBe(receipt.fdAfterPoison);
    }
  });

  test("test-local source mutation rejects retaining only the first poisoned owner", async () => {
    const source = await readFile(ingressSourcePath, "utf8");
    expect(poisonRetainsEveryActiveOwner(source)).toBe(true);
    expect(poisonRetainsEveryActiveOwner(
      replaceEveryOwnerRetentionWithFirstOwnerOnly(source)
    )).toBe(false);
  });
});
