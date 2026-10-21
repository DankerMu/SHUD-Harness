import { describe, expect, test } from "vitest";
import type { StackLock } from "../schemas/index.ts";
import { computeStackFingerprint } from "./fingerprint.ts";

describe("computeStackFingerprint", () => {
  test("returns sha256: followed by 64 lowercase hex digits", () => {
    expect(computeStackFingerprint(baseLock())).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  test("a clean to dirty flip on one repository changes the fingerprint", () => {
    const clean = baseLock();
    const dirty = baseLock();
    dirty.repos.rSHUD.dirty = true;

    expect(computeStackFingerprint(dirty)).not.toBe(computeStackFingerprint(clean));
  });

  test("stack_id, created_at and fingerprint values do not affect the fingerprint", () => {
    const reference = computeStackFingerprint(baseLock());

    expect(
      computeStackFingerprint({
        ...baseLock(),
        stack_id: "STACK-99999999-9999-4999-8999-999999999999",
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
    const lock = baseLock();
    const reordered: StackLock = {
      created_at: lock.created_at,
      fingerprint: lock.fingerprint,
      llm: {
        prompt_pack_digest: lock.llm.prompt_pack_digest,
        provider: lock.llm.provider,
        params_digest: lock.llm.params_digest,
        model_id: lock.llm.model_id,
        base_url: lock.llm.base_url,
      },
      harness: {
        version: lock.harness.version,
        skills_version: lock.harness.skills_version,
        prompt_pack: lock.harness.prompt_pack,
        cli_version: lock.harness.cli_version,
      },
      runtime: {
        sundials_version: lock.runtime.sundials_version,
        r_version: lock.runtime.r_version,
        r_packages_lock: { sha256: "sha256:renv-lock", path: "renv.lock" },
        python_version: lock.runtime.python_version,
        os: lock.runtime.os,
        gdal_version: lock.runtime.gdal_version,
        gcc_version: lock.runtime.gcc_version,
      },
      repos: {
        rSHUD: { dirty: false, commit: lock.repos.rSHUD.commit, branch: "master" },
        AutoSHUD: { dirty: false, commit: lock.repos.AutoSHUD.commit, branch: "master" },
        SHUD: { dirty: false, commit: lock.repos.SHUD.commit, branch: "master" },
      },
      stack_id: lock.stack_id,
    };

    expect(computeStackFingerprint(reordered)).toBe(computeStackFingerprint(lock));
  });

  test("a null R package lock and an object R package lock produce different fingerprints", () => {
    const withLock = baseLock();
    const withoutLock = baseLock();
    withoutLock.runtime.r_packages_lock = null;

    expect(computeStackFingerprint(withoutLock)).not.toBe(computeStackFingerprint(withLock));
  });

  test("matches an independently computed fixed vector", () => {
    // Canonical JSON of baseLock() minus stack_id/created_at/fingerprint, keys sorted by UTF-16
    // code unit at every level, no whitespace. Recompute independently with:
    //   printf '%s' '<canonical json>' | shasum -a 256
    // <canonical json>:
    // {"harness":{"cli_version":"unknown","prompt_pack":"promptpack-unset","skills_version":"skills-unset","version":"0.8.0"},"llm":{"base_url":"https://models.example/v1","model_id":"glm-5.2","params_digest":"sha256:params","prompt_pack_digest":"sha256:prompt-pack","provider":"openai_compatible"},"repos":{"AutoSHUD":{"branch":"master","commit":"1cbec6f1cbec6f1cbec6f1cbec6f1cbec6f1cbe","dirty":false},"SHUD":{"branch":"master","commit":"9b55b0cb9b55b0cb9b55b0cb9b55b0cb9b55b0cb","dirty":false},"rSHUD":{"branch":"master","commit":"d162db3d162db3d162db3d162db3d162db3d162d","dirty":false}},"runtime":{"gcc_version":"14.1.0","gdal_version":"3.9.0","os":"Darwin 24.6.0","python_version":"3.12.4","r_packages_lock":{"path":"renv.lock","sha256":"sha256:renv-lock"},"r_version":"4.4.1","sundials_version":"6.0.0"}}
    // This vector also pins the current five-field `llm` shape. When M3 narrows `llm` to the
    // three K4 fields (ADR-0004), recompute this vector: that change is expected, not a regression.
    expect(computeStackFingerprint(baseLock())).toBe(
      "sha256:7183da1b3d90efd8dcf7e2571ed1de140c514be7a84c5baf8b06156850c12ca8",
    );
  });
});

function baseLock(): StackLock {
  return {
    stack_id: "STACK-11111111-1111-4111-8111-111111111111",
    repos: {
      SHUD: {
        commit: "9b55b0cb9b55b0cb9b55b0cb9b55b0cb9b55b0cb",
        branch: "master",
        dirty: false,
      },
      rSHUD: {
        commit: "d162db3d162db3d162db3d162db3d162db3d162d",
        branch: "master",
        dirty: false,
      },
      AutoSHUD: {
        commit: "1cbec6f1cbec6f1cbec6f1cbec6f1cbec6f1cbe",
        branch: "master",
        dirty: false,
      },
    },
    runtime: {
      os: "Darwin 24.6.0",
      r_version: "4.4.1",
      r_packages_lock: { path: "renv.lock", sha256: "sha256:renv-lock" },
      python_version: "3.12.4",
      sundials_version: "6.0.0",
      gcc_version: "14.1.0",
      gdal_version: "3.9.0",
    },
    harness: {
      version: "0.8.0",
      cli_version: "unknown",
      prompt_pack: "promptpack-unset",
      skills_version: "skills-unset",
    },
    llm: {
      provider: "openai_compatible",
      model_id: "glm-5.2",
      base_url: "https://models.example/v1",
      params_digest: "sha256:params",
      prompt_pack_digest: "sha256:prompt-pack",
    },
    fingerprint: "sha256:stack-fingerprint",
    created_at: "2026-07-23T12:00:00Z",
  };
}
