import { describe, expect, test } from "vitest";
import { BuildIdSchema, StackIdSchema, StackLockSchema, type StackLock } from "../schemas/index.ts";
import { computeStackFingerprint } from "./fingerprint.ts";

describe("computeStackFingerprint", () => {
  test("returns sha256: followed by 64 lowercase hex digits", () => {
    expect(computeStackFingerprint(baseLock())).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  test("a clean to dirty flip on one repository changes the fingerprint", () => {
    const clean = baseLock();
    const dirty = baseLock();
    dirty.repos.rSHUD.dirty = true;
    dirty.repos.rSHUD.dirty_paths = ["model.txt"];

    expect(computeStackFingerprint(dirty)).not.toBe(computeStackFingerprint(clean));
  });

  test("stack_id, created_at and fingerprint values do not affect the fingerprint", () => {
    const reference = computeStackFingerprint(baseLock());

    expect(
      computeStackFingerprint({
        ...baseLock(),
        stack_id: StackIdSchema.parse("STACK-20261028T090000-abcd"),
      }),
    ).toBe(reference);
    expect(computeStackFingerprint({ ...baseLock(), created_at: "2030-01-01T00:00:00Z" })).toBe(
      reference,
    );
    expect(computeStackFingerprint({ ...baseLock(), fingerprint: "sha256:stale" })).toBe(reference);
    const withoutFingerprint: Omit<StackLock, "fingerprint"> & { fingerprint?: string } =
      baseLock();
    delete withoutFingerprint.fingerprint;
    expect(computeStackFingerprint(withoutFingerprint)).toBe(reference);
  });

  test("key order at every nesting level does not affect the fingerprint", () => {
    const build_id = BuildIdSchema.parse("BUILD-20261102T080000-3f9c");
    const lock = { ...baseLock(), build_id };
    const reordered: StackLock = {
      created_at: lock.created_at,
      fingerprint: lock.fingerprint,
      build_id: lock.build_id,
      llm: {
        response_model: lock.llm.response_model,
        request_alias: lock.llm.request_alias,
        base_url: lock.llm.base_url,
      },
      harness: {
        version: lock.harness.version,
      },
      runtime: {
        sundials_version: lock.runtime.sundials_version,
        host_version: lock.runtime.host_version,
        os: lock.runtime.os,
      },
      repos: {
        rSHUD: {
          dirty_paths_truncated: false,
          dirty_paths: [],
          dirty: false,
          commit: lock.repos.rSHUD.commit,
          branch: "master",
        },
        AutoSHUD: {
          dirty_paths_truncated: false,
          dirty_paths: [],
          dirty: false,
          commit: lock.repos.AutoSHUD.commit,
          branch: "master",
        },
        SHUD: {
          dirty_paths_truncated: false,
          dirty_paths: [],
          dirty: false,
          commit: lock.repos.SHUD.commit,
          branch: "master",
        },
      },
      stack_id: lock.stack_id,
    };

    expect(computeStackFingerprint(reordered)).toBe(computeStackFingerprint(lock));
  });

  test("a missing and an installed SUNDIALS version produce different fingerprints", () => {
    const installed = baseLock();
    const absent = baseLock();
    absent.runtime.sundials_version = null;

    expect(computeStackFingerprint(absent)).not.toBe(computeStackFingerprint(installed));
  });

  test("response_model does not affect the fingerprint", () => {
    const reference = baseLock();
    const changed = baseLock();
    changed.llm.response_model = "another-response-model";
    expect(computeStackFingerprint(changed)).toBe(computeStackFingerprint(reference));
  });

  test("different dirty paths change the fingerprint even while both locks are dirty", () => {
    const first = baseLock();
    const second = baseLock();
    first.repos.SHUD = { ...first.repos.SHUD, dirty: true, dirty_paths: ["a.txt"] };
    second.repos.SHUD = { ...second.repos.SHUD, dirty: true, dirty_paths: ["b.txt"] };
    expect(computeStackFingerprint(first)).not.toBe(computeStackFingerprint(second));
    second.repos.SHUD = { ...first.repos.SHUD, dirty_paths_truncated: true };
    expect(computeStackFingerprint(first)).not.toBe(computeStackFingerprint(second));
  });

  test.each(["base_url", "request_alias"] as const)(
    "%s remains part of the fingerprint",
    (field) => {
      const reference = baseLock();
      const changed = baseLock();
      changed.llm[field] = "changed-value";
      expect(computeStackFingerprint(changed)).not.toBe(computeStackFingerprint(reference));
    },
  );

  test("a null and a missing build reference both preserve the M3 fixed vector", () => {
    const lock = baseLock();
    const { build_id, ...legacyLock } = lock;
    expect(build_id).toBeNull();
    expect(legacyLock).not.toHaveProperty("build_id");
    expect(computeStackFingerprint(legacyLock)).toBe(
      "sha256:974a68b60908c59c718e3e4e84a9a7f5af2e079337bc0450be529f06fbb64948",
    );
    expect(computeStackFingerprint(lock)).toBe(
      "sha256:974a68b60908c59c718e3e4e84a9a7f5af2e079337bc0450be529f06fbb64948",
    );
  });

  test("a build reference changes the fingerprint from null and from another build", () => {
    const withoutBuild = baseLock();
    const first = {
      ...withoutBuild,
      build_id: BuildIdSchema.parse("BUILD-20261102T080000-3f9c"),
    };
    const second = {
      ...withoutBuild,
      build_id: BuildIdSchema.parse("BUILD-20261102T080000-3f9d"),
    };
    expect(computeStackFingerprint(first)).not.toBe(computeStackFingerprint(withoutBuild));
    expect(computeStackFingerprint(second)).not.toBe(computeStackFingerprint(first));
  });

  test("matches an independently computed fixed vector", () => {
    // Independently hashed with `shasum -a 256`; canonical UTF-8 bytes have no trailing newline.
    // Exclusions: stack_id, created_at, fingerprint and llm.response_model.
    // {"harness":{"version":"0.8.0"},"llm":{"base_url":"https://models.example/v1","request_alias":"deepseek-flash-guan"},"repos":{"AutoSHUD":{"branch":"master","commit":"1cbec6f1cbec6f1cbec6f1cbec6f1cbec6f1cbe","dirty":false,"dirty_paths":[],"dirty_paths_truncated":false},"SHUD":{"branch":"master","commit":"9b55b0cb9b55b0cb9b55b0cb9b55b0cb9b55b0cb","dirty":false,"dirty_paths":[],"dirty_paths_truncated":false},"rSHUD":{"branch":"master","commit":"d162db3d162db3d162db3d162db3d162db3d162d","dirty":false,"dirty_paths":[],"dirty_paths_truncated":false}},"runtime":{"host_version":"0.2.1-rc.2","os":"Darwin 24.6.0","sundials_version":"6.0.0"}}
    expect(StackLockSchema.parse(baseLock())).toEqual(baseLock());
    expect(computeStackFingerprint(baseLock())).toBe(
      "sha256:974a68b60908c59c718e3e4e84a9a7f5af2e079337bc0450be529f06fbb64948",
    );
  });

  test("matches an independently computed fixed vector with a build reference", () => {
    // Independently hashed with `shasum -a 256`; the M3 canonical bytes above gain only
    // the leading property "build_id":"BUILD-20261102T080000-3f9c", with no trailing newline.
    const lock = {
      ...baseLock(),
      build_id: BuildIdSchema.parse("BUILD-20261102T080000-3f9c"),
    };
    expect(StackLockSchema.parse(lock)).toEqual(lock);
    expect(computeStackFingerprint(lock)).toBe(
      "sha256:b0dfc39447ff3685933c7db596191d9202b9e3c4ea8f86c5515b9d3e25d5bc19",
    );
  });
});

function baseLock(): StackLock {
  return {
    stack_id: StackIdSchema.parse("STACK-20261027T080000-3f9a"),
    build_id: null,
    repos: {
      SHUD: {
        commit: "9b55b0cb9b55b0cb9b55b0cb9b55b0cb9b55b0cb",
        branch: "master",
        dirty: false,
        dirty_paths: [],
        dirty_paths_truncated: false,
      },
      rSHUD: {
        commit: "d162db3d162db3d162db3d162db3d162db3d162d",
        branch: "master",
        dirty: false,
        dirty_paths: [],
        dirty_paths_truncated: false,
      },
      AutoSHUD: {
        commit: "1cbec6f1cbec6f1cbec6f1cbec6f1cbec6f1cbe",
        branch: "master",
        dirty: false,
        dirty_paths: [],
        dirty_paths_truncated: false,
      },
    },
    runtime: {
      os: "Darwin 24.6.0",
      sundials_version: "6.0.0",
      host_version: "0.2.1-rc.2",
    },
    harness: {
      version: "0.8.0",
    },
    llm: {
      base_url: "https://models.example/v1",
      request_alias: "deepseek-flash-guan",
      response_model: "deepseek-flash-guan",
    },
    fingerprint: "sha256:stack-fingerprint",
    created_at: "2026-07-23T12:00:00Z",
  };
}
