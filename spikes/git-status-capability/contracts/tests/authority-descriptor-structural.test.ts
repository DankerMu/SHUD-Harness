import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import {
  capabilitiesSourcePath,
  structuralDescriptorDenials,
  withCompiledProductionTree,
  type ProductionMutation
} from "./authority-descriptor-vocabulary";

const EXPECTED_STRUCTURAL_DENIAL: Readonly<Record<ProductionMutation, readonly string[]>> = Object.freeze({
  fd0: ["raw_read_descriptor_not_handle"],
  at_fdcwd: ["openat_parent_not_handle"],
  fstat0: ["raw_fstat_descriptor_not_handle"],
  close0: ["raw_close_descriptor_not_handle"],
  before_deny_fstat: ["raw_read_descriptor_not_handle", "raw_fstat_descriptor_not_handle"],
  raw_descriptor: ["raw_descriptor_operation_shape"],
  foreign_descriptor: ["foreign_descriptor_shape"],
  stale_descriptor: ["stale_descriptor_shape"],
  invalid_flags: ["flags_invalid_shape"],
  invalid_owner: ["owner_mismatch_shape"]
});

function replaceSourceAnchor(source: string, anchor: string, replacement: string): string {
  if (!source.includes(anchor)) throw new Error(`structural AST test anchor is absent: ${anchor}`);
  return source.replace(anchor, replacement);
}

