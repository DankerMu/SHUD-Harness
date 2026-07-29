import { canonicalEqual } from "./canonical-json";

export const FROZEN_GATE_ENVIRONMENT = Object.freeze([
  "GIT_CONFIG_NOSYSTEM=1",
  "GIT_CONFIG_GLOBAL=/dev/null",
  "GIT_OPTIONAL_LOCKS=0",
  "LC_ALL=C"
] as const);

export const COMMAND_PROFILE_V1 = Object.freeze([
  {
    "id": "GATE-BASE",
    "ordinal": 1,
    "stages": [
      {
        "argv": [
          "sh",
          "-c",
          "test \"$(git merge-base a24b106d2766eadcff73da4c238639f520e5a80b HEAD)\" = a24b106d2766eadcff73da4c238639f520e5a80b && git merge-base --is-ancestor a24b106d2766eadcff73da4c238639f520e5a80b HEAD"
        ],
        "tool": "git",
        "version": "2.49.0",
        "environment": [
          "GIT_CONFIG_NOSYSTEM=1",
          "GIT_CONFIG_GLOBAL=/dev/null",
          "GIT_OPTIONAL_LOCKS=0",
          "LC_ALL=C"
        ]
      }
    ]
  },
  {
    "id": "GATE-SOURCE-INPUT",
    "ordinal": 2,
    "stages": [
      {
        "argv": [
          "spikes/git-status-capability/verify.sh",
          "source-input-digest",
          "--version",
          "1",
          "--source-sha",
          "<SOURCE_SHA>",
          "--manifest",
          "spikes/git-status-capability/contracts/source-input-v1.paths",
          "--primary",
          "source-input-primary-v1",
          "--witness",
          "source-input-witness-v1",
          "--verify-record",
          "<EXTERNAL_EVIDENCE_ROOT>/source-input-record.json",
          "--no-write"
        ],
        "tool": "repository-script",
        "version": "1",
        "environment": [
          "GIT_CONFIG_NOSYSTEM=1",
          "GIT_CONFIG_GLOBAL=/dev/null",
          "GIT_OPTIONAL_LOCKS=0",
          "LC_ALL=C"
        ]
      }
    ]
  },
  {
    "id": "GATE-INSTALL",
    "ordinal": 3,
    "stages": [
      {
        "argv": [
          "npx",
          "--yes",
          "bun@1.2.19",
          "install",
          "--frozen-lockfile"
        ],
        "tool": "bun",
        "version": "1.2.19",
        "environment": [
          "GIT_CONFIG_NOSYSTEM=1",
          "GIT_CONFIG_GLOBAL=/dev/null",
          "GIT_OPTIONAL_LOCKS=0",
          "LC_ALL=C"
        ]
      }
    ]
  },
  {
    "id": "GATE-CHECK",
    "ordinal": 4,
    "stages": [
      {
        "argv": [
          "npx",
          "--yes",
          "bun@1.2.19",
          "run",
          "check"
        ],
        "tool": "bun",
        "version": "1.2.19",
        "environment": [
          "GIT_CONFIG_NOSYSTEM=1",
          "GIT_CONFIG_GLOBAL=/dev/null",
          "GIT_OPTIONAL_LOCKS=0",
          "LC_ALL=C"
        ]
      }
    ]
  },
  {
    "id": "GATE-SCHEMA",
    "ordinal": 5,
    "stages": [
      {
        "argv": [
          "npx",
          "--yes",
          "bun@1.2.19",
          "run",
          "schema:check"
        ],
        "tool": "bun",
        "version": "1.2.19",
        "environment": [
          "GIT_CONFIG_NOSYSTEM=1",
          "GIT_CONFIG_GLOBAL=/dev/null",
          "GIT_OPTIONAL_LOCKS=0",
          "LC_ALL=C"
        ]
      }
    ]
  },
  {
    "id": "GATE-PERF",
    "ordinal": 6,
    "stages": [
      {
        "argv": [
          "npx",
          "--yes",
          "bun@1.2.19",
          "run",
          "test:perf:api"
        ],
        "tool": "bun",
        "version": "1.2.19",
        "environment": [
          "GIT_CONFIG_NOSYSTEM=1",
          "GIT_CONFIG_GLOBAL=/dev/null",
          "GIT_OPTIONAL_LOCKS=0",
          "LC_ALL=C"
        ]
      }
    ]
  },
  {
    "id": "GATE-DOCS-SELF",
    "ordinal": 7,
    "stages": [
      {
        "argv": [
          "scripts/docs/self_test.sh"
        ],
        "tool": "repository-script",
        "version": "1",
        "environment": [
          "GIT_CONFIG_NOSYSTEM=1",
          "GIT_CONFIG_GLOBAL=/dev/null",
          "GIT_OPTIONAL_LOCKS=0",
          "LC_ALL=C"
        ]
      }
    ]
  },
  {
    "id": "GATE-DOCS-LINKS",
    "ordinal": 8,
    "stages": [
      {
        "argv": [
          "scripts/docs/check_links.sh"
        ],
        "tool": "repository-script",
        "version": "1",
        "environment": [
          "GIT_CONFIG_NOSYSTEM=1",
          "GIT_CONFIG_GLOBAL=/dev/null",
          "GIT_OPTIONAL_LOCKS=0",
          "LC_ALL=C"
        ]
      }
    ]
  },
  {
    "id": "GATE-OPENSPEC-STATUS",
    "ordinal": 9,
    "stages": [
      {
        "argv": [
          "npx",
          "--yes",
          "@fission-ai/openspec@1.3.1",
          "status",
          "--change",
          "m2-capability-observer-spike"
        ],
        "tool": "openspec",
        "version": "1.3.1",
        "environment": [
          "GIT_CONFIG_NOSYSTEM=1",
          "GIT_CONFIG_GLOBAL=/dev/null",
          "GIT_OPTIONAL_LOCKS=0",
          "LC_ALL=C"
        ]
      }
    ]
  },
  {
    "id": "GATE-OPENSPEC",
    "ordinal": 10,
    "stages": [
      {
        "argv": [
          "npx",
          "--yes",
          "@fission-ai/openspec@1.3.1",
          "validate",
          "m2-capability-observer-spike",
          "--strict",
          "--no-interactive"
        ],
        "tool": "openspec",
        "version": "1.3.1",
        "environment": [
          "GIT_CONFIG_NOSYSTEM=1",
          "GIT_CONFIG_GLOBAL=/dev/null",
          "GIT_OPTIONAL_LOCKS=0",
          "LC_ALL=C"
        ]
      }
    ]
  },
  {
    "id": "GATE-DIFF-CHECK",
    "ordinal": 11,
    "stages": [
      {
        "argv": [
          "git",
          "diff",
          "--check",
          "a24b106d2766eadcff73da4c238639f520e5a80b...HEAD"
        ],
        "tool": "git",
        "version": "2.49.0",
        "environment": [
          "GIT_CONFIG_NOSYSTEM=1",
          "GIT_CONFIG_GLOBAL=/dev/null",
          "GIT_OPTIONAL_LOCKS=0",
          "LC_ALL=C"
        ]
      }
    ]
  },
  {
    "id": "GATE-SCOPE",
    "ordinal": 12,
    "stages": [
      {
        "argv": [
          "spikes/git-status-capability/verify.sh",
          "repository-scope",
          "--base",
          "a24b106d2766eadcff73da4c238639f520e5a80b"
        ],
        "tool": "repository-script",
        "version": "1",
        "environment": [
          "GIT_CONFIG_NOSYSTEM=1",
          "GIT_CONFIG_GLOBAL=/dev/null",
          "GIT_OPTIONAL_LOCKS=0",
          "LC_ALL=C"
        ]
      }
    ]
  },
  {
    "id": "GATE-UNTRACKED",
    "ordinal": 13,
    "stages": [
      {
        "argv": [
          "git",
          "status",
          "--porcelain=v1",
          "--untracked-files=all"
        ],
        "tool": "git",
        "version": "2.49.0",
        "environment": [
          "GIT_CONFIG_NOSYSTEM=1",
          "GIT_CONFIG_GLOBAL=/dev/null",
          "GIT_OPTIONAL_LOCKS=0",
          "LC_ALL=C"
        ]
      },
      {
        "argv": [
          "spikes/git-status-capability/verify.sh",
          "untracked-inventory"
        ],
        "tool": "repository-script",
        "version": "1",
        "environment": [
          "GIT_CONFIG_NOSYSTEM=1",
          "GIT_CONFIG_GLOBAL=/dev/null",
          "GIT_OPTIONAL_LOCKS=0",
          "LC_ALL=C"
        ]
      }
    ]
  },
  {
    "id": "GATE-PRODUCTION",
    "ordinal": 14,
    "stages": [
      {
        "argv": [
          "spikes/git-status-capability/verify.sh",
          "production-isolation",
          "--base",
          "a24b106d2766eadcff73da4c238639f520e5a80b"
        ],
        "tool": "repository-script",
        "version": "1",
        "environment": [
          "GIT_CONFIG_NOSYSTEM=1",
          "GIT_CONFIG_GLOBAL=/dev/null",
          "GIT_OPTIONAL_LOCKS=0",
          "LC_ALL=C"
        ]
      }
    ]
  },
  {
    "id": "GATE-GOVERNANCE",
    "ordinal": 15,
    "stages": [
      {
        "argv": [
          "spikes/git-status-capability/verify.sh",
          "governance-handoff",
          "--repo",
          "DankerMu/SHUD-Harness",
          "--issue",
          "132",
          "--require-open",
          "--recovery-state",
          "blocked",
          "--pr",
          "133",
          "--reverted-merge",
          "7d74a56eff27e34099961bdf14a40678c88d2603",
          "--require-main-revert",
          "2bf3ef8859278dd0817100c01775765612170648",
          "--read-only"
        ],
        "tool": "repository-script",
        "version": "1",
        "environment": [
          "GIT_CONFIG_NOSYSTEM=1",
          "GIT_CONFIG_GLOBAL=/dev/null",
          "GIT_OPTIONAL_LOCKS=0",
          "LC_ALL=C"
        ]
      }
    ]
  },
  {
    "id": "GATE-SUBMODULE-DIFF",
    "ordinal": 16,
    "stages": [
      {
        "argv": [
          "git",
          "diff",
          "--exit-code",
          "a24b106d2766eadcff73da4c238639f520e5a80b...HEAD",
          "--",
          "SHUD",
          "rSHUD",
          "AutoSHUD",
          "zero"
        ],
        "tool": "git",
        "version": "2.49.0",
        "environment": [
          "GIT_CONFIG_NOSYSTEM=1",
          "GIT_CONFIG_GLOBAL=/dev/null",
          "GIT_OPTIONAL_LOCKS=0",
          "LC_ALL=C"
        ]
      }
    ]
  },
  {
    "id": "GATE-SUBMODULE-PINS",
    "ordinal": 17,
    "stages": [
      {
        "argv": [
          "spikes/git-status-capability/verify.sh",
          "submodules",
          "--expect",
          "SHUD=3aec65755926c478e13ca7d4fea80715e4e90345",
          "--expect",
          "rSHUD=2b7742e32ea323a57fd0a947dc2cea67bfd0afd1",
          "--expect",
          "AutoSHUD=f421445340f70b8cb160ce58cefb066751628593",
          "--expect",
          "zero=13e25c116c62411e6ee8a0ad67a6c53dc7c376c6"
        ],
        "tool": "repository-script",
        "version": "1",
        "environment": [
          "GIT_CONFIG_NOSYSTEM=1",
          "GIT_CONFIG_GLOBAL=/dev/null",
          "GIT_OPTIONAL_LOCKS=0",
          "LC_ALL=C"
        ]
      }
    ]
  }
] as const);

export function validateCommandProfile(value: unknown): boolean {
  return canonicalEqual(value, COMMAND_PROFILE_V1);
}
