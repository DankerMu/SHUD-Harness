import { parse, resolve, sep } from "node:path";
import { isPromise } from "node:util/types";
import { hasOnlyUnicodeScalars } from "./canonical-json";
import {
  capabilityCallbackActive,
  ContractCapabilities,
  DIRECTORY_OPEN_FLAGS,
  FILE_OPEN_FLAGS,
  withCapabilityCallback,
  type BigIntStats,
  type CapabilityDescriptor,
  type CapabilityHooks,
  type CloseAttempt,
  type CloseOwner,
  type ContractAuthorityFault
} from "./capabilities";

export type ContractErrorCode =
  | "CONTRACT_BYTES_LIMIT"
  | "CONTRACT_UTF8_INVALID"
  | "CONTRACT_JSON_MALFORMED"
  | "CONTRACT_JSON_DUPLICATE_KEY"
  | "CONTRACT_JSON_DEPTH_LIMIT"
  | "CONTRACT_JSON_NODE_LIMIT"
  | "CONTRACT_JSON_ITEM_LIMIT"
  | "CONTRACT_SCHEMA_INVALID";

/**
 * Construction-time identity set for contract errors. Recognition never walks a
 * prototype chain, never reads a property, and never `in`-tests a foreign
 * value: `WeakSet.prototype.has` is total over primitives and triggers no Proxy
 * trap, so a hostile thrown value stays unobserved.
 */
const contractErrorIdentities = new WeakSet<WeakKey>();

export class ContractError extends Error {
  constructor(public readonly code: ContractErrorCode) {
    super(code);
    this.name = "ContractError";
    contractErrorIdentities.add(this);
  }
}

function isContractError(value: unknown): value is ContractError {
  return contractErrorIdentities.has(value as WeakKey);
}

export type IngressProfile = Readonly<{ bytes: number; depth: number; nodes: number; items: number }>;
/**
 * An admission hook may be asynchronous. Only a value that is a promise by
 * construction identity (an internal-slot check that reads no property of the
 * returned value) is awaited; any other return value, including a thenable, is
 * treated as a completed synchronous hook and is never inspected or assimilated.
 */
export type DescriptorAdmissionHook = (absolutePath: string) => void | Promise<void>;
export type DescriptorIngressOperation = Readonly<{
  phase: "admission" | "post_admission";
  operation: "open_root" | "open_relative" | "read_retained";
  path: string;
}>;
export type DescriptorOperationObserver = (operation: DescriptorIngressOperation) => void;
export type DescriptorIngressHooks = Readonly<{
  afterAdmission?: DescriptorAdmissionHook;
  observe?: DescriptorOperationObserver;
  authorityFault?: ContractAuthorityFault;
}> & CapabilityHooks;

const NO_RAW_CLOSE_ATTEMPTS = 2;

/**
 * Every ingress-owned mediator seam (the `observe`, `afterAdmission`, and
 * `beforeCleanup` callbacks, and the `authorityFault` lookup together with its
 * validation) shares the capability callback latch for its whole execution,
 * including every async resource descending from an asynchronous
 * `afterAdmission`, so reentry from any mediator seam is rejected on every
 * descriptor seam and at the public ingress entry alike. An operation started
 * outside every callback carries no latch, so it is unaffected while a
 * concurrent operation is suspended inside its own hook.
 */
function assertNoCallbackReentry(): void {
  if (capabilityCallbackActive()) throw new ContractError("CONTRACT_SCHEMA_INVALID");
}

/**
 * The single ingress observation seam: the hook property is looked up and
 * called inside one latch, so an accessor-form `observe` cannot reenter the
 * boundary from its getter either, and the caller keeps its own receiver.
 */
function observeIngress(hooks: DescriptorIngressHooks, operation: DescriptorIngressOperation): void {
  withCapabilityCallback(() => hooks.observe?.(operation));
}

/**
 * The frozen authority-fault vocabulary, restated as data so the ingress can
 * admit a mediator-supplied fault without leaving the latch. Its literal keys
 * are checked against `ContractAuthorityFault` by construction, so the two
 * vocabularies cannot drift apart.
 */
