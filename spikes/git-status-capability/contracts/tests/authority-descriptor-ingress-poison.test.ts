import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withProductionTree } from "./authority-descriptor-vocabulary";
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
  liveOwnerCountAtPoison: number;
  retainedOwnerCountAfterContextDeletion: number | null;
}>;
type NoRawCloseMode = "omission" | "value" | "async" | "thenable" | "proxy" | "sentinel" | "hostile";
type NoRawBehavior = "once" | "persistent";
type NoRawReceipt = Readonly<{
  outerEntry: Entry;
  mode: NoRawCloseMode;
  behavior: NoRawBehavior;
  outer: EntryOutcome;
  laterDirect?: EntryOutcome;
  laterChecker?: EntryOutcome;
  refusedCloseCalls: number;
  mediatedCloseCalls?: number;
  mediatedCloseCallsAtPoison?: number;
  mediatedCloseCallsAfterLater?: number;
  firstCloseOwnerIds: readonly number[];
  secondCloseOwnerIds?: readonly number[];
  rawBeforeFirstClose: RawCounts;
  rawAfterFirstRawClose?: RawCounts | null;
  rawAfterOuter?: RawCounts;
  rawAtPoison?: RawCounts;
  rawAfterLater?: RawCounts;
  laterRaw?: RawCounts;
  retainedOwnerIdsAfterContextDeletion: readonly number[] | null;
}>;
type CloseAttempt = Readonly<{ owner: "unretained" | "retained" | "verification"; ordinal: number }>;
type PostRawReceipt = Readonly<{
  outerEntry: Entry;
  nestedEntry: Entry;
  faultMode: "false" | "true" | "throw";
  primaryMode: "none" | "prior_primary";
  outer: EntryOutcome;
  nested: EntryOutcome;
  target: CloseAttempt;
  outerCloseAttempts: readonly CloseAttempt[];
  nestedCloseAttempts: readonly CloseAttempt[];
  targetPreCloseOwnerIds: readonly number[];
  liveOwnerIdsAtPoison: readonly number[];
  retainedOwnerIdsAfterContextDeletion: readonly number[] | null;
  targetRawBefore: RawCounts;
  rawAtFault: RawCounts;
  rawAtPoison: RawCounts;
  rawAfterOuter: RawCounts;
  rawAfterLater: RawCounts;
  postPoisonRaw: RawCounts;
  laterRaw: RawCounts;
  nestedStarted: boolean;
  nestedMediatedCloseCalls: number;
}>;

const childPath = join(import.meta.dir, "authority-descriptor-ingress-poison-child.ts");
const ERROR_RECEIPT = "{\"schema_version\":\"shud.git-status-capability.contract-error.v1\",\"status\":\"error\",\"code\":\"CONTRACT_SCHEMA_INVALID\"}\n";
const ZERO_RAW: RawCounts = Object.freeze({ open_sync: 0, openat: 0, fstat_sync: 0, read_sync: 0, close_sync: 0 });
const PRODUCTION_ROOT_ENV = "SHUD_DESCRIPTOR_PRODUCTION_ROOT";
const NO_RAW_CLOSE_MODES = ["omission", "value", "async", "thenable", "proxy", "sentinel", "hostile"] as const;
const POST_RAW_PAIRINGS = [
  ["direct", "direct"],
  ["direct", "checker"],
  ["checker", "direct"]
] as const;
const BYTES_LIMIT_RECEIPT = "{\"schema_version\":\"shud.git-status-capability.contract-error.v1\",\"status\":\"error\",\"code\":\"CONTRACT_BYTES_LIMIT\"}\n";
const EVERY_OWNER_RETENTION = `    for (const owner of context.liveOwners.values()) {
      retainedPoisonedIngressOwners.set(owner.descriptor, owner);
    }`;

function replaceEveryOwnerRetentionWithFirstOwnerOnly(source: string): string {
  if (!source.includes(EVERY_OWNER_RETENTION)) throw new Error("owner-retention loop anchor is absent");
  return source.replace(
    EVERY_OWNER_RETENTION,
    `    const owner = context.liveOwners.values().next().value;
    if (owner) retainedPoisonedIngressOwners.set(owner.descriptor, owner);`
  );
}

function injectPoisonRetentionCount(source: string): string {
  return `${source}
export const __poisonRetainedOwnerCount = (): number => retainedPoisonedIngressOwners.size;
export const __poisonRetainedOwnersForTest = (): readonly unknown[] => [...retainedPoisonedIngressOwners.values()];
`;
}

