import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { AUTHORITY_PROOF_REGISTRY, AUTHORITY_PROOF_ROWS } from "./authority-vocabulary";
import type { AuthorityProofRow } from "./authority-vocabulary";

const contractsRoot = join(import.meta.dir, "..");
const productionCheckPath = join(contractsRoot, "check.ts");
const productionLibPath = join(contractsRoot, "lib");

const EXPECTED_AUTHORITY_PROOF_VERSION = "shud.contract.authority-proof.v2";
const EXPECTED_AUTHORITY_PROOF_ROW_COUNT = 55;
const EXPECTED_AUTHORITY_PROOF_REGISTRY_SHA256 = "8ae389ead0f1aaad27cdeb080f66e1841376552a963ef9069657d929a118a725";

function authorityRegistryProjection(): string {
  return JSON.stringify({
    version: AUTHORITY_PROOF_REGISTRY.version,
    count: AUTHORITY_PROOF_ROWS.length,
    rows: AUTHORITY_PROOF_ROWS.map((row) => [
      row.id,
      row.control,
      row.structuralViolation,
      row.denialEvent.operation,
      row.denialEvent.target,
      row.sideEffects
    ])
  });
}

function expectFrozenAuthorityRegistry(): void {
  expect(AUTHORITY_PROOF_REGISTRY.version).toBe(EXPECTED_AUTHORITY_PROOF_VERSION);
  expect(AUTHORITY_PROOF_ROWS).toHaveLength(EXPECTED_AUTHORITY_PROOF_ROW_COUNT);
  expect(createHash("sha256").update(authorityRegistryProjection(), "utf8").digest("hex"))
    .toBe(EXPECTED_AUTHORITY_PROOF_REGISTRY_SHA256);
  expect(new Set(AUTHORITY_PROOF_ROWS.map((row) => row.id)).size).toBe(AUTHORITY_PROOF_ROWS.length);
  expect(new Set(AUTHORITY_PROOF_ROWS.map((row) => row.control)).size).toBe(AUTHORITY_PROOF_ROWS.length);
}

const EXACT_PRODUCTION_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  "check.ts": ['import { runCheck } from "./lib/checker";'],
  "lib/canonical-json.ts": [],
  "lib/capabilities.ts": [
    'import { dlopen } from "bun:ffi";',
    'import { closeSync, constants, fstatSync, openSync, readSync, type BigIntStats } from "node:fs";'
  ],
  "lib/checker.ts": [
    'import { ERROR_SCHEMA, SOURCE_PROFILE, SUCCESS_SCHEMA } from "./constants";',
    'import {\n  ContractError,\n  readBoundedFile,\n  type DescriptorIngressHooks\n} from "./ingress";',
    'import { admitSourceInput, type SourceInputKind } from "./schemas";'
  ],
  "lib/constants.ts": [],
  "lib/ingress.ts": [
    'import { parse, resolve, sep } from "node:path";',
    'import { hasOnlyUnicodeScalars } from "./canonical-json";',
    'import {\n  ContractCapabilities,\n  DIRECTORY_OPEN_FLAGS,\n  FILE_OPEN_FLAGS,\n  type BigIntStats,\n  type CapabilityHooks,\n  type ContractAuthorityFault\n} from "./capabilities";'
  ],
  "lib/schemas.ts": [
    'import { posix } from "node:path";',
    'import { canonicalJson } from "./canonical-json";',
    'import { SOURCE_PROFILE } from "./constants";',
    'import { ContractError, parseBoundedJson } from "./ingress";'
  ]
};

const EXACT_PRODUCTION_GLOBALS: Readonly<Record<string, Readonly<{
  process: readonly string[];
  Bun: readonly string[];
}>>> = {
  "check.ts": { process: ["stdout", "stderr", "exit"], Bun: ["argv"] },
  "lib/canonical-json.ts": { process: [], Bun: [] },
  "lib/capabilities.ts": { process: ["platform", "platform"], Bun: [] },
  "lib/checker.ts": { process: [], Bun: [] },
  "lib/constants.ts": { process: [], Bun: [] },
  "lib/ingress.ts": { process: ["platform"], Bun: [] },
  "lib/schemas.ts": { process: [], Bun: [] }
};

const EXACT_PRODUCTION_OBJECT_PROPERTIES: Readonly<Record<string, readonly string[]>> = {
  "check.ts": [],
  "lib/canonical-json.ts": ["keys"],
  "lib/capabilities.ts": ["freeze"],
  "lib/checker.ts": [],
  "lib/constants.ts": ["freeze"],
  "lib/ingress.ts": ["freeze", "create"],
  "lib/schemas.ts": ["keys"]
};