const CONTRACT_AUTHORITY_FAULTS = Object.freeze({
  ambient_absolute_open: true,
  replacement_object_read: true,
  file_write: true,
  child_spawn: true
} satisfies Readonly<Record<ContractAuthorityFault, true>>);

/**
 * The single ingress authority-fault seam: the mediator value is looked up and
 * validated inside one latch, and only one of the four frozen literals leaves
 * it. A foreign value is never coerced - not by this seam and not by the
 * rejection it would otherwise reach - because a non-member is a contract
 * failure here, and a valid literal is a primitive with no `Symbol.toPrimitive`
 * or `toString` of its own. Absence is the only accepted non-fault: any other
 * value, falsy or not, is outside the vocabulary.
 */
function admittedAuthorityFault(hooks: DescriptorIngressHooks): ContractAuthorityFault | undefined {
  const requested: unknown = hooks.authorityFault;
  if (requested === undefined) return undefined;
  if (typeof requested !== "string" || !Object.hasOwn(CONTRACT_AUTHORITY_FAULTS, requested)) {
    throw new ContractError("CONTRACT_SCHEMA_INVALID");
  }
  return requested as ContractAuthorityFault;
}

class IngressOwnerNode {
  #next: IngressOwnerNode | undefined;
  #retainedNext: IngressOwnerNode | undefined;
  #retained = false;

  constructor(
    private readonly capabilities: ContractCapabilities,
    private readonly descriptor: CapabilityDescriptor,
    private owner: CloseOwner,
    next: IngressOwnerNode | undefined
  ) {
    this.#next = next;
  }

  matches(descriptor: CapabilityDescriptor, owner?: CloseOwner): boolean {
    return this.descriptor === descriptor && (owner === undefined || this.owner === owner);
  }

  updateOwner(owner: CloseOwner): void {
    this.owner = owner;
  }

  next(): IngressOwnerNode | undefined {
    return this.#next;
  }

  relink(next: IngressOwnerNode | undefined): void {
    this.#next = next;
  }

  retain(next: IngressOwnerNode | undefined): boolean {
    if (this.#retained) return false;
    this.#retained = true;
    this.#retainedNext = next;
    return true;
  }

  retainedNext(): IngressOwnerNode | undefined {
    return this.#retainedNext;
  }
}

class IngressCloseAttempt {
  #publicAttempt: CloseAttempt | undefined;
  #rawStarted = false;

  constructor(
    private readonly descriptor: CapabilityDescriptor,
    private readonly owner: CloseOwner
  ) {}

  matches(descriptor: CapabilityDescriptor, owner: CloseOwner): boolean {
    return this.descriptor === descriptor && this.owner === owner;
  }

  bind(attempt: CloseAttempt): boolean {
    if (this.#publicAttempt || attempt.owner !== this.owner) return false;
    this.#publicAttempt = attempt;
    return true;
  }

  markRawStarted(): void {
    this.#rawStarted = true;
  }

  rawStarted(): boolean {
    return this.#rawStarted;
  }
}

class ActiveIngressContext {
  readonly #capabilities: ContractCapabilities;
  #liveOwners: IngressOwnerNode | undefined;
  #activeNext: ActiveIngressContext | undefined;
  readonly #activeCloseAttempts: IngressCloseAttempt[] = [];
  readonly #attemptsByPublicAttempt = new WeakMap<CloseAttempt, IngressCloseAttempt>();

  constructor(private readonly hooks: DescriptorIngressHooks) {
    // Every caller hook is looked up lazily on the caller's own object and its
    // result is forwarded untouched, so inherited hooks keep their receiver and
    // no returned mediator value is inspected on the way out.
    const guardedHooks: CapabilityHooks = Object.freeze({
      closeFault: (attempt) => {
        this.#attemptsByPublicAttempt.get(attempt)?.markRawStarted();
        return hooks.closeFault?.(attempt) ?? false;
      },
      onAuthorityViolation: (fault) => hooks.onAuthorityViolation?.(fault),
      onCloseAttempt: (attempt) => {
        const active = this.#activeCloseAttempts.at(-1);
        if (active?.bind(attempt)) this.#attemptsByPublicAttempt.set(attempt, active);
        return hooks.onCloseAttempt?.(attempt);
      },
      onDescriptorAuthorityDenial: (denial) => hooks.onDescriptorAuthorityDenial?.(denial)
    });
    this.#capabilities = new ContractCapabilities(guardedHooks);
  }