async function runCopiedPoisonProof(
  outerEntry: Entry,
  nestedEntry: Entry,
  firstOwnerOnly: boolean
): Promise<PoisonReceipt> {
  let receipt: PoisonReceipt | undefined;
  await withProductionTree(undefined, async (tree) => {
    const ingressPath = join(tree.root, "lib", "ingress.ts");
    const source = await readFile(ingressPath, "utf8");
    await writeFile(
      ingressPath,
      injectPoisonRetentionCount(firstOwnerOnly ? replaceEveryOwnerRetentionWithFirstOwnerOnly(source) : source)
    );
    receipt = await runPoisonProbe(outerEntry, nestedEntry, tree.root);
  });
  if (!receipt) throw new Error("copied poison proof did not produce a receipt");
  return receipt;
}

async function childReceipt<T>(args: readonly string[], productionRoot?: string): Promise<T> {
  const child = Bun.spawn([process.execPath, childPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    ...(productionRoot ? { env: { ...process.env, [PRODUCTION_ROOT_ENV]: productionRoot } } : {})
  });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ]);
  expect(exit).toBe(0);
  expect(stderr).toBe("");
  return JSON.parse(stdout) as T;
}

async function runPoisonProbe(
  outerEntry: Entry,
  nestedEntry: Entry,
  productionRoot?: string
): Promise<PoisonReceipt> {
  return await childReceipt<PoisonReceipt>([outerEntry, nestedEntry], productionRoot);
}

async function runNoRawProbe(
  mode: NoRawCloseMode,
  behavior: NoRawBehavior,
  outerEntry: Entry,
  productionRoot?: string
): Promise<NoRawReceipt> {
  return await childReceipt<NoRawReceipt>(["no_raw", mode, behavior, outerEntry], productionRoot);
}

async function runPostRawProbe(
  outerEntry: Entry,
  nestedEntry: Entry,
  faultMode: PostRawReceipt["faultMode"],
  primaryMode: PostRawReceipt["primaryMode"],
  productionRoot?: string
): Promise<PostRawReceipt> {
  return await childReceipt<PostRawReceipt>(
    ["post_raw", outerEntry, nestedEntry, faultMode, primaryMode],
    productionRoot
  );
}

function expectedEntry(entry: Entry): EntryOutcome {
  if (entry === "direct") {
    return { code: "CONTRACT_SCHEMA_INVALID", exit: null, stdout: "", stderr: "" };
  }
  return { code: "CONTRACT_SCHEMA_INVALID", exit: 2, stdout: "", stderr: ERROR_RECEIPT };
}

function injectOmissionOnlyNoRawRestore(source: string): string {
  const anchor = `    if (!rawCloseAttempted) {
      record.state = stateBeforeClose;
      // A second ingress query acknowledges that this close never started raw work.
      allowsIngressRawClose(this);
      throw closeError;
    }`;
  if (!source.includes(anchor)) throw new Error("selective no-raw restoration mutation anchor is absent");
  return source.replace(anchor, `    if (!rawCloseAttempted) {
      if (closeError instanceof Error &&
          closeError.message === "CONTRACT_CAPABILITY_PRIMITIVE_MEDIATOR_INVOCATION_MISSING") {
        record.state = stateBeforeClose;
        // A second ingress query acknowledges that this close never started raw work.
        allowsIngressRawClose(this);
      }
      throw closeError;
    }`);
}

function releaseFirstNoRawTicketOwner(source: string): string {
  const anchor = `      if (descriptorIngressPoisoned) return true;
      if (attempt + 1 === NO_RAW_CLOSE_RETRY_LIMIT) {`;
  if (!source.includes(anchor)) throw new Error("first-ticket owner-release mutation anchor is absent");
  return source.replace(anchor, `      if (descriptorIngressPoisoned) return true;
      if (attempt === 0) releaseLiveIngressOwner(context, descriptor);
      if (attempt + 1 === NO_RAW_CLOSE_RETRY_LIMIT) {`);
}

function removeSentinelPoisonTransition(source: string): string {
  const anchor = `      if (attempt + 1 === NO_RAW_CLOSE_RETRY_LIMIT) {
        poisonIngressAndRetainActiveOwners();
        throw retry.outcome;
      }`;
  if (!source.includes(anchor)) throw new Error("per-class poison transition mutation anchor is absent");
  return source.replace(anchor, `      if (attempt + 1 === NO_RAW_CLOSE_RETRY_LIMIT) {
        if (retry.outcome instanceof Error && retry.outcome.message === "NO_RAW_SENTINEL") {
          throw retry.outcome;
        }
        poisonIngressAndRetainActiveOwners();
        throw retry.outcome;
      }`);
}

