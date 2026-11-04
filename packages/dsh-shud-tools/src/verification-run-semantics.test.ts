import * as fs from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { DataProvenanceSchema, VerificationIdSchema } from "@shud-harness/dsh-shud-core";
import { readWorkspaceRecord, writeWorkspaceRecord } from "@shud-harness/dsh-shud-records";
import { fileSnapshot, resultValue } from "./report-workflow/test-harness.ts";
import { OTHER_SHA256, rejectedUnchanged, SIDES } from "./verification-run/matrix/test-harness.ts";
import {
  OUTPUT_SHA256,
  PRIOR_VERIFICATION,
  verificationHarness,
} from "./verification-run/test-harness.ts";

test("provenance compares pair sets across both collections without order, duplicate or metadata dependence", async () => {
  const h = await verificationHarness();
  try {
    const internal = [
      { path: "tiny.cfg.para", sha256: OUTPUT_SHA256, size_bytes: 3 },
      { path: "tiny.mesh", sha256: OTHER_SHA256, size_bytes: 0 },
    ];
    const external = [
      { path: "/fixture/forcing.dat", sha256: OUTPUT_SHA256, size_bytes: 3 },
      { path: "/fixture/second.dat", sha256: OTHER_SHA256, size_bytes: 0 },
    ];
    for (const side of SIDES) {
      writeWorkspaceRecord(
        h.cwd,
        "data",
        DataProvenanceSchema.parse({
          ...h[side].data,
          basin: side === "base" ? "tiny" : "independent metadata",
          sources: {
            input_root: h[side].data.sources.input_root,
            files:
              side === "base"
                ? internal
                : [...internal]
                    .reverse()
                    .concat(internal)
                    .map((file) => ({ ...file, size_bytes: 99 })),
            external_files:
              side === "base"
                ? external
                : [...external]
                    .reverse()
                    .concat(external)
                    .map((file) => ({ ...file, size_bytes: 98 })),
          },
        }),
      );
    }
    const before = await h.evidenceSnapshot();
    const value = resultValue(await h.invoke());
    expect(value.status).toBe("passed");
    expect(await h.evidenceSnapshot()).toEqual(before);
  } finally {
    await h.dispose();
  }
});

test.each(["files", "external_files"] as const)(
  "%s pair identity does not collapse distinct digests sharing one path",
  async (collection) => {
    const h = await verificationHarness();
    try {
      const original = h.base.data.sources[collection][0];
      const distinct = { ...original, sha256: OTHER_SHA256 };
      writeWorkspaceRecord(
        h.cwd,
        "data",
        DataProvenanceSchema.parse({
          ...h.base.data,
          sources: { ...h.base.data.sources, [collection]: [distinct, original] },
        }),
      );
      // A path-only map would keep the shared last entry and incorrectly accept these inputs.
      await rejectedUnchanged(h);
    } finally {
      await h.dispose();
    }
  },
);

test.each(["files", "external_files"] as const)(
  "%s paths are compared verbatim rather than normalized",
  async (collection) => {
    const h = await verificationHarness();
    try {
      const original = h.candidate.data.sources[collection][0];
      const path = collection === "files" ? "./tiny.cfg.para" : "/fixture/./forcing.dat";
      writeWorkspaceRecord(
        h.cwd,
        "data",
        DataProvenanceSchema.parse({
          ...h.candidate.data,
          sources: { ...h.candidate.data.sources, [collection]: [{ ...original, path }] },
        }),
      );
      await rejectedUnchanged(h);
    } finally {
      await h.dispose();
    }
  },
);

test("repeated run pairs create distinct immutable cases and sorted deduplicated links", async () => {
  const h = await verificationHarness();
  try {
    const later = VerificationIdSchema.parse("VC-20990101T000000-ffff");
    writeWorkspaceRecord(h.cwd, "task", {
      ...h.card,
      linked_verifications: [later, PRIOR_VERIFICATION, later],
    });
    const evidence = await h.evidenceSnapshot();
    const first = VerificationIdSchema.parse(resultValue(await h.invoke()).vc_id);
    const path = join(h.cwd, "verifications", `${first}.json`);
    const before = await fileSnapshot(path);
    const second = VerificationIdSchema.parse(resultValue(await h.invoke()).vc_id);
    expect(first).not.toBe(second);
    expect(await fileSnapshot(path)).toEqual(before);
    const card = readWorkspaceRecord(h.cwd, "task", h.card.task_id, { readonly: true });
    expect(card).toEqual({
      ...h.card,
      linked_verifications: [PRIOR_VERIFICATION, later, first, second].sort(),
      updated_at: card.updated_at,
    });
    expect(fs.readdirSync(join(h.cwd, "verifications")).sort()).toEqual(
      [`${first}.json`, `${second}.json`].sort(),
    );
    expect(await h.evidenceSnapshot()).toEqual(evidence);
  } finally {
    await h.dispose();
  }
});

test("a physical session alias preserves relative artifact identity", async () => {
  const h = await verificationHarness();
  try {
    const alias = join(h.root, "session-alias");
    fs.symlinkSync(h.cwd, alias);
    Object.assign(h.agent.session.header, { cwd: alias });
    const value = resultValue(await h.invoke());
    const record = readWorkspaceRecord(
      h.cwd,
      "verification",
      VerificationIdSchema.parse(value.vc_id),
      { readonly: true },
    );
    expect(record.artifact_refs).toEqual([
      "runs/RUN-20261022T031500-1001/output/tiny.out/tiny.rivqdown.dat",
      "runs/RUN-20261022T031500-1002/output/tiny.out/tiny.rivqdown.dat",
    ]);
  } finally {
    await h.dispose();
  }
});
