import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  capabilitiesSourcePath,
  structuralDescriptorDenials,
  withCompiledProductionTree,
  type ProductionMutation
} from "./authority-descriptor-vocabulary";

const EXPECTED_STRUCTURAL_DENIAL: Readonly<Record<ProductionMutation, readonly string[]>> = Object.freeze({
  fd0: ["raw_read_descriptor_not_handle"],
  at_fdcwd: ["openat_parent_not_handle"],
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

  test("AST structural oracle ignores formatting, comments, strings, and local descriptor decoys", async () => {
    const source = await readFile(capabilitiesSourcePath, "utf8");
    const formattedRawOperands = replaceSourceAnchor(
      replaceSourceAnchor(
        source,
        "    return readSync(descriptor.fd, buffer, offset, length, position);",
        `    return readSync(
      descriptor
        .fd,
      buffer,
      offset,
      length,
      position
    );`
      ),
      "    const descriptor = openAt()(parent.fd, childCString(childName), flags);",
      `    const descriptor = openAt()(
      parent
        .fd,
      childCString(childName),
      flags
    );`
    );
    expect(structuralDescriptorDenials(formattedRawOperands)).toEqual([]);

    const sourceWithDecoys = `${source}
/* readSync(0, buffer, offset, length, position); openAt()(-100, childCString(childName), flags); */
const structuralDescriptorTextDecoy = "readSync(0, buffer, offset, length, position); openAt()(-100, childCString(childName), flags);";
function localDescriptorDecoy(): void {
  const descriptor = { fd: 0 };
  const parent = { fd: -100 };
  const readSync = (_descriptor: number): number => 0;
  const openAt = () => (_parent: number): number => 0;
  readSync(descriptor.fd);
  openAt()(parent.fd);
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
      "    phase: CapabilityPhase\n  ): CapabilityDescriptor {\n    const requestedPhase =",
      "    phase: string\n  ): CapabilityDescriptor {\n    const requestedPhase ="
    );
    counterfeit = replaceSourceAnchor(counterfeit, "owner: CloseOwner", "owner: string");
    counterfeit = replaceSourceAnchor(
      counterfeit,
      "    return readSync(descriptor.fd, buffer, offset, length, position);",
      "    return 0;"
    );
    counterfeit = replaceSourceAnchor(
      counterfeit,
      "    const descriptor = openAt()(parent.fd, childCString(childName), flags);",
      "    const descriptor = -1;"
    );
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
  "readSync(descriptor.fd, buffer, offset, length, position)",
  "openAt()(parent.fd, childCString(childName), flags)",
  "readonly #registry = new WeakMap",
  "this.#registry.get(capability)",
  "readonly #currentGenerationByDescriptor = new Map",
  "this.#currentGenerationByDescriptor.get(record.descriptor.fd)",
  "flags === DIRECTORY_OPEN_FLAGS",
  "flags === FILE_OPEN_FLAGS",
  "owner !== expectedOwner"
].join(" ");
`;
    expect(structuralDescriptorDenials(sourceWithCounterfeitText)).toEqual([
      "raw_read_descriptor_not_handle",
      "openat_parent_not_handle",
      "raw_descriptor_operation_shape",
      "foreign_descriptor_shape",
      "stale_descriptor_shape",
      "flags_invalid_shape",
      "owner_mismatch_shape"
    ]);
  });

  test("the checked-in source keeps the retained-read anchor and no ambient parent operand", async () => {
    const source = await readFile(capabilitiesSourcePath, "utf8");
    expect(source).toContain("return readSync(descriptor.fd,");
    expect(source).not.toContain("openAt()(-100,");
  });
});
