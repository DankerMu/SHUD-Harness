import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import ts from "typescript";

const NODE_TYPE_OPTIONS: ts.CompilerOptions = {
  types: ["node"],
  typeRoots: [dirname(dirname(createRequire(import.meta.url).resolve("@types/node/package.json")))],
};

describe("core schema type contracts", () => {
  test("public schema barrel preserves Artifact and ArtifactManifest input/output requiredness", () => {
    const barrelPath = join(dirname(fileURLToPath(import.meta.url)), "index.ts");
    const program = ts.createProgram({
      rootNames: [barrelPath],
      options: {
        ...NODE_TYPE_OPTIONS,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        allowImportingTsExtensions: true,
        noEmit: true,
        skipLibCheck: true,
        target: ts.ScriptTarget.ES2022,
        lib: ["lib.es2022.d.ts"],
      },
    });
    expect(
      ts
        .getPreEmitDiagnostics(program)
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
    ).toEqual([]);

    const source = program.getSourceFile(barrelPath);
    expect(source).toBeDefined();
    const checker = program.getTypeChecker();
    const moduleSymbol = source ? checker.getSymbolAtLocation(source) : undefined;
    expect(moduleSymbol).toBeDefined();
    const exportsByName = new Map(
      moduleSymbol
        ? checker.getExportsOfModule(moduleSymbol).map((symbol) => [symbol.getName(), symbol])
        : [],
    );

    for (const inputTypeName of ["Artifact", "ArtifactInput"] as const) {
      const inputTypeSymbol = exportsByName.get(inputTypeName);
      expect(inputTypeSymbol).toBeDefined();
      const inputType = inputTypeSymbol
        ? checker.getDeclaredTypeOfSymbol(inputTypeSymbol)
        : undefined;
      const marker = inputType?.getProperty("llm_generated");
      expect(marker).toBeDefined();
      expect(Boolean(marker && marker.flags & ts.SymbolFlags.Optional)).toBe(true);
    }

    const storedTypeSymbol = exportsByName.get("StoredArtifact");
    expect(storedTypeSymbol).toBeDefined();
    const storedType = storedTypeSymbol
      ? checker.getDeclaredTypeOfSymbol(storedTypeSymbol)
      : undefined;
    const storedMarker = storedType?.getProperty("llm_generated");
    expect(storedMarker).toBeDefined();
    expect(Boolean(storedMarker && storedMarker.flags & ts.SymbolFlags.Optional)).toBe(false);
    expect(
      storedMarker && source
        ? checker.typeToString(checker.getTypeOfSymbolAtLocation(storedMarker, source))
        : undefined,
    ).toBe("boolean");

    for (const manifestTypeName of [
      "ArtifactManifest",
      "ArtifactManifestInput",
      "StoredArtifactManifest",
    ] as const) {
      const manifestTypeSymbol = exportsByName.get(manifestTypeName);
      expect(manifestTypeSymbol).toBeDefined();
      const manifestType = manifestTypeSymbol
        ? checker.getDeclaredTypeOfSymbol(manifestTypeSymbol)
        : undefined;

      for (const requiredField of [
        "manifest_id",
        "task_id",
        "artifacts",
        "generated_at",
        "generator",
      ] as const) {
        const field = manifestType?.getProperty(requiredField);
        expect(field).toBeDefined();
        expect(Boolean(field && field.flags & ts.SymbolFlags.Optional)).toBe(false);
      }

      for (const optionalField of [
        "run_id",
        "report_id",
        "superseded_by",
        "manifest_sha256",
      ] as const) {
        const field = manifestType?.getProperty(optionalField);
        expect(field).toBeDefined();
        expect(Boolean(field && field.flags & ts.SymbolFlags.Optional)).toBe(true);
      }
    }
  });
});
