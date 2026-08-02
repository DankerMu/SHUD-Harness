import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type CloseRuntimeMutation = "contextual_raw_start" | undefined;
export type CloseRuntimeTree = Readonly<{ root: string }>;

const contractsRoot = join(import.meta.dir, "..");
const libraryRoot = join(contractsRoot, "lib");

function bridgeSource(source: string): string {
  const bridge = `function invokeRawClose(fd: number, onRawStart: () => void): void {
  const mode = process.env.SHUD_DESCRIPTOR_CLOSE_RUNTIME_BRIDGE;
  if (mode === "omit") return;
  if (mode === "omit_once") {
    process.env.SHUD_DESCRIPTOR_CLOSE_RUNTIME_BRIDGE = "invoke";
    return;
  }
  if (mode === "invoke_then_omit") {
    process.env.SHUD_DESCRIPTOR_CLOSE_RUNTIME_BRIDGE = "omit";
  }
  onRawStart();
  closeSync(fd);
}`;
  const anchor = `function invokeRawClose(fd: number, onRawStart: () => void): void {
  onRawStart();
  closeSync(fd);
}`;
  if (source.includes(anchor)) return source.replace(anchor, bridge);

  const legacyAnchor = "      closeSync(record.fd);";
  if (!source.includes(legacyAnchor)) throw new Error("close runtime bridge anchor is absent");
  return source.replace(legacyAnchor, `      const mode = process.env.SHUD_DESCRIPTOR_CLOSE_RUNTIME_BRIDGE;
      if (mode === "omit") {
        // Test-copy mediator omission leaves the legacy close path observable.
      } else if (mode === "omit_once") {
        process.env.SHUD_DESCRIPTOR_CLOSE_RUNTIME_BRIDGE = "invoke";
      } else {
        if (mode === "invoke_then_omit") process.env.SHUD_DESCRIPTOR_CLOSE_RUNTIME_BRIDGE = "omit";
        closeSync(record.fd);
      }`);
}

function ingressProbeSource(source: string, mutation: CloseRuntimeMutation): string {
  let result = source;
  if (mutation === "contextual_raw_start") {
    const attribution = "        this.#attemptsByPublicAttempt.get(attempt)?.markRawStarted();";
    if (!result.includes(attribution)) throw new Error("descriptor-attribution mutation anchor is absent");
    result = result.replace(attribution, "        this.#activeCloseAttempts.at(-1)?.markRawStarted();");
  }
  if (!result.includes("let retainedPoisonedIngressOwners")) {
    return `${result}\nexport function __testIngressCloseState(): Readonly<{\n  activeContextCount: number; retainedDescriptors: readonly object[];\n}> {\n  return Object.freeze({ activeContextCount: 0, retainedDescriptors: Object.freeze([]) });\n}\n`;
  }

  const nodeAnchor = `  retainedNext(): IngressOwnerNode | undefined {\n    return this.#retainedNext;\n  }\n}`;
  if (!result.includes(nodeAnchor)) throw new Error("ingress owner probe anchor is absent");
  result = result.replace(nodeAnchor, `  retainedNext(): IngressOwnerNode | undefined {\n    return this.#retainedNext;\n  }\n\n  descriptorForTest(): CapabilityDescriptor {\n    return this.descriptor;\n  }\n}`);
  return `${result}\nexport function __testIngressCloseState(): Readonly<{\n  activeContextCount: number; retainedDescriptors: readonly CapabilityDescriptor[];\n}> {\n  let activeContextCount = 0;\n  for (let context = activeIngressContexts; context; context = context.nextActive()) {\n    activeContextCount += 1;\n  }\n  const retainedDescriptors: CapabilityDescriptor[] = [];\n  for (let owner = retainedPoisonedIngressOwners; owner; owner = owner.retainedNext()) {\n    retainedDescriptors.push(owner.descriptorForTest());\n  }\n  return Object.freeze({\n    activeContextCount,\n    retainedDescriptors: Object.freeze(retainedDescriptors)\n  });\n}\n`;
}

async function copyLibrary(root: string, mutation: CloseRuntimeMutation): Promise<void> {
  const copiedLibraryRoot = join(root, "lib");
  await mkdir(copiedLibraryRoot, { recursive: true });
  const names = (await readdir(libraryRoot)).filter((name) => name.endsWith(".ts"));
  await Promise.all(names.map(async (name) => {
    const source = await readFile(join(libraryRoot, name), "utf8");
    const copied = name === "capabilities.ts"
      ? bridgeSource(source)
      : name === "ingress.ts"
      ? ingressProbeSource(source, mutation)
      : source;
    await writeFile(join(copiedLibraryRoot, name), copied);
  }));
}

export async function withCloseRuntimeTree(
  mutation: CloseRuntimeMutation,
  action: (tree: CloseRuntimeTree) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "shud-close-runtime-"));
  try {
    await copyLibrary(root, mutation);
    await action(Object.freeze({ root }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
