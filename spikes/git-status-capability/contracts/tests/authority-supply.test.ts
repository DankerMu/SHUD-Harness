import { describe, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectMutationRejected, expectSchemaFailure, expectSuccess, invoke, invokeAuthority, repositoryRoot, withJson } from "./authority-test-helpers";

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
    const root = await mkdtemp(join(tmpdir(), "shud-supply-digest-"));
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
});
