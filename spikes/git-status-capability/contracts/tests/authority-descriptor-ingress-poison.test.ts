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
  outerCloseBaseline: RawCounts;
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
  closeAttempts: readonly CloseAttempt[];
  mediatedCloseCalls?: number;
  mediatedCloseCallsAtPoison?: number;
  mediatedCloseCallsAfterLater?: number;
  firstCloseOwnerIds: readonly number[];
  secondCloseOwnerIds?: readonly number[];
  rawAtFirstAttempt: RawCounts;
  rawAtSecondAttempt?: RawCounts;
  rawAfterFirstRawClose?: RawCounts | null;
  rawAfterOuter?: RawCounts;
  rawAtPoison?: RawCounts;
  rawAfterLater?: RawCounts;
  laterRaw?: RawCounts;
  retainedOwnerIdsAfterContextDeletion: readonly number[] | null;
}>;

type MixedPreRawReceipt = Readonly<{
  outerEntry: Entry;
  outer: EntryOutcome;
  laterDirect: EntryOutcome;
  laterChecker: EntryOutcome;
  closeAttempts: readonly CloseAttempt[];
  mediatedCloseCalls: number;
  rawAfterOuter: RawCounts;
  rawAfterLater: RawCounts;
  laterRaw: RawCounts;
  fdBaseline: number;
  fdAfterOuter: number;
  fdAfterLater: number;
}>;

