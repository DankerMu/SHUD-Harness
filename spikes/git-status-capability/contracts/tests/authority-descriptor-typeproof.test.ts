import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
import { contractsRoot, withProductionTree } from "./authority-descriptor-vocabulary";

const typeProofPath = join(import.meta.dir, "authority-descriptor-typeproof.ts");
const typeConfigPath = join(contractsRoot, "tsconfig.descriptor-authority.json");

type TypeProofMutation =
  | "descriptor_extra"
  | "descriptor_missing"
  | "policy_extra"
  | "policy_missing"
  | "ingress_extra"
  | "ingress_missing"
  | "primitive_invocation_result"
  | "primitive_mediator_operation"
  | "primitive_mediator_result"
  | "primitive_mediator_promise_result"
  | "close_extra_argument";

function compilerOptions(): ts.CompilerOptions {
  const parsed = ts.getParsedCommandLineOfConfigFile(typeConfigPath, {}, ts.sys);
  if (!parsed) throw new Error("descriptor type proof configuration is unreadable");
  if (parsed.errors.length > 0) {
    throw new Error(ts.flattenDiagnosticMessageText(parsed.errors[0]!.messageText, "\n"));
  }
  return parsed.options;
}

function compileNoEmit(rootName: string): readonly ts.Diagnostic[] {
  const program = ts.createProgram({ rootNames: [rootName], options: compilerOptions() });
  return ts.getPreEmitDiagnostics(program).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
}

function mutateVocabularySource(
  source: string,
  mutation: TypeProofMutation
): string {
  if (mutation === "primitive_invocation_result") {
    return source.replace(
      "export type DescriptorPrimitiveInvocation = () => unknown;",
      "export type DescriptorPrimitiveInvocation = () => number;"
    );
  }
  if (mutation === "primitive_mediator_operation") {
    return source.replace(
      "  operation: DescriptorOperation,\n  invoke: DescriptorPrimitiveInvocation\n) => undefined;",
      "  operation: \"open_root\",\n  invoke: DescriptorPrimitiveInvocation\n) => undefined;"
    );
  }
  if (mutation === "primitive_mediator_result") {
    return source.replace(
      "  operation: DescriptorOperation,\n  invoke: DescriptorPrimitiveInvocation\n) => undefined;",
      "  operation: DescriptorOperation,\n  invoke: DescriptorPrimitiveInvocation\n) => string;"
    );
  }
  if (mutation === "primitive_mediator_promise_result") {
    return source.replace(
      "  invoke: DescriptorPrimitiveInvocation\n) => undefined;",
      "  invoke: DescriptorPrimitiveInvocation\n) => undefined | Promise<undefined>;"
    );
  }
  if (mutation === "close_extra_argument") {
    return source.replace(
      "  close(descriptor: CapabilityDescriptor, owner: CloseOwner): void {",
      "  close(descriptor: CapabilityDescriptor, owner: CloseOwner, ignored?: () => boolean): void {"
    );
  }
  if (mutation === "descriptor_extra") {
    return source.replace('  | "close_sync";', '  | "close_sync"\n  | "unexpected_operation";');
  }
  if (mutation === "descriptor_missing") return source.replace('  | "close_sync";\n', "");
  if (mutation === "policy_extra") {
    return source.replace(
      "  close_sync: Object.freeze({ owners: CLOSE_OWNERS_BY_STATE })\n});",
      "  close_sync: Object.freeze({ owners: CLOSE_OWNERS_BY_STATE }),\n" +
        "  unexpected_operation: Object.freeze({})\n});"
    );
  }
  if (mutation === "policy_missing") {
    return source.replace("  close_sync: Object.freeze({ owners: CLOSE_OWNERS_BY_STATE })\n});", "});");
  }
  if (mutation === "ingress_extra") {
    return source.replace(
      'operation: "open_root" | "open_relative" | "read_retained";',
      'operation: "open_root" | "open_relative" | "read_retained" | "unexpected_ingress_operation";'
    );
  }
  return source.replace(
    'operation: "open_root" | "open_relative" | "read_retained";',
    'operation: "open_root" | "open_relative";'
  );
}

async function compileMutatedProof(mutation: TypeProofMutation): Promise<readonly ts.Diagnostic[]> {
  let diagnostics: readonly ts.Diagnostic[] | undefined;
  await withProductionTree(undefined, async (tree) => {
    const proofSource = await readFile(typeProofPath, "utf8");
    const ingressPath = join(tree.root, "lib", "ingress.ts");
    const capabilitySource = await readFile(tree.capabilitiesPath, "utf8");
    const ingressSource = await readFile(ingressPath, "utf8");
    await writeFile(tree.capabilitiesPath, mutateVocabularySource(capabilitySource, mutation));
    await writeFile(ingressPath, mutateVocabularySource(ingressSource, mutation));
    const temporaryProofPath = join(tree.root, "authority-descriptor-typeproof.ts");
    await writeFile(
      temporaryProofPath,
      proofSource
        .replaceAll('"../lib/capabilities"', '"./lib/capabilities"')
        .replaceAll('"../lib/ingress"', '"./lib/ingress"')
    );
    diagnostics = compileNoEmit(temporaryProofPath);
  });
  if (!diagnostics) throw new Error("mutated descriptor type proof did not compile");
  return diagnostics;
}

describe("descriptor operation type proof", () => {
  test("the spike-local no-emit witness accepts only exact descriptor vocabulary and erased mediator types", async () => {
    expect(compileNoEmit(typeProofPath).length).toBe(0);

    for (const mutation of [
      "descriptor_extra",
      "descriptor_missing",
      "policy_extra",
      "policy_missing",
      "ingress_extra",
      "ingress_missing",
      "primitive_invocation_result",
      "primitive_mediator_operation",
      "primitive_mediator_result",
      "primitive_mediator_promise_result",
      "close_extra_argument"
    ] as const) {
      const diagnostics = await compileMutatedProof(mutation);
      expect(diagnostics.length).toBeGreaterThan(0);
    }
  });
});