const EXACT_PRODUCTION_ELEMENT_ACCESSES: Readonly<Record<string, readonly string[]>> = {
  "check.ts": [],
  "lib/canonical-json.ts": ["record[key]"],
  "lib/capabilities.ts": [],
  "lib/checker.ts": ["args[index]", "args[++index]"],
  "lib/constants.ts": [],
  "lib/ingress.ts": [
    "components[index]",
    "segments[index]",
    "admission.components[index]",
    "admission.components[index - 1]",
    "this.text[this.cursor]",
    "this.text[this.cursor]",
    "this.text[this.cursor]",
    "this.text[this.cursor]",
    "result[key]",
    "this.text[this.cursor++]",
    "this.text[this.cursor]",
    "this.text[this.cursor++]",
    "this.text[this.cursor]",
    "this.text[this.cursor]",
    "match[0]",
    "match[0]",
    "this.text[this.cursor]"
  ],
  "lib/schemas.ts": [
    "expected[index]",
    "sorted[index]",
    "value.argv[13]",
    "value.argv[index]",
    "value.argv[14]",
    "primaryTuple[index]",
    "witnessTuple[index]",
    "value.platforms[index]",
    "expectedPlatforms[index]",
    "value.platforms[0]",
    "value.platforms[1]",
    "peers[0]"
  ]
};

const EXACT_PRODUCTION_BINDINGS: Readonly<Record<string, readonly string[]>> = {
  "check.ts": [],
  "lib/canonical-json.ts": [],
  "lib/capabilities.ts": [],
  "lib/checker.ts": [],
  "lib/constants.ts": [],
  "lib/ingress.ts": [],
  "lib/schemas.ts": []
};

function quotedModuleSpecifier(node: ts.ImportDeclaration): string {
  return ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : "<nonliteral>";
}

function importMetaExpression(node: ts.Expression): boolean {
  return ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword && node.name.text === "meta";
}

function structuralAuthorityViolations(relative: string, text: string): string[] {
  const source = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const expectedImports = EXACT_PRODUCTION_IMPORTS[relative];
  const expectedGlobals = EXACT_PRODUCTION_GLOBALS[relative];
  const expectedObjectProperties = EXACT_PRODUCTION_OBJECT_PROPERTIES[relative];
  const expectedElementAccesses = EXACT_PRODUCTION_ELEMENT_ACCESSES[relative];
  const expectedBindings = EXACT_PRODUCTION_BINDINGS[relative];
  const violations = new Set<string>();
  const imports = source.statements.filter(ts.isImportDeclaration).map((node) => node.getText(source));
  const globals = { process: [] as string[], Bun: [] as string[] };
  const objectProperties: string[] = [];
  const elementAccesses: string[] = [];
  const bindings: string[] = [];

  if (!expectedImports || !expectedGlobals || !expectedObjectProperties || !expectedElementAccesses || !expectedBindings) {
    violations.add(`unlisted_production_file:${relative}`);
  }
  if (JSON.stringify(imports) !== JSON.stringify(expectedImports ?? [])) {
    violations.add(`import_inventory:${relative}`);
  }
  for (const declaration of source.statements.filter(ts.isImportDeclaration)) {
    if (!(expectedImports ?? []).includes(declaration.getText(source))) {
      violations.add(`unapproved_import:${quotedModuleSpecifier(declaration)}`);
    }
  }

  const forbiddenIdentifiers = new Set([
    "require", "createRequire", "getBuiltinModule", "eval", "Function", "Worker", "global", "Reflect", "module"
  ]);

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      violations.add("dynamic_import");
    }
    if (ts.isImportEqualsDeclaration(node) || ts.isExportDeclaration(node) && node.moduleSpecifier) {
      violations.add("alternate_module_declaration");
    }
    if (ts.isElementAccessExpression(node)) {
      const elementAccess = node.getText(source);
      elementAccesses.push(elementAccess);
      if (importMetaExpression(node.expression)) violations.add("forbidden_import_meta:require");
      if (!(expectedElementAccesses ?? []).includes(elementAccess)) violations.add("unapproved_element_access");
    }
    if (ts.isBindingElement(node)) {
      const binding = node.getText(source);
      bindings.push(binding);
      if (!(expectedBindings ?? []).includes(binding)) violations.add("unapproved_binding");
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === "constructor") {
      violations.add("forbidden_constructor");
    }
    if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) &&
        node.argumentExpression.text === "constructor") {
      violations.add("forbidden_computed_constructor");
    }
    if (ts.isPropertyAccessExpression(node) && importMetaExpression(node.expression) && node.name.text === "require") {
      violations.add("forbidden_import_meta:require");
    }
    if (ts.isIdentifier(node) && (node.text === "process" || node.text === "Bun")) {
      const parent = node.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        const globalName = node.text;
        const property = parent.name.text;
        globals[globalName].push(property);
        if (!(expectedGlobals?.[globalName] ?? []).includes(property)) {
          violations.add(`unapproved_global:${globalName}.${property}`);
        }
      } else if (ts.isElementAccessExpression(parent) && parent.expression === node) {
        violations.add(`computed_global:${node.text}`);
      } else {
        violations.add(`bare_global:${node.text}`);
      }
    } else if (ts.isIdentifier(node) && node.text === "Object") {
      const parent = node.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        const property = parent.name.text;
        objectProperties.push(property);
        if (!(expectedObjectProperties ?? []).includes(property)) {
          violations.add(`unapproved_object:Object.${property}`);
        }
      } else {
        violations.add("bare_global:Object");
      }
    } else if (ts.isIdentifier(node) && node.text === "globalThis") {
      const parent = node.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        violations.add(`unapproved_global:globalThis.${parent.name.text}`);
      } else if (ts.isElementAccessExpression(parent) && parent.expression === node) {
        violations.add("computed_global:globalThis");
      } else {
        violations.add("forbidden_identifier:globalThis");
      }
    } else if (ts.isIdentifier(node) && forbiddenIdentifiers.has(node.text)) {
      violations.add(`forbidden_identifier:${node.text}`);
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  for (const globalName of ["process", "Bun"] as const) {
    if (JSON.stringify(globals[globalName]) !== JSON.stringify(expectedGlobals?.[globalName] ?? [])) {
      violations.add(`${globalName}_properties:${JSON.stringify(globals[globalName])}`);
    }
  }
  if (JSON.stringify(objectProperties) !== JSON.stringify(expectedObjectProperties ?? [])) {
    violations.add(`Object_properties:${JSON.stringify(objectProperties)}`);
  }
  if (JSON.stringify(elementAccesses) !== JSON.stringify(expectedElementAccesses ?? [])) {
    violations.add(`element_accesses:${JSON.stringify(elementAccesses)}`);
  }
  if (JSON.stringify(bindings) !== JSON.stringify(expectedBindings ?? [])) {
    violations.add(`bindings:${JSON.stringify(bindings)}`);
  }
  return [...violations].sort();
}

