import { parse, resolve, sep } from "node:path";
import { hasOnlyUnicodeScalars } from "./canonical-json";
import {
  ContractCapabilities,
  DIRECTORY_OPEN_FLAGS,
  FILE_OPEN_FLAGS,
  type BigIntStats,
  type CapabilityDescriptor,
  type CapabilityHooks,
  type CloseOwner,
  type ContractAuthorityFault
} from "./capabilities";

const contractErrors = new WeakSet<object>();

export type ContractErrorCode =
  | "CONTRACT_BYTES_LIMIT"
  | "CONTRACT_UTF8_INVALID"
  | "CONTRACT_JSON_MALFORMED"
  | "CONTRACT_JSON_DUPLICATE_KEY"
  | "CONTRACT_JSON_DEPTH_LIMIT"
  | "CONTRACT_JSON_NODE_LIMIT"
  | "CONTRACT_JSON_ITEM_LIMIT"
  | "CONTRACT_SCHEMA_INVALID";
export class ContractError extends Error {
  constructor(public readonly code: ContractErrorCode) {
    super(code);
    this.name = "ContractError";
    contractErrors.add(this);
  }
}

function isContractError(error: unknown): error is ContractError {
  return typeof error === "object" && error !== null && contractErrors.has(error);
}

export type IngressProfile = Readonly<{ bytes: number; depth: number; nodes: number; items: number }>;
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

const NO_RAW_CLOSE_RETRY_LIMIT = 2;
const PRE_RAW_CLOSE_BARRIER_RETRY_LIMIT = 2;

class IngressOwnerNode {
  readonly #capabilities: ContractCapabilities;
  readonly #descriptor: CapabilityDescriptor;
  #owner: CloseOwner;
  #next: IngressOwnerNode | undefined;
  #retainedNext: IngressOwnerNode | undefined;
  #retained = false;

  constructor(
    capabilities: ContractCapabilities,
    descriptor: CapabilityDescriptor,
    owner: CloseOwner,
    next: IngressOwnerNode | undefined
  ) {
    this.#capabilities = capabilities;
    this.#descriptor = descriptor;
    this.#owner = owner;
    this.#next = next;
  }

  matches(descriptor: CapabilityDescriptor): boolean {
    return this.#descriptor === descriptor;
  }

  updateOwner(owner: CloseOwner): void {
    this.#owner = owner;
  }

  descriptor(): CapabilityDescriptor {
    return this.#descriptor;
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

  relinkRetained(next: IngressOwnerNode | undefined): void {
    this.#retainedNext = next;
  }
}

class IngressCloseAttempt {
  #rawStarted = false;
  #hookFailed = false;
  #closedDescriptorDenied = false;

  markRawStarted(): void {
    this.#rawStarted = true;
  }

  markHookFailed(): void {
    this.#hookFailed = true;
  }

  markClosedDescriptorDenied(): void {
    this.#closedDescriptorDenied = true;
  }

  rawStarted(): boolean {
    return this.#rawStarted;
  }

  hookFailed(): boolean {
    return this.#hookFailed;
  }

  closedDescriptorDenied(): boolean {
    return this.#closedDescriptorDenied;
  }
}

class ActiveIngressContext {
  readonly #capabilities: ContractCapabilities;
  #liveOwners: IngressOwnerNode | undefined;
  #activeNext: ActiveIngressContext | undefined;
  #closeAttempt: IngressCloseAttempt | undefined;

