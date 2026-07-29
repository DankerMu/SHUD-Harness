import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectMutationRejected, expectSchemaFailure, expectSuccess, invoke, invokeAuthority, repositoryRoot, withJson } from "./authority-test-helpers";
import { enumerateSourceCandidates } from "../lib/schema";
import { spawnSync } from "node:child_process";

const manifestRelative = "spikes/git-status-capability/contracts/source-input-v1.paths";

async function temporaryCurrentRepository(): Promise<string> {
  const root = await mkdtemp(join(realpathSync(tmpdir()), "shud-cargo-contract-"));
  const spikeRoot = join(root, "spikes", "git-status-capability");
  await mkdir(join(root, "spikes"), { recursive: true });
  await cp(join(repositoryRoot, "spikes", "git-status-capability"), spikeRoot, { recursive: true });
  await cp(
    join(repositoryRoot, "openspec", "changes", "m2-capability-observer-spike"),
    join(root, "openspec", "changes", "m2-capability-observer-spike"),
    { recursive: true }
  );
  await writeFile(join(root, manifestRelative), `${(await enumerateSourceCandidates(root)).join("\n")}\n`);
  if (spawnSync("git", ["init", "-q"], { cwd: root }).status !== 0 ||
      spawnSync("git", ["add", "spikes/git-status-capability", "openspec/changes/m2-capability-observer-spike"], { cwd: root }).status !== 0) {
    throw new Error("temporary Git repository setup failed");
  }
  return root;
}

async function invokeCurrent(root: string) {
  return invoke(["--repository-root", root, "--manifest", manifestRelative, "--check-current"]);
}

type Setter = (value: any, changed: string) => void;

const lockPeers: Setter[] = [
  (v, x) => { v.platforms.macos.lockfile_digest = x; },
  (v, x) => { v.platforms.linux.lockfile_digest = x; },
  (v, x) => { v.decision.lockfile_digest = x; }
];
const toolchainDigestPeers: Setter[] = [
  (v, x) => { v.platforms.macos.rust_toolchain_digest = x; },
  (v, x) => { v.platforms.linux.rust_toolchain_digest = x; },
  (v, x) => { v.decision.rust_toolchain_digest = x; }
];
const sharedToolPeers: Record<string, Setter[]> = {
  rust_release: [
    (v, x) => { v.platforms.macos.toolchain.rust_release = x; },
    (v, x) => { v.platforms.linux.toolchain.rust_release = x; },
    (v, x) => { v.decision.toolchain.rust_release = x; }
  ],
  rust_commit: [
    (v, x) => { v.platforms.macos.toolchain.rust_commit = x; },
    (v, x) => { v.platforms.linux.toolchain.rust_commit = x; },
    (v, x) => { v.decision.toolchain.rust_commit = x; }
  ],
  cargo_cli_release: [
    (v, x) => { v.platforms.macos.toolchain.cargo_cli_release = x; },
    (v, x) => { v.platforms.linux.toolchain.cargo_cli_release = x; },
    (v, x) => { v.decision.toolchain.cargo_cli_release = x; }
  ],
  cargo_commit: [
    (v, x) => { v.platforms.macos.toolchain.cargo_commit = x; },
    (v, x) => { v.platforms.linux.toolchain.cargo_commit = x; },
    (v, x) => { v.decision.toolchain.cargo_commit = x; }
  ],
  cargo_package_version: [
    (v, x) => { v.platforms.macos.toolchain.cargo_package_version = x; },
    (v, x) => { v.platforms.linux.toolchain.cargo_package_version = x; },
    (v, x) => { v.decision.toolchain.cargo_package_version = x; }
  ],
  git_version: [
    (v, x) => { v.platforms.macos.toolchain.git_version = x; },
    (v, x) => { v.platforms.linux.toolchain.git_version = x; },
    (v, x) => { v.decision.toolchain.git_version = x; }
  ]
};
const platformToolPeers: Record<string, Setter[]> = {
  macos_host: [
    (v, x) => { v.platforms.macos.toolchain.rust_host = x; },
    (v, x) => { v.decision.toolchain.rust_hosts.macos = x; }
  ],
  macos_target: [
    (v, x) => { v.platforms.macos.toolchain.rust_target = x; },
    (v, x) => { v.decision.toolchain.rust_targets.macos = x; }
  ],
  linux_host: [
    (v, x) => { v.platforms.linux.toolchain.rust_host = x; },
    (v, x) => { v.decision.toolchain.rust_hosts.linux = x; }
  ],
  linux_target: [
    (v, x) => { v.platforms.linux.toolchain.rust_target = x; },
    (v, x) => { v.decision.toolchain.rust_targets.linux = x; }
  ]
};