function injectProductionMutation(source: string, row: AuthorityProofRow): string {
  const firstLineEnd = source.indexOf("\n");
  if (firstLineEnd < 0) throw new Error("CHECK_ENTRYPOINT_MISSING_SHEBANG_LINE");
  return `${source.slice(0, firstLineEnd + 1)}\n// ${row.id}\n${row.mutation}\n${source.slice(firstLineEnd + 1)}`;
}

async function compileProductionMutation(row: AuthorityProofRow, source: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "shud-authority-structural-"));
  try {
    const entrypoint = join(root, "check.ts");
    await symlink(productionLibPath, join(root, "lib"), "dir");
    await writeFile(entrypoint, source);
    const result = await Bun.build({
      entrypoints: [entrypoint],
      target: "bun",
      format: "esm",
      sourcemap: "none",
      write: false
    });
    if (!result.success) {
      throw new Error(`${row.id} did not compile: ${result.logs.map((log) => log.message).join("\n")}`);
    }
    expect(result.outputs.length).toBeGreaterThan(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function productionSources(): Promise<Readonly<Record<string, string>>> {
  const libraryFiles = (await readdir(productionLibPath))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => `lib/${name}`)
    .sort();
  const files = ["check.ts", ...libraryFiles].sort();
  expect(files).toEqual(Object.keys(EXACT_PRODUCTION_IMPORTS).sort());
  const entries = await Promise.all(files.map(async (relative) => [
    relative,
    await readFile(join(contractsRoot, relative), "utf8")
  ] as const));
  return Object.fromEntries(entries);
}

describe("source-ingress authority structural proof", () => {
  test("binds the exact independent authority registry contract", () => {
    expectFrozenAuthorityRegistry();
  });

  test("pins the exact production TypeScript inventory, imports, and ambient globals", async () => {
    expect(Bun.version).toBe("1.2.19");
    const sources = await productionSources();
    for (const [relative, source] of Object.entries(sources)) {
      expect(structuralAuthorityViolations(relative, source)).toEqual([]);
    }
  });

  test("compiles every hostile mutation in the real check entrypoint before its independent AST rejection", async () => {
    expectFrozenAuthorityRegistry();

    const checkSource = await readFile(productionCheckPath, "utf8");
    for (const row of AUTHORITY_PROOF_ROWS) {
      const mutatedSource = injectProductionMutation(checkSource, row);
      await compileProductionMutation(row, mutatedSource);
      expect(structuralAuthorityViolations("check.ts", mutatedSource)).toContain(row.structuralViolation);
    }
  });
});