  sealAdmission(): void {
    this.#capabilities.sealAdmission();
  }

  openRoot(root: string, phase: "admission" | "post_admission"): CapabilityDescriptor {
    return this.#capabilities.openRoot(root, phase);
  }

  openRelative(
    parent: CapabilityDescriptor,
    childName: string,
    flags: number,
    phase: "admission" | "post_admission"
  ): CapabilityDescriptor {
    return this.#capabilities.openRelative(parent, childName, flags, phase);
  }

  markRetained(descriptor: CapabilityDescriptor, kind: "file" | "directory"): void {
    this.#capabilities.markRetained(descriptor, kind);
  }

  stat(descriptor: CapabilityDescriptor): BigIntStats {
    return this.#capabilities.stat(descriptor);
  }

  readRetained(
    descriptor: CapabilityDescriptor,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    phase: "admission" | "post_admission"
  ): number {
    return this.#capabilities.readRetained(descriptor, buffer, offset, length, position, phase);
  }

  rejectForbidden(fault: ContractAuthorityFault, phase: "admission" | "post_admission"): never {
    return this.#capabilities.rejectForbidden(fault, phase);
  }

  close(descriptor: CapabilityDescriptor, owner: CloseOwner, attempt: IngressCloseAttempt): void {
    if (!attempt.matches(descriptor, owner)) throw new ContractError("CONTRACT_SCHEMA_INVALID");
    this.#activeCloseAttempts.push(attempt);
    try {
      this.#capabilities.close(descriptor, owner);
    } finally {
      this.#activeCloseAttempts.pop();
    }
  }

  startCloseAttempt(descriptor: CapabilityDescriptor, owner: CloseOwner): IngressCloseAttempt {
    return new IngressCloseAttempt(descriptor, owner);
  }

  trackOwner(descriptor: CapabilityDescriptor, owner: CloseOwner): void {
    this.#liveOwners = new IngressOwnerNode(this.#capabilities, descriptor, owner, this.#liveOwners);
  }

  updateOwner(descriptor: CapabilityDescriptor, owner: CloseOwner): void {
    for (let current = this.#liveOwners; current; current = current.next()) {
      if (!current.matches(descriptor)) continue;
      current.updateOwner(owner);
      return;
    }
    throw new ContractError("CONTRACT_SCHEMA_INVALID");
  }

  releaseOwner(descriptor: CapabilityDescriptor, owner: CloseOwner): void {
    let previous: IngressOwnerNode | undefined;
    for (let current = this.#liveOwners; current; current = current.next()) {
      if (!current.matches(descriptor, owner)) {
        previous = current;
        continue;
      }
      const next = current.next();
      if (previous) previous.relink(next);
      else this.#liveOwners = next;
      current.relink(undefined);
      return;
    }
    throw new ContractError("CONTRACT_SCHEMA_INVALID");
  }

  retainLiveOwners(): void {
    for (let owner = this.#liveOwners; owner; owner = owner.next()) {
      retainPoisonedIngressOwner(owner);
    }
  }

  nextActive(): ActiveIngressContext | undefined {
    return this.#activeNext;
  }

