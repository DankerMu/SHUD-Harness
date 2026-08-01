import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import ts from "typescript";

const contractsRoot = join(import.meta.dir, "..");
const authorityPreloadPath = join(import.meta.dir, "authority-preload.ts");
const typeConfigPath = join(contractsRoot, "tsconfig.authority.json");

const EXPECTED_AUTHORITY_TYPE_PROOF_ROOTS = [
  "tests/authority-preload.ts",
  "tests/authority-runtime.test.ts",
  "tests/authority-structural.test.ts",
  "tests/authority-topology-ast.ts",
  "tests/authority-topology-control.ts",
  "tests/authority-topology-preload.ts",
  "tests/authority-topology-round-one.ts",
  "tests/authority-topology.ts",
  "tests/authority-typeproof.test.ts"
].map((path) => resolve(contractsRoot, path)).sort();

// Exact source-hash witnesses own these restored #172/#175 inputs and their legacy strict diagnostics.
const FROZEN_AUTHORITY_RUNTIME_INPUTS = [
  "tests/authority-control.ts",
  "tests/authority-vocabulary.ts",
  "tests/authority-worker.ts"
].map((path) => resolve(contractsRoot, path)).sort();

function normalizedPath(path: string): string {
  const absolute = resolve(path);
  return ts.sys.useCaseSensitiveFileNames ? absolute : absolute.toLowerCase();
}

type ParsedAuthorityTypeConfig = Readonly<{
  parsed: ts.ParsedCommandLine;
  unrecoverableDiagnostics: readonly ts.Diagnostic[];
}>;

function parseAuthorityTypeConfig(): ParsedAuthorityTypeConfig {
  const unrecoverableDiagnostics: ts.Diagnostic[] = [];
  const configHost: ts.ParseConfigFileHost = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic(diagnostic) {
      unrecoverableDiagnostics.push(diagnostic);
    }
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(typeConfigPath, {}, configHost);
  if (!parsed) throw new Error("authority type proof configuration is unreadable");
  return { parsed, unrecoverableDiagnostics };
}

function createAuthorityProgram(
  parsed: ts.ParsedCommandLine,
  injectedPreloadSource?: string
): ts.Program {
  if (injectedPreloadSource === undefined) {
    return ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  }

  const host = ts.createCompilerHost(parsed.options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    if (normalizedPath(fileName) !== normalizedPath(authorityPreloadPath)) {
      return originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    }
    return ts.createSourceFile(fileName, injectedPreloadSource, languageVersion, true);
  };
  delete host.getSourceFileByPath;

  return ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options, host });
}


describe("authority type proof", () => {
  test("type-checks the mutable #176 implementation and focused test boundary, then rejects an injected preload mismatch", async () => {
    const { parsed, unrecoverableDiagnostics } = parseAuthorityTypeConfig();
    expect(parsed.errors).toHaveLength(0);
    expect(unrecoverableDiagnostics).toHaveLength(0);
    expect(parsed.options.noEmit).toBe(true);
    const rootNames = createAuthorityProgram(parsed).getRootFileNames().map(normalizedPath).sort();
    expect(rootNames).toEqual(EXPECTED_AUTHORITY_TYPE_PROOF_ROOTS.map(normalizedPath));
    expect(rootNames.some((rootName) => FROZEN_AUTHORITY_RUNTIME_INPUTS.includes(rootName))).toBe(false);
    expect(ts.getPreEmitDiagnostics(createAuthorityProgram(parsed))).toHaveLength(0);

    const preloadSource = await readFile(authorityPreloadPath, "utf8");
    const injectedDiagnostics = ts.getPreEmitDiagnostics(createAuthorityProgram(
      parsed,
      `${preloadSource}\nconst __authorityTypeProofInjectedMismatch: number = "not-a-number";\n`
    ));
    expect(injectedDiagnostics).toHaveLength(1);
    expect(injectedDiagnostics.some((diagnostic) => (
      diagnostic.code === 2322
      && diagnostic.file !== undefined
      && normalizedPath(diagnostic.file.fileName) === normalizedPath(authorityPreloadPath)
    ))).toBe(true);
  });
});