  constructor(hooks: DescriptorIngressHooks) {
    const guardedHooks: CapabilityHooks = Object.freeze({
      closeFault: (attempt) => {
        this.#closeAttempt?.markRawStarted();
        return hooks.closeFault?.(attempt) ?? false;
      },
      onCloseAttempt: (attempt) => {
        try {
          hooks.onCloseAttempt?.(attempt);
        } catch (error) {
          this.#closeAttempt?.markHookFailed();
          throw error;
        }
        assertIngressWorkAvailable();
      },
      onAuthorityViolation: (fault) => {
        hooks.onAuthorityViolation?.(fault);
      },
      onDescriptorAuthorityDenial: (denial) => {
        if (denial.operation === "close_sync" && denial.reason === "closed_descriptor") {
          this.#closeAttempt?.markClosedDescriptorDenied();
        }
        hooks.onDescriptorAuthorityDenial?.(denial);
      }
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

  close(descriptor: CapabilityDescriptor, owner: CloseOwner): void {
    this.#capabilities.close(descriptor, owner);
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

  releaseOwner(descriptor: CapabilityDescriptor): void {
    let previous: IngressOwnerNode | undefined;
    for (let current = this.#liveOwners; current; current = current.next()) {
      if (!current.matches(descriptor)) {
        previous = current;
        continue;
      }
      const next = current.next();
      if (previous) previous.relink(next);
      else this.#liveOwners = next;
      current.relink(undefined);
      return;
    }
  }

  retainLiveOwners(): void {
    for (let owner = this.#liveOwners; owner; owner = owner.next()) {
      retainPoisonedIngressOwner(owner);
    }
  }

  appendLiveOwnerDescriptors(descriptors: CapabilityDescriptor[]): void {
    for (let owner = this.#liveOwners; owner; owner = owner.next()) {
      descriptors.push(owner.descriptor());
    }
  }

  nextActive(): ActiveIngressContext | undefined {
    return this.#activeNext;
  }

  relinkActive(next: ActiveIngressContext | undefined): void {
    this.#activeNext = next;
  }

  startCloseAttempt(): IngressCloseAttempt {
    if (this.#closeAttempt) throw new ContractError("CONTRACT_SCHEMA_INVALID");
    const closeAttempt = new IngressCloseAttempt();
    this.#closeAttempt = closeAttempt;
    return closeAttempt;
  }

  finishCloseAttempt(closeAttempt: IngressCloseAttempt): void {
    if (this.#closeAttempt === closeAttempt) this.#closeAttempt = undefined;
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

function releaseRetainedPoisonedIngressOwner(descriptor: CapabilityDescriptor): void {
  let previous: IngressOwnerNode | undefined;
  for (let owner = retainedPoisonedIngressOwners; owner; owner = owner.retainedNext()) {
    if (!owner.matches(descriptor)) {
      previous = owner;
      continue;
    }
    const next = owner.retainedNext();
    if (previous) previous.relinkRetained(next);
    else retainedPoisonedIngressOwners = next;
    owner.relinkRetained(undefined);
    return;
  }
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

function trackLiveIngressOwner(
  context: ActiveIngressContext,
  descriptor: CapabilityDescriptor,
  owner: CloseOwner
): void {
  assertIngressWorkAvailable();
  context.trackOwner(descriptor, owner);
}

function updateLiveIngressOwner(
  context: ActiveIngressContext,
  descriptor: CapabilityDescriptor,
  owner: CloseOwner
): void {
  context.updateOwner(descriptor, owner);
}

function releaseLiveIngressOwner(context: ActiveIngressContext, descriptor: CapabilityDescriptor): void {
  context.releaseOwner(descriptor);
  if (retainedPoisonedIngressOwners) releaseRetainedPoisonedIngressOwner(descriptor);
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
  failed: boolean
): boolean {
  if (descriptorIngressPoisoned) return true;
  releaseLiveIngressOwner(context, descriptor);
  return failed;
}

function closeWithRetry(
  context: ActiveIngressContext,
  descriptor: CapabilityDescriptor,
  owner: CloseOwner
): boolean {
  if (descriptorIngressPoisoned) return true;
  let hookFailed = false;
  let barrierFailures = 0;
  for (let attempt = 0; ; ) {
    const closeAttempt = context.startCloseAttempt();
    try {
      context.close(descriptor, owner);
      hookFailed ||= closeAttempt.hookFailed();
      return settleClosedIngressOwner(context, descriptor, hookFailed);
    } catch (error) {
      hookFailed ||= closeAttempt.hookFailed();
      if (closeAttempt.rawStarted()) return settleClosedIngressOwner(context, descriptor, true);
      if (closeAttempt.closedDescriptorDenied()) {
        return settleClosedIngressOwner(context, descriptor, true);
      }
      if (descriptorIngressPoisoned) return true;
      if (closeAttempt.hookFailed()) {
        if (barrierFailures + 1 === PRE_RAW_CLOSE_BARRIER_RETRY_LIMIT) {
          poisonIngressAndRetainActiveOwners();
          throw error;
        }
        barrierFailures += 1;
        continue;
      }
      if (attempt + 1 === NO_RAW_CLOSE_RETRY_LIMIT) {
        poisonIngressAndRetainActiveOwners();
        throw error;
      }
      attempt += 1;
    } finally {
      context.finishCloseAttempt(closeAttempt);
    }
  }
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

function closeAll(
  context: ActiveIngressContext,
  components: readonly RetainedComponent[]
): boolean {
  let failed = false;
  for (let index = components.length - 1; index >= 0; index -= 1) {
    try {
      if (closeWithRetry(context, components[index]!.descriptor, "retained")) {
        failed = true;
      }
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
  observe?: DescriptorOperationObserver
): DescriptorAdmission {
  if (hasForbiddenRawPathComponent(path)) throw new ContractError("CONTRACT_SCHEMA_INVALID");
  const physicalAbsolutePath = normalizedAbsolutePath(path);
  const root = parse(physicalAbsolutePath).root;
  const segments = absoluteSegments(physicalAbsolutePath);
  if (segments.length === 0) throw new ContractError("CONTRACT_SCHEMA_INVALID");
  const components: RetainedComponent[] = [];
  try {
    assertIngressWorkAvailable();
    observe?.({ phase: "admission", operation: "open_root", path: root });
    assertIngressWorkAvailable();
    const rootDescriptor = context.openRoot(root, "admission");
    trackLiveIngressOwner(context, rootDescriptor, "unretained");
    try {
      assertIngressWorkAvailable();
      const rootStats = context.stat(rootDescriptor);
      assertExpectedType(rootStats, false);
      context.markRetained(rootDescriptor, "directory");
      updateLiveIngressOwner(context, rootDescriptor, "retained");
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
      observe?.({
        phase: "admission",
        operation: "open_relative",
        path: childName
      });
      assertIngressWorkAvailable();
      const descriptor = context.openRelative(
        parentDescriptor,
        childName,
        final ? FILE_OPEN_FLAGS : DIRECTORY_OPEN_FLAGS,
        "admission"
      );
      trackLiveIngressOwner(context, descriptor, "unretained");
      try {
        assertIngressWorkAvailable();
        const stats = context.stat(descriptor);
        assertExpectedType(stats, final);
        context.markRetained(descriptor, final ? "file" : "directory");
        updateLiveIngressOwner(context, descriptor, "retained");
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
  observe?: DescriptorOperationObserver,
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
    observe?.({
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
    trackLiveIngressOwner(context, verificationDescriptor, "verification");
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
  const context = registerIngressContext(hooks);
  let admission: DescriptorAdmission | undefined;
  let primary: ContractError | undefined;
  let result: Uint8Array | undefined;
  let verificationCleanupFailed = false;
  try {
    admission = openDescriptorBoundPath(path, context, hooks.observe);
    context.sealAdmission();
    const final = admission.components.at(-1)!;
    await hooks.afterAdmission?.(admission.logicalAbsolutePath);
    assertIngressWorkAvailable();
    if (hooks.authorityFault) context.rejectForbidden(hooks.authorityFault, "post_admission");
    assertIngressWorkAvailable();
    verificationCleanupFailed = verifyRetainedChain(admission, context, hooks.observe, true);
    assertIngressWorkAvailable();
    if (final.stats.size <= maximum) {
      const buffer = Buffer.alloc(maximum + 1);
      let length = 0;
      while (length < buffer.length) {
        assertIngressWorkAvailable();
        hooks.observe?.({
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
    verificationCleanupFailed = verifyRetainedChain(
      admission,
      context,
      hooks.observe,
      true
    ) || verificationCleanupFailed;
    if (!result) throw new ContractError("CONTRACT_BYTES_LIMIT");
    beforeCleanup?.(result);
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