async function rejectEverySubset(setters: Setter[], changed: string): Promise<void> {
  for (let mask = 1; mask < (1 << setters.length); mask += 1) {
    await expectMutationRejected((value) => {
      for (let index = 0; index < setters.length; index += 1) {
        if ((mask & (1 << index)) !== 0) setters[index]!(value, changed);
      }
    });
  }
}

describe("actual and recorded supply authority", () => {
  test("rejects every independent and synchronized lock/toolchain digest forgery", async () => {
    await rejectEverySubset(lockPeers, "a".repeat(64));
    await rejectEverySubset(toolchainDigestPeers, "b".repeat(64));
  });

  test("rejects every independent and synchronized Rust, Cargo, Git, host, and target mutation", async () => {
    for (const setters of Object.values(sharedToolPeers)) await rejectEverySubset(setters, "forged");
    for (const setters of Object.values(platformToolPeers)) await rejectEverySubset(setters, "forged");
  });

  test("computes both checked-in supply digests at the public authority seam", async () => {
    const root = await mkdtemp(join(realpathSync(tmpdir()), "shud-supply-digest-"));
    try {
      const spikeRoot = join(root, "spikes", "git-status-capability");
      await mkdir(join(root, "spikes"), { recursive: true });
      await cp(join(repositoryRoot, "spikes", "git-status-capability"), spikeRoot, { recursive: true });
      for (const path of [join(spikeRoot, "native", "Cargo.lock"), join(spikeRoot, "native", "rust-toolchain.toml")]) {
        const original = await readFile(path, "utf8");
        await writeFile(path, `${original}# parseable drift\n`);
        expectSchemaFailure(await invokeAuthority(undefined, root));
        await writeFile(path, original);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires the frozen supply fields on standalone platform and decision contracts", async () => {
    const registry = JSON.parse(await readFile(join(repositoryRoot, "spikes", "git-status-capability", "contracts", "fixtures", "valid", "generic.json"), "utf8"));
    const linux = structuredClone(registry.platform_bundle);
    linux.platform = "linux";
    linux.target = "x86_64-unknown-linux-gnu";
    linux.toolchain.rust_host = "x86_64-unknown-linux-gnu";
    linux.toolchain.rust_target = "x86_64-unknown-linux-gnu";
    for (const [kind, value] of [["platform_bundle", registry.platform_bundle], ["platform_bundle", linux], ["decision", registry.decision]] as const) {
      await withJson(value, async (path) => expectSuccess(await invoke(["--input", path, "--kind", kind]), kind));
    }
    const mutations = [
      ["platform_bundle", registry.platform_bundle, (value: any) => { delete value.lockfile_digest; }],
      ["platform_bundle", registry.platform_bundle, (value: any) => { value.rust_toolchain_digest = "f".repeat(64); }],
      ["decision", registry.decision, (value: any) => { delete value.base_sha; }],
      ["decision", registry.decision, (value: any) => { value.toolchain.cargo_package_version = "forged"; }]
    ] as const;
    for (const [kind, original, mutate] of mutations) {
      const changed = structuredClone(original);
      mutate(changed);
      await withJson(changed, async (path) => expectSchemaFailure(await invoke(["--input", path, "--kind", kind])));
    }
  });

  test("rejects Cargo comments independently from exact package-field drift", async () => {
    const mutations = [
      (cargo: string) => `${cargo}# comments are not part of the frozen manifest\n`,
      (cargo: string) => cargo.replace('name = "shud-git-status-capability-spike"', 'name = "forged"'),
      (cargo: string) => cargo.replace('version = "0.0.0"', 'version = "0.0.1"'),
      (cargo: string) => cargo.replace('edition = "2024"', 'edition = "2021"'),
      (cargo: string) => cargo.replace('rust-version = "1.88.0"', 'rust-version = "1.89.0"'),
      (cargo: string) => cargo.replace("publish = false", "publish = true")
    ];
    for (const mutate of mutations) {
      const root = await temporaryCurrentRepository();
      try {
        const path = join(root, "spikes", "git-status-capability", "native", "Cargo.toml");
        await writeFile(path, mutate(await readFile(path, "utf8")));
        expectSchemaFailure(await invokeCurrent(root));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  test("structurally rejects extra, missing, feature, default-feature, version, and source drift", async () => {
    const exactLines = {
      cap: 'cap-std = { version = "=4.0.2", default-features = false }',
      index: 'gix-index = { version = "=0.54.0", default-features = false, features = ["sha1"] }',
      status: 'gix-status = { version = "=0.33.0", default-features = false, features = ["sha1", "worktree-rewrites"] }'
    };
    const mutations = [
      (cargo: string) => `${cargo}serde = { version = "=1.0.0", default-features = false }\n`,
      (cargo: string) => cargo.replace(`${exactLines.cap}\n`, ""),
      (cargo: string) => cargo.replace(exactLines.cap, `cap-std = { version = "=4.0.2", default-features = true }`),
      (cargo: string) => cargo.replace(exactLines.cap, `cap-std = { version = "=4.0.3", default-features = false }`),
      (cargo: string) => cargo.replace(exactLines.index, `gix-index = { version = "=0.54.0", default-features = false, features = [] }`),
      (cargo: string) => cargo.replace(exactLines.index, `gix-index = { version = "=0.54.0", default-features = false, features = ["sha1", "serde"] }`),
      (cargo: string) => cargo.replace(exactLines.status, `gix-status = { version = "=0.33.0", default-features = false, features = ["worktree-rewrites", "sha1"] }`),
      (cargo: string) => cargo.replace(exactLines.status, `gix-status = { version = "=0.33.0", default-features = false, features = ["sha1", "worktree-rewrites"], registry = "private" }`),
      (cargo: string) => cargo.replace(exactLines.status, `gix-status = { version = "=0.33.0", default-features = false, features = ["sha1", "worktree-rewrites"], git = "https://example.invalid/repo" }`)
    ];
    for (const mutate of mutations) {
      const root = await temporaryCurrentRepository();
      try {
        const path = join(root, "spikes", "git-status-capability", "native", "Cargo.toml");
        await writeFile(path, mutate(await readFile(path, "utf8")));
        expectSchemaFailure(await invokeCurrent(root));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  test("the public current checker accepts ASCII Cargo spacing and rejects Unicode whitespace or controls with exact receipts", async () => {
    const accepted = await temporaryCurrentRepository();
    try {
      const path = join(accepted, "spikes", "git-status-capability", "native", "Cargo.toml");
      await writeFile(path, (await readFile(path, "utf8")).replace("name =", "name\t=\t"));
      const sourceEntries = (await enumerateSourceCandidates(accepted)).length;
      const result = await invokeCurrent(accepted);
      expect(result).toEqual({
        exit: 0,
        stderr: "",
        stdout: `{"schema_version":"shud.git-status-capability.contract-check-receipt.v1","status":"ok","catalog_rows":174,"floor_mappings":25,"fixture_owners":174,"native_owners":174,"source_entries":${sourceEntries},"rust_version":"1.88.0","git_oracle_version":"2.49.0"}\n`
      });
    } finally {
      await rm(accepted, { recursive: true, force: true });
    }

    for (const separator of ["\u00a0", "\u2003", "\u2028", "\u000b", "\u000c"]) {
      const rejected = await temporaryCurrentRepository();
      try {
        const path = join(rejected, "spikes", "git-status-capability", "native", "Cargo.toml");
        await writeFile(path, (await readFile(path, "utf8")).replace("name =", `name${separator}=${separator}`));
        expectSchemaFailure(await invokeCurrent(rejected));
      } finally {
        await rm(rejected, { recursive: true, force: true });
      }
    }
  });
});
