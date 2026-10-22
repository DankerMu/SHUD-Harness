// ESLint flat config. Thresholds mirror constraints.yaml (`thresholds.max_file_lines`,
// `exemptions.max_file_lines`); change them there first, then here.
import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

const MAX_FILE_LINES = 1000;

// Q1.4b frozen baseline (constraints.yaml `baseline.max_file_lines`). Ratchet targets:
// policy-gate-core.ts + its test → M3. New files get no exemption.
const FROZEN_OVERSIZED_FILES = [
  "packages/dsh-shud-core/src/governance/policy-gate-core.ts",
  "packages/dsh-shud-core/src/governance/policy-gate-core.test.ts",
];

// ADR-0006: package-wide runtime seams and the named-only message capability.
const HOST_IMPORT_PATTERNS = [
  {
    group: ["**/deepseek-harness/**"],
    message:
      "Direct host-checkout imports, including types, are forbidden; use documented package seams (ADR-0006).",
  },
  {
    regex: "^@deepseek-ai/(?!(?:dsh-tools|cordis|dsh-jobs|dsh-jobs-local|dsh-llm|dsh-scope)$)",
    allowTypeImports: true,
    message:
      "This host package is type-only; runtime imports require an explicit documented seam (ADR-0006).",
  },
];

const HOST_MESSAGE_IMPORT = {
  name: "@deepseek-ai/dsh-llm",
  allowImportNames: ["createUserMessage"],
  allowTypeImports: true,
  message: "Only the named createUserMessage runtime import is allowed from dsh-llm (ADR-0006).",
};

const HOST_SCOPE_IMPORT = {
  name: "@deepseek-ai/dsh-scope",
  allowTypeImports: true,
  message:
    "Only named createScope in *.test.ts or test-harness.ts may import dsh-scope at runtime (ADR-0006).",
};

// no-restricted-imports cannot check allowImportNames when there are no specifiers.
function emptyRuntimeImportRestriction(source) {
  return {
    selector:
      `:matches(ImportDeclaration[importKind!='type'], ExportNamedDeclaration[exportKind!='type'])` +
      `[source.value='${source}'][specifiers.length=0]`,
    message: `Runtime imports from ${source} must name an allowed capability (ADR-0006).`,
  };
}

// With verbatimModuleSyntax, all-inline-type declarations still load the source module.
// Zero-specifier declarations are covered by the existing package/named-only restrictions.
const INLINE_TYPE_RUNTIME_IMPORT = {
  selector:
    ":matches(" +
    "ImportDeclaration[importKind!='type']:not(:has(ImportSpecifier[importKind!='type'], ImportDefaultSpecifier, ImportNamespaceSpecifier)), " +
    "ExportNamedDeclaration[exportKind!='type']:not(:has(ExportSpecifier[exportKind!='type']))" +
    ")[specifiers.length>0]" +
    "[source.value=/^@deepseek-ai\\u002F(?!(?:dsh-tools|cordis|dsh-jobs|dsh-jobs-local)$)/]",
  message:
    "Inline type specifiers retain a runtime host dependency; use declaration-level import type or export type (ADR-0006).",
};

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/lib/**",
      "coverage/**",
      "SHUD/**",
      "rSHUD/**",
      "AutoSHUD/**",
      ".agents/**",
      ".claude/**",
      ".codex/**",
      ".omp/**",
      ".obsidian/**",
      ".github/**",
      "docs/**",
      "openspec/**",
      "profile/**",
      "templates/**",
      "skills/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["**/*.ts", "**/*.mjs"],
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.eslint.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "max-lines": ["error", { max: MAX_FILE_LINES, skipBlankLines: false, skipComments: false }],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-restricted-imports": [
        "error",
        {
          paths: [HOST_MESSAGE_IMPORT, HOST_SCOPE_IMPORT],
          patterns: HOST_IMPORT_PATTERNS,
        },
      ],
      "no-restricted-syntax": [
        "error",
        emptyRuntimeImportRestriction(HOST_MESSAGE_IMPORT.name),
        INLINE_TYPE_RUNTIME_IMPORT,
      ],
    },
  },
  {
    files: ["**/*.test.ts", "**/test-harness.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [HOST_MESSAGE_IMPORT, { ...HOST_SCOPE_IMPORT, allowImportNames: ["createScope"] }],
          patterns: HOST_IMPORT_PATTERNS,
        },
      ],
      "no-restricted-syntax": [
        "error",
        emptyRuntimeImportRestriction(HOST_MESSAGE_IMPORT.name),
        emptyRuntimeImportRestriction(HOST_SCOPE_IMPORT.name),
        INLINE_TYPE_RUNTIME_IMPORT,
      ],
    },
  },
  {
    files: ["**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: FROZEN_OVERSIZED_FILES,
    rules: { "max-lines": "off" },
  },
  // Q1.4b frozen baseline: pre-existing type-safety findings in ported code
  // (constraints.yaml `baseline.eslint_type_safety`). Removal trigger: M3 split of
  // policy-gate-core (+test).
  {
    files: ["packages/dsh-shud-core/src/governance/policy-gate-core.ts"],
    rules: { "@typescript-eslint/no-unsafe-assignment": "off" },
  },
  {
    files: ["packages/dsh-shud-core/src/governance/policy-gate-core.test.ts"],
    rules: { "@typescript-eslint/no-unsafe-return": "off" },
  },
  prettier,
);