function removeCommonPostClosePoisonGuard(source: string): string {
  const anchor = `  if (descriptorIngressPoisoned) return true;
  releaseLiveIngressOwner(context, descriptor);`;
  if (!source.includes(anchor)) throw new Error("common post-close poison guard mutation anchor is absent");
  return source.replace(anchor, "  releaseLiveIngressOwner(context, descriptor);");
}

type NoRawMutation = "baseline" | "omission_only" | "first_ticket_release" | "missing_sentinel_poison";

async function runCopiedNoRawProbe(
  mode: NoRawCloseMode,
  behavior: NoRawBehavior,
  outerEntry: Entry,
  mutation: NoRawMutation
): Promise<NoRawReceipt> {
  let receipt: NoRawReceipt | undefined;
  await withProductionTree(undefined, async (tree) => {
    if (mutation === "omission_only") {
      const capabilities = await readFile(tree.capabilitiesPath, "utf8");
      await writeFile(tree.capabilitiesPath, injectOmissionOnlyNoRawRestore(capabilities));
    }
    const ingressPath = join(tree.root, "lib", "ingress.ts");
    let ingress = await readFile(ingressPath, "utf8");
    if (mutation === "first_ticket_release") ingress = releaseFirstNoRawTicketOwner(ingress);
    if (mutation === "missing_sentinel_poison") ingress = removeSentinelPoisonTransition(ingress);
    await writeFile(ingressPath, injectPoisonRetentionCount(ingress));
    receipt = await runNoRawProbe(mode, behavior, outerEntry, tree.root);
  });
  if (!receipt) throw new Error("copied no-raw proof did not produce a receipt");
  return receipt;
}

async function runCopiedPostRawProbe(
  outerEntry: Entry,
  nestedEntry: Entry,
  faultMode: PostRawReceipt["faultMode"],
  primaryMode: PostRawReceipt["primaryMode"],
  withoutCommonGuard: boolean
): Promise<PostRawReceipt> {
  let receipt: PostRawReceipt | undefined;
  await withProductionTree(undefined, async (tree) => {
    const ingressPath = join(tree.root, "lib", "ingress.ts");
    const source = await readFile(ingressPath, "utf8");
    await writeFile(
      ingressPath,
      injectPoisonRetentionCount(withoutCommonGuard ? removeCommonPostClosePoisonGuard(source) : source)
    );
    receipt = await runPostRawProbe(outerEntry, nestedEntry, faultMode, primaryMode, tree.root);
  });
  if (!receipt) throw new Error("copied post-raw proof did not produce a receipt");
  return receipt;
}

function expectedPriorPrimary(entry: Entry): EntryOutcome {
  if (entry === "direct") {
    return { code: "CONTRACT_BYTES_LIMIT", exit: null, stdout: "", stderr: "" };
  }
  return { code: "CONTRACT_BYTES_LIMIT", exit: 2, stdout: "", stderr: BYTES_LIMIT_RECEIPT };
}

