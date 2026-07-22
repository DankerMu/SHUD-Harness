import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import {
  LocalTokenStorageError,
  openWorkspaceLocalTokenAuthority
} from "./local-token-store";
import {
  localTokenRawDirectoryEntryForTest,
  runWithLocalTokenStoreTestContext,
  type LocalTokenInventoryBoundary
} from "./local-token-test-support";
import {
  cleanupLocalTokenTestWorkspace,
  createLocalTokenTestWorkspace,
  createPrivateSecrets,
  interruptLocalTokenStore,
  transactionNames,
  type LocalTokenTestWorkspace
} from "./local-token-test-helpers";
import { LOCAL_TOKEN_MAX_RAW_DIRECTORY_RECORDS } from "./local-token-types";

const ADVERSARIAL_MATRIX_TIMEOUT_MS = 30_000;

function createExternalEntries(workspace: LocalTokenTestWorkspace, count: number): string[] {
  createPrivateSecrets(workspace);
  const names = Array.from(
    { length: count },
    (_, index) => `foreign-${index.toString().padStart(4, "0")}`
  );
  for (const name of names) {
    writeFileSync(join(workspace.secretsRoot, name), "foreign", { mode: 0o600 });
  }
  return names;
}

describe("workspace local-token store inventory bounds", () => {
  const workspaces: LocalTokenTestWorkspace[] = [];

  afterEach(() => {
    for (const workspace of workspaces.splice(0)) {
      cleanupLocalTokenTestWorkspace(workspace);
    }
  });

  test("1024 external entries permit initial publication and identical ordinary restart", () => {
    const workspace = createLocalTokenTestWorkspace();
    workspaces.push(workspace);
    const externalNames = createExternalEntries(workspace, 1024);
    const inventories: Array<{ total?: number; external?: number; owned?: number }> = [];

    const first = runWithLocalTokenStoreTestContext({
      hook: ({ stage, totalEntries, externalEntries, ownedEntries }) => {
        if (stage === "after_inventory") {
          inventories.push({
            total: totalEntries,
            external: externalEntries,
            owned: ownedEntries
          });
        }
      }
    }, () => openWorkspaceLocalTokenAuthority({ workspaceRoot: workspace.workspaceRoot }));
    const second = runWithLocalTokenStoreTestContext({
      hook: ({ stage, totalEntries, externalEntries, ownedEntries }) => {
        if (stage === "after_inventory") {
          inventories.push({
            total: totalEntries,
            external: externalEntries,
            owned: ownedEntries
          });
        }
      }
    }, () => openWorkspaceLocalTokenAuthority({ workspaceRoot: workspace.workspaceRoot }));

    expect(second.token).toBe(first.token);
    expect(inventories).toEqual([
      { total: 1024, external: 1024, owned: 0 },
      { total: 1025, external: 1024, owned: 1 }
    ]);
    const finalNames = readdirSync(workspace.secretsRoot);
    expect(finalNames).toHaveLength(1025);
    expect(finalNames).toContain("local-token");
    expect(finalNames).toContain(externalNames[0]);
    expect(finalNames).toContain(externalNames[1023]);
    expect(transactionNames(workspace.secretsRoot)).toEqual([]);
  });

  test("entry 1025 external fails before publication or destructive work", () => {
    const workspace = createLocalTokenTestWorkspace();
    workspaces.push(workspace);
    const externalNames = createExternalEntries(workspace, 1025);
    let boundary: LocalTokenInventoryBoundary | undefined;

    expect(() => runWithLocalTokenStoreTestContext({
      hook: (input) => {
        if (input.stage === "inventory_rejected") boundary = input.boundary;
      }
    }, () => openWorkspaceLocalTokenAuthority({
      workspaceRoot: workspace.workspaceRoot
    }))).toThrow(LocalTokenStorageError);

    expect(boundary).toBe("external_limit");
    expect(readdirSync(workspace.secretsRoot).sort()).toEqual(externalNames.sort());
    expect(readdirSync(workspace.secretsRoot)).not.toContain("local-token");
  });

  test("eight recognized owned leases are admitted and recovered before publication", () => {
    const workspace = createLocalTokenTestWorkspace();
    workspaces.push(workspace);
    createPrivateSecrets(workspace);
    for (let index = 0; index < 8; index += 1) {
      writeFileSync(
        join(
          workspace.secretsRoot,
          `.local-token-transaction-00000000-0000-4000-8000-${index.toString().padStart(12, "0")}.lease`
        ),
        "",
        { mode: 0o600 }
      );
    }
    let ownedEntries: number | undefined;

    const authority = runWithLocalTokenStoreTestContext({
      hook: (input) => {
        if (input.stage === "after_inventory") ownedEntries = input.ownedEntries;
      }
    }, () => openWorkspaceLocalTokenAuthority({ workspaceRoot: workspace.workspaceRoot }));

    expect(ownedEntries).toBe(8);
    authority.assertCurrent();
    expect(readdirSync(workspace.secretsRoot)).toEqual(["local-token"]);
  });

  test("the exact 1032-entry combined budget recovers before publication", () => {
    const workspace = createLocalTokenTestWorkspace();
    workspaces.push(workspace);
    createExternalEntries(workspace, 1024);
    for (let index = 0; index < 8; index += 1) {
      writeFileSync(
        join(
          workspace.secretsRoot,
          `.local-token-transaction-10000000-0000-4000-8000-${index.toString().padStart(12, "0")}.lease`
        ),
        "",
        { mode: 0o600 }
      );
    }
    let observed: { total?: number; external?: number; owned?: number } = {};

    const authority = runWithLocalTokenStoreTestContext({
      hook: (input) => {
        if (input.stage === "after_inventory") {
          observed = {
            total: input.totalEntries,
            external: input.externalEntries,
            owned: input.ownedEntries
          };
        }
      }
    }, () => openWorkspaceLocalTokenAuthority({ workspaceRoot: workspace.workspaceRoot }));

    expect(observed).toEqual({ total: 1032, external: 1024, owned: 8 });
    authority.assertCurrent();
    expect(readdirSync(workspace.secretsRoot)).toHaveLength(1025);
    expect(transactionNames(workspace.secretsRoot)).toEqual([]);
  });

  test("owned entry nine fails before deleting any recognized artifact", () => {
    const workspace = createLocalTokenTestWorkspace();
    workspaces.push(workspace);
    createPrivateSecrets(workspace);
    const names: string[] = [];
    for (let index = 0; index < 9; index += 1) {
      const name = `.local-token-transaction-00000000-0000-4000-8000-${index.toString().padStart(12, "0")}.lease`;
      names.push(name);
      writeFileSync(join(workspace.secretsRoot, name), "", { mode: 0o600 });
    }
    let boundary: LocalTokenInventoryBoundary | undefined;

    expect(() => runWithLocalTokenStoreTestContext({
      hook: (input) => {
        if (input.stage === "inventory_rejected") boundary = input.boundary;
      }
    }, () => openWorkspaceLocalTokenAuthority({
      workspaceRoot: workspace.workspaceRoot
    }))).toThrow(LocalTokenStorageError);

    expect(boundary).toBe("owned_limit");
    expect(readdirSync(workspace.secretsRoot).sort()).toEqual(names.sort());
  });

  for (const fixture of [
    { name: "staged", killStage: "after_staged_fsync" as const },
    { name: "publishing", killStage: "after_publishing_marker_fsync" as const },
    {
      name: "rolling-back",
      killStage: "after_rollback_move" as const,
      faultStage: "before_post_publish_binding" as const
    }
  ]) {
    test(`1024 external entries remain restartable after ${fixture.name} interruption`, async () => {
      const workspace = createLocalTokenTestWorkspace();
      workspaces.push(workspace);
      createExternalEntries(workspace, 1024);

      await interruptLocalTokenStore(
        workspace.workspaceRoot,
        fixture.killStage,
        fixture.faultStage
      );
      const interruptedNames = readdirSync(workspace.secretsRoot);
      expect(interruptedNames.length).toBeLessThanOrEqual(1032);
      expect(transactionNames(workspace.secretsRoot).length).toBeGreaterThan(0);

      const authority = openWorkspaceLocalTokenAuthority({
        workspaceRoot: workspace.workspaceRoot
      });
      authority.assertCurrent();
      const finalNames = readdirSync(workspace.secretsRoot);
      expect(finalNames).toHaveLength(1025);
      expect(finalNames).toContain("local-token");
      expect(transactionNames(workspace.secretsRoot)).toEqual([]);
    }, ADVERSARIAL_MATRIX_TIMEOUT_MS);
  }

  test("one recovery pass performs exactly one descriptor-relative enumeration", async () => {
    const workspace = createLocalTokenTestWorkspace();
    workspaces.push(workspace);
    await interruptLocalTokenStore(workspace.workspaceRoot, "after_publishing_marker_fsync");
    let inventories = 0;

    const authority = runWithLocalTokenStoreTestContext({
      hook: ({ stage }) => {
        if (stage === "after_inventory") inventories += 1;
      }
    }, () => openWorkspaceLocalTokenAuthority({ workspaceRoot: workspace.workspaceRoot }));

    expect(inventories).toBe(1);
    authority.assertCurrent();
    expect(transactionNames(workspace.secretsRoot)).toEqual([]);
  }, ADVERSARIAL_MATRIX_TIMEOUT_MS);

  test("coverage-only: a real 255-byte UTF-8 name is accepted and counted", () => {
    const workspace = createLocalTokenTestWorkspace();
    workspaces.push(workspace);
    createPrivateSecrets(workspace);
    const name = "n".repeat(255);
    writeFileSync(join(workspace.secretsRoot, name), "foreign", { mode: 0o600 });
    let maxNameBytes: number | undefined;

    const authority = runWithLocalTokenStoreTestContext({
      hook: (input) => {
        if (input.stage === "after_inventory") maxNameBytes = input.maxNameBytes;
      }
    }, () => openWorkspaceLocalTokenAuthority({ workspaceRoot: workspace.workspaceRoot }));

    expect(maxNameBytes).toBe(255);
    authority.assertCurrent();
    expect(readFileSync(join(workspace.secretsRoot, name), "utf8")).toBe("foreign");
  });

  test("the host filesystem rejects a real 256-byte filename before module publication", () => {
    const workspace = createLocalTokenTestWorkspace();
    workspaces.push(workspace);
    createPrivateSecrets(workspace);
    let code: unknown;
    try {
      writeFileSync(join(workspace.secretsRoot, "n".repeat(256)), "foreign", { mode: 0o600 });
    } catch (error) {
      code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
    }
    expect(code).toBe("ENAMETOOLONG");
    expect(readdirSync(workspace.secretsRoot)).toEqual([]);
  });

  for (const layout of ["darwin", "linux"] as const) {
    test(`${layout} dot filtering is order-independent at 1024 external plus 8 owned`, () => {
      const workspace = createLocalTokenTestWorkspace();
      workspaces.push(workspace);
      const names = createExternalEntries(workspace, 1024);
      for (let index = 0; index < 8; index += 1) {
        const name = `.local-token-transaction-20000000-0000-4000-8000-${index.toString().padStart(12, "0")}.lease`;
        names.push(name);
        writeFileSync(join(workspace.secretsRoot, name), "", { mode: 0o600 });
      }
      const dot = localTokenRawDirectoryEntryForTest(layout, Buffer.from("."));
      const dotDot = localTokenRawDirectoryEntryForTest(layout, Buffer.from(".."));
      const records = names.map((name) =>
        localTokenRawDirectoryEntryForTest(layout, Buffer.from(name, "utf8"))
      );
      records.push(dot, dotDot, dot, dotDot);
      let observed: { total?: number; external?: number; owned?: number; raw?: number } = {};

      const authority = runWithLocalTokenStoreTestContext({
        rawDirectoryReplay: { layout, records },
        hook: (input) => {
          if (input.stage !== "after_inventory") return;
          observed = {
            total: input.totalEntries,
            external: input.externalEntries,
            owned: input.ownedEntries,
            raw: input.rawRecords
          };
        }
      }, () => openWorkspaceLocalTokenAuthority({ workspaceRoot: workspace.workspaceRoot }));

      expect(observed).toEqual({ total: 1032, external: 1024, owned: 8, raw: 1036 });
      authority.assertCurrent();
      expect(transactionNames(workspace.secretsRoot)).toEqual([]);
      expect(readdirSync(workspace.secretsRoot)).toHaveLength(1025);
    });

    test(`${layout} repeated dot records obey a separate fixed raw-work bound`, () => {
      const accepted = createLocalTokenTestWorkspace();
      workspaces.push(accepted);
      createPrivateSecrets(accepted);
      const dot = localTokenRawDirectoryEntryForTest(layout, Buffer.from("."));
      const records = Array.from(
        { length: LOCAL_TOKEN_MAX_RAW_DIRECTORY_RECORDS },
        () => dot
      );
      let rawRecords: number | undefined;

      const authority = runWithLocalTokenStoreTestContext({
        rawDirectoryReplay: { layout, records },
        hook: (input) => {
          if (input.stage === "after_inventory") rawRecords = input.rawRecords;
        }
      }, () => openWorkspaceLocalTokenAuthority({ workspaceRoot: accepted.workspaceRoot }));

      expect(rawRecords).toBe(LOCAL_TOKEN_MAX_RAW_DIRECTORY_RECORDS);
      authority.assertCurrent();

      const rejected = createLocalTokenTestWorkspace();
      workspaces.push(rejected);
      createPrivateSecrets(rejected);
      let boundary: LocalTokenInventoryBoundary | undefined;
      expect(() => runWithLocalTokenStoreTestContext({
        rawDirectoryReplay: { layout, records: [...records, dot] },
        hook: (input) => {
          if (input.stage === "inventory_rejected") boundary = input.boundary;
        }
      }, () => openWorkspaceLocalTokenAuthority({
        workspaceRoot: rejected.workspaceRoot
      }))).toThrow(LocalTokenStorageError);
      expect(boundary).toBe("raw_work_limit");
      expect(readdirSync(rejected.secretsRoot)).toEqual([]);
    });

    test(`coverage-only: ${layout} production decoder rejects duplicate decoded names without residue`, () => {
      const workspace = createLocalTokenTestWorkspace();
      workspaces.push(workspace);
      createPrivateSecrets(workspace);
      writeFileSync(join(workspace.secretsRoot, "sentinel"), "foreign", { mode: 0o600 });
      const duplicate = localTokenRawDirectoryEntryForTest(
        layout,
        Buffer.from("duplicate", "utf8")
      );
      let boundary: LocalTokenInventoryBoundary | undefined;

      expect(() => runWithLocalTokenStoreTestContext({
        rawDirectoryReplay: { layout, records: [duplicate, duplicate] },
        hook: (input) => {
          if (input.stage === "inventory_rejected") boundary = input.boundary;
        }
      }, () => openWorkspaceLocalTokenAuthority({
        workspaceRoot: workspace.workspaceRoot
      }))).toThrow(LocalTokenStorageError);

      expect(boundary).toBe("duplicate_decoded_name");
      expect(readdirSync(workspace.secretsRoot)).toEqual(["sentinel"]);
    });

    test(`coverage-only: ${layout} production decoder rejects invalid UTF-8 without residue`, () => {
      const workspace = createLocalTokenTestWorkspace();
      workspaces.push(workspace);
      createPrivateSecrets(workspace);
      writeFileSync(join(workspace.secretsRoot, "sentinel"), "foreign", { mode: 0o600 });
      const invalid = localTokenRawDirectoryEntryForTest(layout, Buffer.from([0xff]));
      let boundary: LocalTokenInventoryBoundary | undefined;

      expect(() => runWithLocalTokenStoreTestContext({
        rawDirectoryReplay: { layout, records: [invalid] },
        hook: (input) => {
          if (input.stage === "inventory_rejected") boundary = input.boundary;
        }
      }, () => openWorkspaceLocalTokenAuthority({
        workspaceRoot: workspace.workspaceRoot
      }))).toThrow(LocalTokenStorageError);

      expect(boundary).toBe("decode");
      expect(readdirSync(workspace.secretsRoot)).toEqual(["sentinel"]);
    });
  }
});