type SamePairReentrantReceipt = Readonly<{
  outerEntry: Entry;
  outer: EntryOutcome;
  later: EntryOutcome;
  reentrantCloseCalls: number;
  targetRawCloseCalls: number;
  closedDescriptorDenials: number;
  fdBaseline: number;
  fdAfterOuter: number;
  fdAfterLater: number;
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

type MapClearNoRawReceipt = Readonly<{
  outerEntry: Entry;
  nestedEntry: Entry;
  outer: EntryOutcome;
  nested: EntryOutcome;
  laterDirect: EntryOutcome;
  laterChecker: EntryOutcome;
  nestedStarted: boolean;
  nestedMediatedCloseCalls: number;
  outerCloseAttempts: number;
  nestedCloseAttempts: readonly CloseAttempt[];
  mapClearCaptureAttempts: number;
  mapClearCapturedOwnerStore: boolean;
  outerOwnerIdsBeforeClear: readonly number[];
  outerOwnerIdsAfterClear: readonly number[];
  nestedOwnerIdsBeforePoison: readonly number[];
  preCloseOwnerIds: readonly number[];
  retainedOwnerIdsAfterContextDeletion: readonly number[] | null;
  outerCloseBaseline: RawCounts;
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
const ERROR_RECEIPT = "{\"schema_version\":\"shud.git-status-capability.contract-error.v1\",\"status\":\"error\",\"code\":\"CONTRACT_SCHEMA_INVALID\"}\n";
const ZERO_RAW: RawCounts = Object.freeze({ open_sync: 0, openat: 0, fstat_sync: 0, read_sync: 0, close_sync: 0 });
const PRODUCTION_ROOT_ENV = "SHUD_DESCRIPTOR_PRODUCTION_ROOT";
const NO_RAW_CLOSE_MODES = ["omission", "value", "async", "thenable", "proxy", "sentinel", "hostile"] as const;
const POST_RAW_PAIRINGS = [
  ["direct", "direct"],
  ["direct", "checker"],
  ["checker", "direct"]
] as const;

const MAP_CLEAR_PAIRINGS = [
  ["direct", "direct"],
  ["direct", "checker"],
  ["checker", "direct"]
] as const;
const BYTES_LIMIT_RECEIPT = "{\"schema_version\":\"shud.git-status-capability.contract-error.v1\",\"status\":\"error\",\"code\":\"CONTRACT_BYTES_LIMIT\"}\n";
const EVERY_OWNER_RETENTION = `  retainLiveOwners(): void {
    for (let owner = this.#liveOwners; owner; owner = owner.next()) {
      retainPoisonedIngressOwner(owner);
    }
  }`;

function replaceEveryOwnerRetentionWithFirstOwnerOnly(source: string): string {
  if (!source.includes(EVERY_OWNER_RETENTION)) throw new Error("owner-retention loop anchor is absent");
  return source.replace(
    EVERY_OWNER_RETENTION,
    `  retainLiveOwners(): void {
    const owner = this.#liveOwners;
    if (owner) retainPoisonedIngressOwner(owner);
  }`
  );
}

function injectPoisonRetentionCount(source: string): string {
  return `${source}
export const __poisonRetainedOwnerCount = (): number => {
  let count = 0;
  for (let owner = retainedPoisonedIngressOwners; owner; owner = owner.retainedNext()) count += 1;
  return count;
};
export const __poisonRetainedOwnerDescriptorsForTest = (): readonly unknown[] => {
  const descriptors: CapabilityDescriptor[] = [];
  for (let owner = retainedPoisonedIngressOwners; owner; owner = owner.retainedNext()) {
    descriptors.push(owner.descriptor());
  }
  return Object.freeze(descriptors);
};
export const __poisonLiveOwnerDescriptorsForTest = (): readonly unknown[] => {
  const descriptors: CapabilityDescriptor[] = [];
  for (let context = activeIngressContexts; context; context = context.nextActive()) {
    context.appendLiveOwnerDescriptors(descriptors);
  }
  return Object.freeze(descriptors);
};
export const __poisonActiveOwnerDescriptorsForTest = (): readonly (readonly unknown[])[] => {
  const contexts: (readonly CapabilityDescriptor[])[] = [];
  for (let context = activeIngressContexts; context; context = context.nextActive()) {
    const descriptors: CapabilityDescriptor[] = [];
    context.appendLiveOwnerDescriptors(descriptors);
    contexts.push(Object.freeze(descriptors));
  }
  return Object.freeze(contexts);
};
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

async function runCopiedMapClearNoRawProbe(
  outerEntry: Entry,
  nestedEntry: Entry
): Promise<MapClearNoRawReceipt> {
  let receipt: MapClearNoRawReceipt | undefined;
  await withProductionTree(undefined, async (tree) => {
    const ingressPath = join(tree.root, "lib", "ingress.ts");
    const ingress = await readFile(ingressPath, "utf8");
    await writeFile(ingressPath, injectPoisonRetentionCount(ingress));
    receipt = await childReceipt<MapClearNoRawReceipt>(
      ["map_clear_no_raw", outerEntry, nestedEntry],
      tree.root
    );
  });
  if (!receipt) throw new Error("copied map-clear no-raw proof did not produce a receipt");
  return receipt;
}

function moveRawCloseBeforeCloseAttempt(source: string): string {
  const anchor = `  close(descriptor: CapabilityDescriptor, owner: CloseOwner): void {
    const attempt = Object.freeze({ owner, ordinal: ++this.#closeOrdinal });`;
  if (!source.includes(anchor)) throw new Error("ingress pre-hook raw close mutation anchor is absent");
  return source.replace(anchor, `  close(descriptor: CapabilityDescriptor, owner: CloseOwner): void {
    if (!this.#activeNext) this.#capabilities.close(descriptor, owner);
    const attempt = Object.freeze({ owner, ordinal: ++this.#closeOrdinal });`);
}

async function runCopiedPreRawOrderingProbe(
  outerEntry: Entry,
  nestedEntry: Entry
): Promise<PoisonReceipt> {
  let receipt: PoisonReceipt | undefined;
  await withProductionTree(undefined, async (tree) => {
    const ingressPath = join(tree.root, "lib", "ingress.ts");
    await writeFile(ingressPath, moveRawCloseBeforeCloseAttempt(await readFile(ingressPath, "utf8")));
    receipt = await runPoisonProbe(outerEntry, nestedEntry, tree.root);
  });
  if (!receipt) throw new Error("copied pre-raw ordering proof did not produce a receipt");
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

async function runMixedPreRawProbe(
  outerEntry: Entry,
  productionRoot?: string
): Promise<MixedPreRawReceipt> {
  return await childReceipt<MixedPreRawReceipt>(["mixed_pre_raw", outerEntry], productionRoot);
}

async function runSamePairReentrantProbe(
  outerEntry: Entry,
  productionRoot?: string
): Promise<SamePairReentrantReceipt> {
  return await childReceipt<SamePairReentrantReceipt>(["same_pair_reentrant", outerEntry], productionRoot);
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
      throw closeError;
    }`;
  if (!source.includes(anchor)) throw new Error("selective no-raw restoration mutation anchor is absent");
  return source.replace(anchor, `    if (!rawCloseAttempted) {
      if (closeError instanceof Error &&
          closeError.message === "CONTRACT_CAPABILITY_PRIMITIVE_MEDIATOR_INVOCATION_MISSING") {
        record.state = stateBeforeClose;
      }
      throw closeError;
    }`);
}

function releaseFirstNoRawAttemptOwner(source: string): string {
  const anchor = `      if (attempt + 1 === NO_RAW_CLOSE_RETRY_LIMIT) {`;
  if (!source.includes(anchor)) throw new Error("first-attempt owner-release mutation anchor is absent");
  return source.replace(anchor, `      if (attempt === 0) releaseLiveIngressOwner(context, descriptor);
      if (attempt + 1 === NO_RAW_CLOSE_RETRY_LIMIT) {`);
}

function insertRawFstatBetweenNoRawAttempts(source: string): string {
  const anchor = `      if (attempt + 1 === NO_RAW_CLOSE_RETRY_LIMIT) {`;
  if (!source.includes(anchor)) throw new Error("between-attempt raw fstat mutation anchor is absent");
  return source.replace(anchor, `      if (attempt === 0) context.stat(descriptor);
      if (attempt + 1 === NO_RAW_CLOSE_RETRY_LIMIT) {`);
}

function removeSentinelPoisonTransition(source: string): string {
  const anchor = `      if (attempt + 1 === NO_RAW_CLOSE_RETRY_LIMIT) {
        poisonIngressAndRetainActiveOwners();
        if (closeThrew) throw closeError;
        throw new ContractError("CONTRACT_SCHEMA_INVALID");
      }`;
  if (!source.includes(anchor)) throw new Error("per-class poison transition mutation anchor is absent");
  return source.replace(anchor, `      if (attempt + 1 === NO_RAW_CLOSE_RETRY_LIMIT) {
        if (closeError instanceof Error && closeError.message === "NO_RAW_SENTINEL") {
          if (closeThrew) throw closeError;
          throw new ContractError("CONTRACT_SCHEMA_INVALID");
        }
        poisonIngressAndRetainActiveOwners();
        if (closeThrew) throw closeError;
        throw new ContractError("CONTRACT_SCHEMA_INVALID");
      }`);
}

function permitThirdPreRawAttempt(source: string): string {
  const anchor = `      if (attempt + 1 === NO_RAW_CLOSE_RETRY_LIMIT) {`;
  if (!source.includes(anchor)) throw new Error("total pre-raw ceiling mutation anchor is absent");
  return source.replace(anchor, `      if (attempt + 1 === NO_RAW_CLOSE_RETRY_LIMIT + 1) {`);
}

function removeCommonPostClosePoisonGuard(source: string): string {
  const anchor = `  if (descriptorIngressPoisoned) return true;
  releaseLiveIngressOwner(context, descriptor);`;
  if (!source.includes(anchor)) throw new Error("common post-close poison guard mutation anchor is absent");
  return source.replace(anchor, "  releaseLiveIngressOwner(context, descriptor);");
}

type NoRawMutation =
  | "baseline"
  | "omission_only"
  | "first_attempt_release"
  | "missing_sentinel_poison"
  | "raw_fstat_between_attempts";

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
    if (mutation === "first_attempt_release") ingress = releaseFirstNoRawAttemptOwner(ingress);
    if (mutation === "raw_fstat_between_attempts") ingress = insertRawFstatBetweenNoRawAttempts(ingress);
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

async function runCopiedMixedPreRawProbe(
  outerEntry: Entry,
  permitThird: boolean
): Promise<MixedPreRawReceipt> {
  let receipt: MixedPreRawReceipt | undefined;
  await withProductionTree(undefined, async (tree) => {
    const ingressPath = join(tree.root, "lib", "ingress.ts");
    const source = await readFile(ingressPath, "utf8");
    await writeFile(ingressPath, permitThird ? permitThirdPreRawAttempt(source) : source);
    receipt = await runMixedPreRawProbe(outerEntry, tree.root);
  });
  if (!receipt) throw new Error("copied mixed pre-raw proof did not produce a receipt");
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

function rawDelta(after: RawCounts, before: RawCounts): RawCounts {
  return {
    open_sync: after.open_sync - before.open_sync,
    openat: after.openat - before.openat,
    fstat_sync: after.fstat_sync - before.fstat_sync,
    read_sync: after.read_sync - before.read_sync,
    close_sync: after.close_sync - before.close_sync
  };
}

function expectPreRawOuterCloseOrdering(receipt: PoisonReceipt): void {
  expect(rawDelta(receipt.rawAtPoison, receipt.outerCloseBaseline).close_sync).toBe(0);
}

function expectPersistentNoRawTransitions(receipt: NoRawReceipt): void {
  const { rawAtSecondAttempt, rawAtPoison, rawAfterOuter } = receipt;
  if (!rawAtSecondAttempt || !rawAtPoison || !rawAfterOuter) {
    throw new Error("persistent no-raw receipt lacks transition snapshots");
  }
  expect(rawDelta(rawAtSecondAttempt, receipt.rawAtFirstAttempt)).toEqual(ZERO_RAW);
  expect(rawDelta(rawAtPoison, rawAtSecondAttempt)).toEqual(ZERO_RAW);
  expect(rawDelta(rawAfterOuter, rawAtPoison)).toEqual(ZERO_RAW);
}

function expectPersistentNoRawPoisonState(outerEntry: Entry, receipt: NoRawReceipt): void {
  expect(receipt.outer).toEqual(expectedEntry(outerEntry));
  expect(receipt.closeAttempts.map((attempt) => attempt.ordinal)).toEqual([1, 2]);
  expect(receipt.refusedCloseCalls).toBe(2);
  expect(receipt.mediatedCloseCallsAtPoison).toBe(2);
  expect(receipt.mediatedCloseCallsAfterLater).toBe(2);
  expect(receipt.firstCloseOwnerIds.length).toBeGreaterThan(0);
  expect(receipt.secondCloseOwnerIds).toEqual(receipt.firstCloseOwnerIds);
  expect(receipt.retainedOwnerIdsAfterContextDeletion).toEqual(receipt.firstCloseOwnerIds);
  expect(receipt.laterDirect).toEqual(expectedEntry("direct"));
  expect(receipt.laterChecker).toEqual(expectedEntry("checker"));
  expect(receipt.laterRaw).toEqual(ZERO_RAW);
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
      expectPreRawOuterCloseOrdering(receipt);
      expect(receipt.postPoisonRaw).toEqual(ZERO_RAW);
      expect(receipt.laterRaw).toEqual(ZERO_RAW);
      expect(receipt.laterDirect).toEqual(expectedEntry("direct"));
      expect(receipt.laterChecker).toEqual(expectedEntry("checker"));
      expect(receipt.fdAfterPoison).toBeGreaterThan(receipt.fdBaseline);
      expect(receipt.fdAfterLater).toBe(receipt.fdAfterPoison);
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

  test("a Map-capture attempt cannot alter the private outer owner snapshot", async () => {
    for (const [outerEntry, nestedEntry] of MAP_CLEAR_PAIRINGS) {
      const receipt = await runCopiedMapClearNoRawProbe(outerEntry, nestedEntry);
      expect(receipt.outer).toEqual(expectedEntry(outerEntry));
      expect(receipt.nested).toEqual(expectedEntry(nestedEntry));
      expect(receipt.nestedStarted).toBe(true);
      expect(receipt.nestedMediatedCloseCalls).toBe(2);
      expect(receipt.outerCloseAttempts).toBe(1);
      expect(receipt.nestedCloseAttempts).toEqual([
        { owner: "unretained", ordinal: 1 },
        { owner: "unretained", ordinal: 2 }
      ]);
      expect(receipt.mapClearCaptureAttempts).toBe(1);
      expect(receipt.mapClearCapturedOwnerStore).toBe(false);
      expect(receipt.outerOwnerIdsBeforeClear.length).toBeGreaterThan(0);
      expect(receipt.outerOwnerIdsAfterClear).toEqual(receipt.outerOwnerIdsBeforeClear);
      expect(receipt.nestedOwnerIdsBeforePoison.length).toBeGreaterThan(0);
      const expectedPreCloseOwnerIds = [
        ...receipt.outerOwnerIdsBeforeClear,
        ...receipt.nestedOwnerIdsBeforePoison
      ].sort((left, right) => left - right);
      expect(receipt.preCloseOwnerIds).toEqual(expectedPreCloseOwnerIds);
      expect(receipt.preCloseOwnerIds).toHaveLength(
        receipt.outerOwnerIdsBeforeClear.length + receipt.nestedOwnerIdsBeforePoison.length
      );
      const retainedOwnerIds = receipt.retainedOwnerIdsAfterContextDeletion;
      if (retainedOwnerIds === null) throw new Error("map-clear no-raw proof lacks retained-owner receipt");
      expect(retainedOwnerIds).toEqual(receipt.preCloseOwnerIds);
      expect(retainedOwnerIds).toHaveLength(receipt.preCloseOwnerIds.length);
      expect(receipt.postPoisonRaw).toEqual(ZERO_RAW);
      expect(receipt.laterRaw).toEqual(ZERO_RAW);
      expect(receipt.laterDirect).toEqual(expectedEntry("direct"));
      expect(receipt.laterChecker).toEqual(expectedEntry("checker"));
      expect(receipt.fdAfterPoison).toBeGreaterThan(receipt.fdBaseline);
      expect(receipt.fdAfterLater).toBe(receipt.fdAfterPoison);
    }
  });

  test("copied pre-hook raw close is rejected by the pre-raw ordering oracle", async () => {
    for (const [outerEntry, nestedEntry] of [
      ["direct", "direct"],
      ["direct", "checker"],
      ["checker", "direct"]
    ] as const) {
      const baseline = await runPoisonProbe(outerEntry, nestedEntry);
      expectPreRawOuterCloseOrdering(baseline);

      const mutated = await runCopiedPreRawOrderingProbe(outerEntry, nestedEntry);
      expect(mutated.outer).toEqual(expectedEntry(outerEntry));
      expect(mutated.nested).toEqual(expectedEntry(nestedEntry));
      expect(mutated.nestedMediatedCloseCalls).toBe(2);
      expect(mutated.nestedCloseAttempts).toEqual([
        { owner: "unretained", ordinal: 1 },
        { owner: "unretained", ordinal: 2 }
      ]);
      expect(mutated.postPoisonRaw).toEqual(ZERO_RAW);
      expect(mutated.laterRaw).toEqual(ZERO_RAW);
      expect(rawDelta(mutated.rawAtPoison, mutated.outerCloseBaseline).close_sync).toBe(1);
      expect(() => expectPreRawOuterCloseOrdering(mutated)).toThrow();
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
        expect(firstRefusal.closeAttempts.map((attempt) => attempt.ordinal)).toEqual([1, 2]);
        expect(firstRefusal.firstCloseOwnerIds.length).toBeGreaterThan(0);
        const rawAfterFirstRetry = firstRefusal.rawAfterFirstRawClose;
        expect(rawAfterFirstRetry).not.toBeNull();
        expect(rawAfterFirstRetry?.close_sync).toBe(firstRefusal.rawAtFirstAttempt.close_sync + 1);

        const persistentRefusal = await runCopiedNoRawProbe(mode, "persistent", outerEntry, "baseline");
        expect(persistentRefusal.mode).toBe(mode);
        expect(persistentRefusal.behavior).toBe("persistent");
        expectPersistentNoRawPoisonState(outerEntry, persistentRefusal);
        expectPersistentNoRawTransitions(persistentRefusal);
      }
    }
  });

  test("mixed hook and mediator refusal consumes one total two-attempt pre-raw budget", async () => {
    for (const outerEntry of ["direct", "checker"] as const) {
      const baseline = await runCopiedMixedPreRawProbe(outerEntry, false);
      expect(baseline.outerEntry).toBe(outerEntry);
      expect(baseline.outer).toEqual(expectedEntry(outerEntry));
      expect(baseline.closeAttempts.map((attempt) => attempt.ordinal)).toEqual([1, 2]);
      expect(baseline.mediatedCloseCalls).toBe(2);
      expect(baseline.rawAfterOuter.close_sync).toBe(0);
      expect(baseline.laterDirect).toEqual(expectedEntry("direct"));
      expect(baseline.laterChecker).toEqual(expectedEntry("checker"));
      expect(baseline.laterRaw).toEqual(ZERO_RAW);
      expect(baseline.fdAfterOuter).toBeGreaterThan(baseline.fdBaseline);
      expect(baseline.fdAfterLater).toBe(baseline.fdAfterOuter);

      const mutated = await runCopiedMixedPreRawProbe(outerEntry, true);
      expect(mutated.closeAttempts.map((attempt) => attempt.ordinal)).toEqual([1, 2, 3]);
      expect(mutated.mediatedCloseCalls).toBe(3);
      expect(mutated.rawAfterOuter.close_sync).toBe(0);
      expect(mutated.laterRaw).toEqual(ZERO_RAW);
    }
  });

  test("same-pair prototype reentry settles only after its one proven raw close", async () => {
    for (const outerEntry of ["direct", "checker"] as const) {
      const receipt = await runSamePairReentrantProbe(outerEntry);
      expect(receipt.outerEntry).toBe(outerEntry);
      expect(receipt.outer).toEqual(expectedEntry(outerEntry));
      expectSuccessfulEntry(outerEntry, receipt.later);
      expect(receipt.reentrantCloseCalls).toBe(1);
      expect(receipt.targetRawCloseCalls).toBe(1);
      expect(receipt.closedDescriptorDenials).toBe(1);
      expect(receipt.fdAfterOuter).toBe(receipt.fdBaseline);
      expect(receipt.fdAfterLater).toBe(receipt.fdBaseline);
    }
  });

  test("copied fstat work between no-raw attempts is rejected by the persistent transition oracle", async () => {
    for (const mode of NO_RAW_CLOSE_MODES) {
      for (const outerEntry of ["direct", "checker"] as const) {
        const mutated = await runCopiedNoRawProbe(
          mode,
          "persistent",
          outerEntry,
          "raw_fstat_between_attempts"
        );
        expect(mutated.mode).toBe(mode);
        expect(mutated.behavior).toBe("persistent");
        expectPersistentNoRawPoisonState(outerEntry, mutated);
        const { rawAtSecondAttempt, rawAtPoison, rawAfterOuter } = mutated;
        if (!rawAtSecondAttempt || !rawAtPoison || !rawAfterOuter) {
          throw new Error("fstat mutation receipt lacks transition snapshots");
        }
        expect(rawDelta(rawAtSecondAttempt, mutated.rawAtFirstAttempt).fstat_sync).toBe(1);
        expect(rawDelta(rawAtPoison, rawAtSecondAttempt)).toEqual(ZERO_RAW);
        expect(rawDelta(rawAfterOuter, rawAtPoison)).toEqual(ZERO_RAW);
        expect(() => expectPersistentNoRawTransitions(mutated)).toThrow();
      }
    }
  });

  test("the omission-only restoration mutation leaves only omission ingress rows green", async () => {
    for (const mode of NO_RAW_CLOSE_MODES) {
      for (const outerEntry of ["direct", "checker"] as const) {
        const firstRefusal = await runCopiedNoRawProbe(mode, "once", outerEntry, "omission_only");
        const persistentRefusal = await runCopiedNoRawProbe(
          mode,
          "persistent",
          outerEntry,
          "omission_only"
        );
        expect(persistentRefusal.firstCloseOwnerIds.length).toBeGreaterThan(0);
        if (mode === "omission") {
          expectSuccessfulEntry(outerEntry, firstRefusal.outer);
          expect(firstRefusal.closeAttempts.map((attempt) => attempt.ordinal)).toEqual([1, 2]);
          expect(firstRefusal.refusedCloseCalls).toBe(1);
          expect(firstRefusal.rawAfterFirstRawClose?.close_sync).toBe(
            firstRefusal.rawAtFirstAttempt.close_sync + 1
          );
          expect(persistentRefusal.outer).toEqual(expectedEntry(outerEntry));
          expect(persistentRefusal.closeAttempts.map((attempt) => attempt.ordinal)).toEqual([1, 2]);
          expect(persistentRefusal.refusedCloseCalls).toBe(2);
          expect(persistentRefusal.mediatedCloseCallsAtPoison).toBe(2);
          expect(persistentRefusal.mediatedCloseCallsAfterLater).toBe(2);
          expect(persistentRefusal.retainedOwnerIdsAfterContextDeletion).toEqual(
            persistentRefusal.firstCloseOwnerIds
          );
        } else {
          expect(firstRefusal.outer).toEqual(expectedEntry(outerEntry));
          expect(firstRefusal.closeAttempts.map((attempt) => attempt.ordinal)).toEqual([1, 2]);
          expect(firstRefusal.refusedCloseCalls).toBe(1);
          expect(firstRefusal.mediatedCloseCalls).toBe(1);
          expect(persistentRefusal.outer).toEqual(expectedEntry(outerEntry));
          expect(persistentRefusal.closeAttempts.map((attempt) => attempt.ordinal)).toEqual([1, 2]);
          expect(persistentRefusal.refusedCloseCalls).toBe(1);
          const callsBeforeLater = persistentRefusal.mediatedCloseCallsAtPoison ?? 0;
          expect(callsBeforeLater).toBe(1);
          expect(persistentRefusal.mediatedCloseCallsAfterLater).toBe(callsBeforeLater);
          expectPersistentNoRawTransitions(persistentRefusal);
          expect(persistentRefusal.retainedOwnerIdsAfterContextDeletion).toEqual(
            persistentRefusal.firstCloseOwnerIds
          );
          expect(persistentRefusal.laterDirect).toEqual(expectedEntry("direct"));
          expect(persistentRefusal.laterChecker).toEqual(expectedEntry("checker"));
          expect(persistentRefusal.laterRaw).toEqual(ZERO_RAW);
        }
      }
    }
  });

  test("the first-attempt owner-release mutation loses the pre-close owner identity before poison", async () => {
    for (const outerEntry of ["direct", "checker"] as const) {
      const mutated = await runCopiedNoRawProbe(
        "omission",
        "persistent",
        outerEntry,
        "first_attempt_release"
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