function expectSuccessfulEntry(entry: Entry, outcome: EntryOutcome): void {
  expect(outcome.code).toBe("NO_ERROR");
  expect(outcome.exit).toBe(entry === "direct" ? null : 0);
  expect(outcome.stderr).toBe("");
  if (entry === "direct") {
    expect(outcome.stdout).toBe("");
  } else {
    expect(outcome.stdout).not.toBe("");
  }
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
      expect(receipt.liveOwnerCountAtPoison).toBeGreaterThan(1);
      expect(receipt.retainedOwnerCountAfterContextDeletion).toBeNull();
    }
  });

  test("copied-source cardinality receipts kill first-owner-only poison retention", async () => {
    for (const [outerEntry, nestedEntry] of [
      ["direct", "direct"],
      ["direct", "checker"],
      ["checker", "direct"]
    ] as const) {
      const baseline = await runCopiedPoisonProof(outerEntry, nestedEntry, false);
      expect(baseline.liveOwnerCountAtPoison).toBeGreaterThan(1);
      expect(baseline.retainedOwnerCountAfterContextDeletion).toBe(baseline.liveOwnerCountAtPoison);

      const mutated = await runCopiedPoisonProof(outerEntry, nestedEntry, true);
      expect(mutated.liveOwnerCountAtPoison).toBe(baseline.liveOwnerCountAtPoison);
      expect(mutated.retainedOwnerCountAfterContextDeletion).toBeLessThan(mutated.liveOwnerCountAtPoison);
    }
  });

  test("every no-raw close class retries once, then retains the anchored owner set on poison", async () => {
    for (const mode of NO_RAW_CLOSE_MODES) {
      for (const outerEntry of ["direct", "checker"] as const) {
        const firstRefusal = await runCopiedNoRawProbe(mode, "once", outerEntry, "baseline");
        expect(firstRefusal.mode).toBe(mode);
        expect(firstRefusal.behavior).toBe("once");
        expectSuccessfulEntry(outerEntry, firstRefusal.outer);
        expect(firstRefusal.refusedCloseCalls).toBe(1);
        expect(firstRefusal.firstCloseOwnerIds.length).toBeGreaterThan(0);
        const rawAfterFirstRetry = firstRefusal.rawAfterFirstRawClose;
        expect(rawAfterFirstRetry).not.toBeNull();
        expect(rawAfterFirstRetry?.close_sync).toBe(firstRefusal.rawBeforeFirstClose.close_sync + 1);

        const persistentRefusal = await runCopiedNoRawProbe(mode, "persistent", outerEntry, "baseline");
        expect(persistentRefusal.mode).toBe(mode);
        expect(persistentRefusal.behavior).toBe("persistent");
        expect(persistentRefusal.outer).toEqual(expectedEntry(outerEntry));
        expect(persistentRefusal.refusedCloseCalls).toBe(2);
        expect(persistentRefusal.mediatedCloseCallsAtPoison).toBe(2);
        expect(persistentRefusal.mediatedCloseCallsAfterLater).toBe(2);
        expect(persistentRefusal.rawAtPoison?.close_sync).toBe(
          persistentRefusal.rawBeforeFirstClose.close_sync
        );
        expect(persistentRefusal.firstCloseOwnerIds.length).toBeGreaterThan(0);
        expect(persistentRefusal.secondCloseOwnerIds).toEqual(persistentRefusal.firstCloseOwnerIds);
        expect(persistentRefusal.retainedOwnerIdsAfterContextDeletion).toEqual(
          persistentRefusal.firstCloseOwnerIds
        );
        expect(persistentRefusal.laterDirect).toEqual(expectedEntry("direct"));
        expect(persistentRefusal.laterChecker).toEqual(expectedEntry("checker"));
        expect(persistentRefusal.laterRaw).toEqual(ZERO_RAW);
      }
    }
  });

  test("the omission-only restoration and ticket mutation leaves only omission ingress rows green", async () => {
    for (const mode of NO_RAW_CLOSE_MODES) {
      for (const outerEntry of ["direct", "checker"] as const) {
        const firstRefusal = await runCopiedNoRawProbe(mode, "once", outerEntry, "omission_only");
        const persistentRefusal = await runCopiedNoRawProbe(
          mode,
          "persistent",
          outerEntry,
          "omission_only"
        );
        if (mode === "omission") {
          expectSuccessfulEntry(outerEntry, firstRefusal.outer);
          expect(firstRefusal.refusedCloseCalls).toBe(1);
          expect(firstRefusal.rawAfterFirstRawClose?.close_sync).toBe(
            firstRefusal.rawBeforeFirstClose.close_sync + 1
          );
          expect(persistentRefusal.outer).toEqual(expectedEntry(outerEntry));
          expect(persistentRefusal.mediatedCloseCallsAtPoison).toBe(2);
          expect(persistentRefusal.mediatedCloseCallsAfterLater).toBe(2);
          expect(persistentRefusal.retainedOwnerIdsAfterContextDeletion).toEqual(
            persistentRefusal.firstCloseOwnerIds
          );
        } else {
          expect(firstRefusal.outer.code).not.toBe("NO_ERROR");
          const callsBeforeLater = persistentRefusal.mediatedCloseCallsAtPoison ?? 0;
          expect(callsBeforeLater).toBeGreaterThan(0);
          expect(persistentRefusal.mediatedCloseCallsAfterLater).toBeGreaterThan(callsBeforeLater);
        }
      }
    }
  });

  test("the first-ticket owner-release mutation loses the pre-close owner identity before poison", async () => {
    for (const outerEntry of ["direct", "checker"] as const) {
      const mutated = await runCopiedNoRawProbe(
        "omission",
        "persistent",
        outerEntry,
        "first_ticket_release"
      );
      expect(mutated.firstCloseOwnerIds.length).toBeGreaterThan(0);
      expect(mutated.secondCloseOwnerIds).not.toEqual(mutated.firstCloseOwnerIds);
      expect(mutated.retainedOwnerIdsAfterContextDeletion).not.toEqual(mutated.firstCloseOwnerIds);
      expect(mutated.retainedOwnerIdsAfterContextDeletion).toEqual(mutated.secondCloseOwnerIds);
    }
  });

  test("the missing sentinel poison transition admits later work and increases mediation", async () => {
    for (const outerEntry of ["direct", "checker"] as const) {
      const mutated = await runCopiedNoRawProbe(
        "sentinel",
        "persistent",
        outerEntry,
        "missing_sentinel_poison"
      );
      const callsBeforeLater = mutated.mediatedCloseCallsAtPoison ?? 0;
      expect(callsBeforeLater).toBeGreaterThan(0);
      expect(mutated.mediatedCloseCallsAfterLater).toBeGreaterThan(callsBeforeLater);
      expect(mutated.laterRaw).not.toEqual(ZERO_RAW);
    }
  });

  test("post-raw nested poison retains the final retained/root owner across all settlement exits", async () => {
    for (const [outerEntry, nestedEntry] of POST_RAW_PAIRINGS) {
      for (const faultMode of ["false", "true", "throw"] as const) {
        for (const primaryMode of ["none", "prior_primary"] as const) {
          const receipt = await runCopiedPostRawProbe(
            outerEntry,
            nestedEntry,
            faultMode,
            primaryMode,
            false
          );
          expect(receipt.outer).toEqual(
            primaryMode === "none" ? expectedEntry(outerEntry) : expectedPriorPrimary(outerEntry)
          );
          expect(receipt.nested).toEqual(expectedEntry(nestedEntry));
          expect(receipt.target.owner).toBe("retained");
          expect(receipt.target.ordinal).toBeGreaterThan(0);
          expect(receipt.outerCloseAttempts.at(-1)).toEqual(receipt.target);
          expect(receipt.targetPreCloseOwnerIds).toHaveLength(1);
          const targetOwnerId = receipt.targetPreCloseOwnerIds[0]!;
          expect(receipt.liveOwnerIdsAtPoison).toContain(targetOwnerId);
          expect(receipt.retainedOwnerIdsAfterContextDeletion).toEqual(receipt.liveOwnerIdsAtPoison);
          expect(receipt.rawAtFault.close_sync).toBe(receipt.targetRawBefore.close_sync + 1);
          expect(receipt.rawAtPoison.close_sync).toBe(receipt.rawAtFault.close_sync);
          expect(receipt.rawAfterOuter.close_sync).toBe(receipt.rawAtPoison.close_sync);
          expect(receipt.nestedStarted).toBe(true);
          expect(receipt.nestedMediatedCloseCalls).toBe(2);
          expect(receipt.nestedCloseAttempts).toEqual([
            { owner: "unretained", ordinal: 1 },
            { owner: "unretained", ordinal: 2 }
          ]);
          expect(receipt.postPoisonRaw).toEqual(ZERO_RAW);
          expect(receipt.laterDirect).toEqual(expectedEntry("direct"));
          expect(receipt.laterChecker).toEqual(expectedEntry("checker"));
          expect(receipt.laterRaw).toEqual(ZERO_RAW);
        }
      }
    }
  });

  test("deleting the common post-close poison guard loses the target owner in every settlement row", async () => {
    for (const [outerEntry, nestedEntry] of POST_RAW_PAIRINGS) {
      for (const faultMode of ["false", "true", "throw"] as const) {
        for (const primaryMode of ["none", "prior_primary"] as const) {
          const mutated = await runCopiedPostRawProbe(
            outerEntry,
            nestedEntry,
            faultMode,
            primaryMode,
            true
          );
          expect(mutated.targetPreCloseOwnerIds).toHaveLength(1);
          const targetOwnerId = mutated.targetPreCloseOwnerIds[0]!;
          expect(mutated.liveOwnerIdsAtPoison).toContain(targetOwnerId);
          const retainedOwnerIds = mutated.retainedOwnerIdsAfterContextDeletion ?? [];
          expect(retainedOwnerIds).not.toContain(targetOwnerId);
          expect(retainedOwnerIds).not.toEqual(mutated.liveOwnerIdsAtPoison);
        }
      }
    }
  });
});