const FORBIDDEN_MEDIATOR_RUNTIME_PATTERNS = Object.freeze([
  /process\.on\(\s*["']unhandledRejection["']/,
  /process\.on\(\s*["']rejectionHandled["']/,
  /Bun\.peek\(/,
  /\.constructor\s*=/,
  /Symbol\.species\s*=|\[\s*Symbol\.species\s*\]\s*=/
] as const);

function forbiddenMediatorRuntimeUses(source: string): readonly number[] {
  return FORBIDDEN_MEDIATOR_RUNTIME_PATTERNS
    .map((pattern, index) => pattern.test(source) ? index : -1)
    .filter((index) => index >= 0);
}

function markRetainedHasRawFstat(source: string): boolean {
  const tree = ts.createSourceFile("capabilities.ts", source, ts.ScriptTarget.ES2022, true);
  let hasRawFstat = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isMethodDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "markRetained" &&
      node.body
    ) {
      const findRawFstat = (candidate: ts.Node): void => {
        if (
          ts.isCallExpression(candidate) &&
          ts.isIdentifier(candidate.expression) &&
          candidate.expression.text === "fstatSync"
        ) {
          hasRawFstat = true;
        }
        ts.forEachChild(candidate, findRawFstat);
      };
      ts.forEachChild(node.body, findRawFstat);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return hasRawFstat;
}

describe("retained descriptor structural authority", () => {
  test("the complete real production tree compiles with only opaque descriptor operands", async () => {
    await withCompiledProductionTree(undefined, async (tree) => {
      expect(structuralDescriptorDenials(await readFile(tree.capabilitiesPath, "utf8"))).toEqual([]);
    });
  });

  test("structural-only oracle rejects the exact ambient mutations and every descriptor vocabulary bypass", async () => {
    for (const [mutation, expected] of Object.entries(EXPECTED_STRUCTURAL_DENIAL) as Array<
      [ProductionMutation, readonly string[]]
    >) {
      await withCompiledProductionTree(mutation, async (tree) => {
        expect(structuralDescriptorDenials(await readFile(tree.capabilitiesPath, "utf8"))).toEqual(expected);
      });
    }
  });

  test("mediation cannot install rejection listeners or rewrite Promise identity", async () => {
    const source = await readFile(capabilitiesSourcePath, "utf8");
    expect(forbiddenMediatorRuntimeUses(source)).toEqual([]);
    expect(forbiddenMediatorRuntimeUses(`${source}
process.on("unhandledRejection", () => undefined);
process.on("rejectionHandled", () => undefined);
Bun.peek(Promise.resolve());
Promise.prototype.constructor = Promise;
Promise[Symbol.species] = Promise;
`)).toEqual([0, 1, 2, 3, 4]);
  });

  test("the ordered mediation trace cannot hide a raw fstat wrapper in markRetained", async () => {
    const source = await readFile(capabilitiesSourcePath, "utf8");
    expect(markRetainedHasRawFstat(source)).toBe(false);
    expect(markRetainedHasRawFstat(replaceSourceAnchor(
      source,
      '    record.state = "retained";',
      '    fstatSync(record.fd, { bigint: true });\n    record.state = "retained";'
    ))).toBe(true);
  });

  test("AST structural oracle ignores formatting, comments, strings, and local descriptor decoys", async () => {
    const source = await readFile(capabilitiesSourcePath, "utf8");
    const formattedRawOperands = replaceSourceAnchor(
      replaceSourceAnchor(
        replaceSourceAnchor(
          replaceSourceAnchor(
            source,
            "readSync(record.fd, buffer, offset, length, position)",
            `readSync(
      record
        .fd,
      buffer,
      offset,
      length,
      position
    )`
          ),
          "openAtPrimitive(parentRecord.fd, childPath, flags)",
          `openAtPrimitive(
      parentRecord
        .fd,
      childPath,
      flags
    )`
        ),
        "fstatSync(record.fd, { bigint: true })",
        `fstatSync(
      record
        .fd,
      { bigint: true }
    )`
      ),
      "      closeSync(record.fd);",
      `      closeSync(
        record
          .fd
      );`
    );
    expect(structuralDescriptorDenials(formattedRawOperands)).toEqual([]);

    const sourceWithDecoys = `${source}
/* readSync(0, buffer, offset, length, position); openAt()(-100, childCString(childName), flags); */
const structuralDescriptorTextDecoy = "readSync(0, buffer, offset, length, position); openAt()(-100, childCString(childName), flags);";
function localDescriptorDecoy(): void {
  const descriptor = {};
  const parent = {};
  const record = { fd: 0 };
  const parentRecord = { fd: -100 };
  const readSync = (_descriptor: number): number => 0;
  const fstatSync = (_descriptor: number): number => 0;
  const closeSync = (_descriptor: number): void => undefined;
  const openAt = () => (_parent: number): number => 0;
  readSync(record.fd);
  fstatSync(record.fd);
  closeSync(record.fd);
  openAt()(parentRecord.fd);
}
`;
    expect(structuralDescriptorDenials(sourceWithDecoys)).toEqual([]);
  });

  test("AST structural oracle does not let textual copies counterfeit required descriptor nodes", async () => {
    const source = await readFile(capabilitiesSourcePath, "utf8");
    let counterfeit = replaceSourceAnchor(
      source,
      "stat(descriptor: CapabilityDescriptor)",
      "stat(descriptor: number)"
    );
    counterfeit = replaceSourceAnchor(
      counterfeit,
      "    phase: CapabilityPhase\n  ): CapabilityDescriptor {",
      "    phase: string\n  ): CapabilityDescriptor {"
    );
    counterfeit = replaceSourceAnchor(counterfeit, "owner: CloseOwner", "owner: string");
    counterfeit = replaceSourceAnchor(
      counterfeit,
      "readSync(record.fd, buffer, offset, length, position)",
      "0"
    );
    counterfeit = replaceSourceAnchor(
      counterfeit,
      "openAtPrimitive(parentRecord.fd, childPath, flags)",
      "-1"
    );
    counterfeit = replaceSourceAnchor(
      counterfeit,
      "fstatSync(record.fd, { bigint: true })",
      "undefined as never"
    );
    counterfeit = replaceSourceAnchor(counterfeit, "      closeSync(record.fd);", "      return;");
    counterfeit = counterfeit
      .replaceAll("#registry", "#registryUnchecked")
      .replaceAll("#currentGenerationByDescriptor", "#generationUnchecked")
      .replaceAll("flags ===", "flags !==");
    counterfeit = replaceSourceAnchor(counterfeit, "owner !== expectedOwner", "owner === expectedOwner");

    const sourceWithCounterfeitText = `${counterfeit}
const structuralDescriptorCounterfeit = [
  "openRelative(parent: CapabilityDescriptor, phase: CapabilityPhase)",
  "stat(descriptor: CapabilityDescriptor)",
  "readRetained(descriptor: CapabilityDescriptor, phase: CapabilityPhase)",
  "close(descriptor: CapabilityDescriptor, owner: CloseOwner)",
      "readSync(record.fd, buffer, offset, length, position)",
      "openAtPrimitive(parentRecord.fd, childPath, flags)",
      "fstatSync(record.fd, { bigint: true })",
      "closeSync(record.fd)",
  "readonly #registry = new WeakMap",
  "this.#registry.get(capability)",
  "readonly #currentGenerationByDescriptor = new Map",
  "this.#currentGenerationByDescriptor.get(record.fd)",
  "flags === DIRECTORY_OPEN_FLAGS",
  "flags === FILE_OPEN_FLAGS",
  "owner !== expectedOwner"
].join(" ");
`;
    expect(structuralDescriptorDenials(sourceWithCounterfeitText)).toEqual([
      "raw_read_descriptor_not_handle",
      "openat_parent_not_handle",
      "raw_fstat_descriptor_not_handle",
      "raw_close_descriptor_not_handle",
      "raw_descriptor_operation_shape",
      "foreign_descriptor_shape",
      "stale_descriptor_shape",
      "flags_invalid_shape",
      "owner_mismatch_shape"
    ]);
  });

  test("the checked-in source keeps only private retained-descriptor operands and mediated raw primitives", async () => {
    const source = await readFile(capabilitiesSourcePath, "utf8");
    expect(source).toContain('invokeDescriptorPrimitive("open_root", () => openSync(root, DIRECTORY_OPEN_FLAGS))');
    expect(source).toContain('invokeDescriptorPrimitive(\n      "openat",\n      () => openAtPrimitive');
    expect(source).toContain('invokeDescriptorPrimitive("fstat_sync", () => fstatSync(record.fd, { bigint: true }))');
    expect(source).toContain('invokeDescriptorPrimitive("read_sync", () => readSync(record.fd, buffer, offset, length, position))');
    expect(source).toContain('invokeDescriptorPrimitive("close_sync", () => {');
    expect(source).not.toContain('invokeDescriptorPrimitive("mark_retained"');
    expect(source).toContain("openAtPrimitive(parentRecord.fd, childPath, flags)");
    expect(source).toContain("fstatSync(record.fd,");
    expect(source).toContain("readSync(record.fd,");
    expect(source).toContain("closeSync(record.fd)");
    expect(source).not.toContain("openAt()(-100,");
  });
});