  relinkActive(next: ActiveIngressContext | undefined): void {
    this.#activeNext = next;
  }
}

let activeIngressContexts: ActiveIngressContext | undefined;
let retainedPoisonedIngressOwners: IngressOwnerNode | undefined;
let descriptorIngressPoisoned = false;

function assertIngressWorkAvailable(): void {
  if (descriptorIngressPoisoned) throw new ContractError("CONTRACT_SCHEMA_INVALID");
}

function retainPoisonedIngressOwner(owner: IngressOwnerNode): void {
  if (owner.retain(retainedPoisonedIngressOwners)) retainedPoisonedIngressOwners = owner;
}

function registerIngressContext(hooks: DescriptorIngressHooks): ActiveIngressContext {
  assertIngressWorkAvailable();
  const context = new ActiveIngressContext(hooks);
  context.relinkActive(activeIngressContexts);
  activeIngressContexts = context;
  return context;
}

function unregisterIngressContext(context: ActiveIngressContext): void {
  if (activeIngressContexts === context) {
    activeIngressContexts = context.nextActive();
    context.relinkActive(undefined);
    return;
  }
  for (let previous = activeIngressContexts; previous; previous = previous.nextActive()) {
    if (previous.nextActive() !== context) continue;
    previous.relinkActive(context.nextActive());
    context.relinkActive(undefined);
    return;
  }
}

function poisonIngressAndRetainActiveOwners(): void {
  if (descriptorIngressPoisoned) return;
  descriptorIngressPoisoned = true;
  for (let context = activeIngressContexts; context; context = context.nextActive()) {
    context.retainLiveOwners();
  }
}

function settleClosedIngressOwner(
  context: ActiveIngressContext,
  descriptor: CapabilityDescriptor,
  owner: CloseOwner,
  failed: boolean
): boolean {
  if (descriptorIngressPoisoned) return true;
  context.releaseOwner(descriptor, owner);
  return failed;
}

function closeWithRetry(
  context: ActiveIngressContext,
  descriptor: CapabilityDescriptor,
  owner: CloseOwner
): boolean {
  if (descriptorIngressPoisoned) return true;
  for (let index = 0; index < NO_RAW_CLOSE_ATTEMPTS; index += 1) {
    const attempt = context.startCloseAttempt(descriptor, owner);
    let failed = false;
    try {
      context.close(descriptor, owner, attempt);
    } catch {
      failed = true;
    }
    if (attempt.rawStarted()) return settleClosedIngressOwner(context, descriptor, owner, failed);
    if (descriptorIngressPoisoned) return true;
    if (index + 1 === NO_RAW_CLOSE_ATTEMPTS) {
      poisonIngressAndRetainActiveOwners();
      return true;
    }
  }
  return true;
}

function sameEntry(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function hasForbiddenRawPathComponent(path: string): boolean {
  const root = parse(path).root;
  return path.slice(root.length).split(sep).some((component) => component === "." || component === "..");
}

function normalizedAbsolutePath(path: string): string {
  const absolute = resolve(path);
  if (process.platform !== "darwin") return absolute;
  for (const alias of ["/etc", "/tmp", "/var"] as const) {
    if (absolute === alias || absolute.startsWith(`${alias}/`)) return `/private${absolute}`;
  }
  return absolute;
}

function absoluteSegments(path: string): readonly string[] {
  const root = parse(path).root;
  return path.slice(root.length).split(sep).filter(Boolean);
}

type RetainedComponent = Readonly<{
  descriptor: CapabilityDescriptor;
  childName?: string;
  stats: BigIntStats;
  final: boolean;
}>;
type DescriptorAdmission = Readonly<{
  logicalAbsolutePath: string;
  components: readonly RetainedComponent[];
}>;

function closeAll(context: ActiveIngressContext, components: readonly RetainedComponent[]): boolean {
  let failed = false;
  for (let index = components.length - 1; index >= 0; index -= 1) {
    try {
      if (closeWithRetry(context, components[index]!.descriptor, "retained")) failed = true;
    } catch {
      failed = true;
    }
  }
  return failed;
}

function assertExpectedType(stats: BigIntStats, final: boolean): void {
  if (final ? !stats.isFile() : !stats.isDirectory()) throw new ContractError("CONTRACT_SCHEMA_INVALID");
}

function openDescriptorBoundPath(
  path: string,
  context: ActiveIngressContext,
  hooks: DescriptorIngressHooks
): DescriptorAdmission {
  assertIngressWorkAvailable();
  if (hasForbiddenRawPathComponent(path)) throw new ContractError("CONTRACT_SCHEMA_INVALID");
  const physicalAbsolutePath = normalizedAbsolutePath(path);
  const root = parse(physicalAbsolutePath).root;
  const segments = absoluteSegments(physicalAbsolutePath);
  if (segments.length === 0) throw new ContractError("CONTRACT_SCHEMA_INVALID");
  const components: RetainedComponent[] = [];
  try {
    observeIngress(hooks, { phase: "admission", operation: "open_root", path: root });
    assertIngressWorkAvailable();
    const rootDescriptor = context.openRoot(root, "admission");
    context.trackOwner(rootDescriptor, "unretained");
    try {
      assertIngressWorkAvailable();
      const rootStats = context.stat(rootDescriptor);
      assertExpectedType(rootStats, false);
      context.markRetained(rootDescriptor, "directory");
      context.updateOwner(rootDescriptor, "retained");
      components.push({ descriptor: rootDescriptor, stats: rootStats, final: false });
    } catch (error) {
      try {
        closeWithRetry(context, rootDescriptor, "unretained");
      } catch {
        // The admission failure remains primary over a retry refusal during cleanup.
      }
      throw error;
    }

    for (let index = 0; index < segments.length; index += 1) {
      assertIngressWorkAvailable();
      const childName = segments[index]!;
      const final = index === segments.length - 1;
      const parentDescriptor = components.at(-1)!.descriptor;
      observeIngress(hooks, { phase: "admission", operation: "open_relative", path: childName });
      assertIngressWorkAvailable();
      const descriptor = context.openRelative(
        parentDescriptor,
        childName,
        final ? FILE_OPEN_FLAGS : DIRECTORY_OPEN_FLAGS,
        "admission"
      );
      context.trackOwner(descriptor, "unretained");
      try {
        assertIngressWorkAvailable();
        const stats = context.stat(descriptor);
        assertExpectedType(stats, final);
        context.markRetained(descriptor, final ? "file" : "directory");
        context.updateOwner(descriptor, "retained");
        components.push({ descriptor, childName, stats, final });
      } catch (error) {
        try {
          closeWithRetry(context, descriptor, "unretained");
        } catch {
          // The admission failure remains primary over a retry refusal during cleanup.
        }
        throw error;
      }
    }
    return { logicalAbsolutePath: resolve(path), components: Object.freeze(components) };
  } catch (error) {
    closeAll(context, components);
    if (isContractError(error)) throw error;
    throw new ContractError("CONTRACT_SCHEMA_INVALID");
  }
}

function verifyRetainedChain(
  admission: DescriptorAdmission,
  context: ActiveIngressContext,
  hooks: DescriptorIngressHooks,
  deferCleanup = false
): boolean {
  let cleanupFailed = false;
  for (let index = 0; index < admission.components.length; index += 1) {
    assertIngressWorkAvailable();
    const retained = admission.components[index]!;
    const retainedStats = context.stat(retained.descriptor);
    assertExpectedType(retainedStats, retained.final);
    if (!sameEntry(retained.stats, retainedStats)) throw new ContractError("CONTRACT_SCHEMA_INVALID");
    if (index === 0) continue;

    const parent = admission.components[index - 1]!;
    observeIngress(hooks, {
      phase: "post_admission",
      operation: "open_relative",
      path: retained.childName!
    });
    assertIngressWorkAvailable();
    const verificationDescriptor = context.openRelative(
      parent.descriptor,
      retained.childName!,
      retained.final ? FILE_OPEN_FLAGS : DIRECTORY_OPEN_FLAGS,
      "post_admission"
    );
    context.trackOwner(verificationDescriptor, "verification");
    let verificationPrimary: ContractError | undefined;
    try {
      assertIngressWorkAvailable();
      const verificationStats = context.stat(verificationDescriptor);
      assertExpectedType(verificationStats, retained.final);
      if (!sameEntry(retained.stats, verificationStats)) throw new ContractError("CONTRACT_SCHEMA_INVALID");
    } catch (error) {
      verificationPrimary = isContractError(error) ? error : new ContractError("CONTRACT_SCHEMA_INVALID");
    } finally {
      let closeFailed = false;
      try {
        closeFailed = closeWithRetry(context, verificationDescriptor, "verification");
      } catch {
        closeFailed = true;
      }
      if (closeFailed && !verificationPrimary) {
        if (deferCleanup) {
          cleanupFailed = true;
        } else {
          verificationPrimary = new ContractError("CONTRACT_SCHEMA_INVALID");
        }
      }
    }
    if (verificationPrimary) throw verificationPrimary;
  }
  return cleanupFailed;
}

class StrictJsonParser {
  private cursor = 0;
  private nodes = 0;
  private items = 0;
  private pendingLimit: ContractErrorCode | undefined;
  private pendingSemanticError = false;

  constructor(private readonly text: string, private readonly profile: IngressProfile) {}

  parse(): unknown {
    this.whitespace();
    const result = this.value(1);
    this.whitespace();
    if (this.cursor !== this.text.length) this.fail("CONTRACT_JSON_MALFORMED");
    if (this.pendingLimit) this.fail(this.pendingLimit);
    if (this.pendingSemanticError) this.fail("CONTRACT_SCHEMA_INVALID");
    return result;
  }

  private value(depth: number): unknown {
    if (depth > this.profile.depth) this.fail("CONTRACT_JSON_DEPTH_LIMIT");
    this.nodes += 1;
    if (this.nodes > this.profile.nodes) this.recordLimit("CONTRACT_JSON_NODE_LIMIT");
    const current = this.text[this.cursor];
    if (current === "{") return this.object(depth);
    if (current === "[") return this.array(depth);
    if (current === '"') return this.string();
    if (this.take("true")) return true;
    if (this.take("false")) return false;
    if (this.take("null")) return null;
    return this.number();
  }

  private object(depth: number): Record<string, unknown> {
    this.cursor += 1;
    const result = Object.create(null) as Record<string, unknown>;
    const keys = new Set<string>();
    this.whitespace();
    if (this.text[this.cursor] === "}") { this.cursor += 1; return result; }
    for (;;) {
      if (this.text[this.cursor] !== '"') this.fail("CONTRACT_JSON_MALFORMED");
      const key = this.string();
      if (keys.has(key)) this.fail("CONTRACT_JSON_DUPLICATE_KEY");
      keys.add(key);
      this.countItem();
      this.whitespace();
      if (this.text[this.cursor] !== ":") this.fail("CONTRACT_JSON_MALFORMED");
      this.cursor += 1;
      this.whitespace();
      result[key] = this.value(depth + 1);
      this.whitespace();
      const delimiter = this.text[this.cursor++];
      if (delimiter === "}") return result;
      if (delimiter !== ",") this.fail("CONTRACT_JSON_MALFORMED");
      this.whitespace();
    }
  }

  private array(depth: number): unknown[] {
    this.cursor += 1;
    const result: unknown[] = [];
    this.whitespace();
    if (this.text[this.cursor] === "]") { this.cursor += 1; return result; }
    for (;;) {
      this.assertValueStart();
      this.countItem();
      result.push(this.value(depth + 1));
      this.whitespace();
      const delimiter = this.text[this.cursor++];
      if (delimiter === "]") return result;
      if (delimiter !== ",") this.fail("CONTRACT_JSON_MALFORMED");
      this.whitespace();
    }
  }

  private assertValueStart(): void {
    const current = this.text[this.cursor];
    if (current === "{" || current === "[" || current === '"' || current === "t" || current === "f" ||
        current === "n" || current === "-" || (current !== undefined && current >= "0" && current <= "9")) return;
    this.fail("CONTRACT_JSON_MALFORMED");
  }

  private string(): string {
    const start = this.cursor++;
    for (;;) {
      const unit = this.text.charCodeAt(this.cursor);
      if (!Number.isFinite(unit) || unit < 0x20) this.fail("CONTRACT_JSON_MALFORMED");
      if (unit === 0x22) {
        this.cursor += 1;
        try {
          const decoded = JSON.parse(this.text.slice(start, this.cursor)) as string;
          if (!hasOnlyUnicodeScalars(decoded)) this.fail("CONTRACT_JSON_MALFORMED");
          return decoded;
        } catch (error) {
          if (isContractError(error)) throw error;
          this.fail("CONTRACT_JSON_MALFORMED");
        }
      }
      if (unit === 0x5c) {
        this.cursor += 1;
        const escape = this.text[this.cursor];
        if (!escape || !'"\\/bfnrtu'.includes(escape)) this.fail("CONTRACT_JSON_MALFORMED");
        if (escape === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(this.text.slice(this.cursor + 1, this.cursor + 5))) {
            this.fail("CONTRACT_JSON_MALFORMED");
          }
          this.cursor += 4;
        }
      }
      this.cursor += 1;
    }
  }

  private number(): number {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(this.text.slice(this.cursor));
    if (!match) this.fail("CONTRACT_JSON_MALFORMED");
    this.cursor += match[0].length;
    const result = Number(match[0]);
    if (!Number.isFinite(result)) this.pendingSemanticError = true;
    return result;
  }

  private countItem(): void {
    this.items += 1;
    if (this.items > this.profile.items) this.recordLimit("CONTRACT_JSON_ITEM_LIMIT");
  }

  private recordLimit(code: ContractErrorCode): void {
    this.pendingLimit ??= code;
  }

  private take(token: string): boolean {
    if (!this.text.startsWith(token, this.cursor)) return false;
    this.cursor += token.length;
    return true;
  }

  private whitespace(): void {
    while (/^[\u0009\u000a\u000d\u0020]$/.test(this.text[this.cursor] ?? "")) this.cursor += 1;
  }

  private fail(code: ContractErrorCode): never {
    throw new ContractError(code);
  }
}

export function parseBoundedJson(bytes: Uint8Array, profile: IngressProfile): unknown {
  if (bytes.byteLength > profile.bytes) throw new ContractError("CONTRACT_BYTES_LIMIT");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ContractError("CONTRACT_UTF8_INVALID");
  }
  return new StrictJsonParser(text, profile).parse();
}

export async function readBoundedFile(
  path: string,
  maximum: number,
  hooks: DescriptorIngressHooks = {},
  beforeCleanup?: (bytes: Uint8Array) => void
): Promise<Uint8Array> {
  assertNoCallbackReentry();
  const context = registerIngressContext(hooks);
  let admission: DescriptorAdmission | undefined;
  let primary: ContractError | undefined;
  let result: Uint8Array | undefined;
  let verificationCleanupFailed = false;
  try {
    admission = openDescriptorBoundPath(path, context, hooks);
    context.sealAdmission();
    const final = admission.components.at(-1)!;
    const admitted = withCapabilityCallback(() => hooks.afterAdmission?.(admission!.logicalAbsolutePath));
    if (isPromise(admitted)) await admitted;
    assertIngressWorkAvailable();
    const authorityFault = withCapabilityCallback(() => admittedAuthorityFault(hooks));
    if (authorityFault) context.rejectForbidden(authorityFault, "post_admission");
    assertIngressWorkAvailable();
    verificationCleanupFailed = verifyRetainedChain(admission, context, hooks, true);
    assertIngressWorkAvailable();
    if (final.stats.size <= maximum) {
      const buffer = Buffer.alloc(maximum + 1);
      let length = 0;
      while (length < buffer.length) {
        assertIngressWorkAvailable();
        observeIngress(hooks, {
          phase: "post_admission",
          operation: "read_retained",
          path: final.childName!
        });
        assertIngressWorkAvailable();
        const bytesRead = context.readRetained(
          final.descriptor,
          buffer,
          length,
          buffer.length - length,
          length,
          "post_admission"
        );
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length <= maximum) result = buffer.subarray(0, length);
    }
    assertIngressWorkAvailable();
    verificationCleanupFailed = verifyRetainedChain(admission, context, hooks, true) || verificationCleanupFailed;
    if (!result) throw new ContractError("CONTRACT_BYTES_LIMIT");
    const admittedBytes = result;
    withCapabilityCallback(() => beforeCleanup?.(admittedBytes));
  } catch (error) {
    primary = isContractError(error) ? error : new ContractError("CONTRACT_SCHEMA_INVALID");
  } finally {
    const cleanupFailed = admission ? closeAll(context, admission.components) : false;
    unregisterIngressContext(context);
    if (!primary && (verificationCleanupFailed || cleanupFailed)) primary = new ContractError("CONTRACT_SCHEMA_INVALID");
  }
  if (primary) throw primary;
  return result!;
}
