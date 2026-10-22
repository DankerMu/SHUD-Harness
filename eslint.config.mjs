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
          patterns: [
            {
              group: ["**/deepseek-harness/**"],
              message:
                "dsh is the host: import documented seams only via @deepseek-ai/dsh-tools or @deepseek-ai/cordis (ADR-0004 K2).",
            },
            {
              regex: "^@deepseek-ai/(?!(?:dsh-tools|cordis)$)",
              message:
                "Only @deepseek-ai/dsh-tools and @deepseek-ai/cordis are documented dsh seams (ADR-0004 K2).",
            },
          ],
        },
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
