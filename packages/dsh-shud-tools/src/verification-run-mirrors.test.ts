import * as fs from "node:fs";
import { DataProvenanceSchema, RunRecordSchema } from "@shud-harness/dsh-shud-core";
import { writeWorkspaceRecord } from "@shud-harness/dsh-shud-records";
import { expect, test, vi } from "vitest";
import {
  fixturePaths,
  OTHER_SHA256,
  putFixture,
  rejectedUnchanged,
  SIDES,
  verificationArgs,
} from "./verification-run/matrix/test-harness.ts";
import { verificationHarness } from "./verification-run/test-harness.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

for (const side of SIDES) {
  test.each(["data_id", "build_id", "threads", "binary_sha256"] as const)(
    `${side} collected RunRecord %s must mirror its indexed RunJob before loading that run's evidence`,
    async (field) => {
      const h = await verificationHarness();
      try {
        const other = h[side === "base" ? "candidate" : "base"];
        const replacement =
          field === "data_id"
            ? other.job.data_id
            : field === "build_id"
              ? other.job.build_id
              : field === "threads"
                ? 2
                : OTHER_SHA256;
        const record = RunRecordSchema.parse({ ...h[side].run, [field]: replacement });
        const paths = fixturePaths(h, side);
        putFixture(paths.run, record);
        // The canonical collector accepts this schema-valid record; verification owns the mirrors.
        expect(await h.registry.listRunJobsByTask(h.card.task_id)).toEqual([
          h.base.job,
          h.candidate.job,
        ]);
        expect(await h.registry.collectShud(h[side].job.run_id, { readonly: true })).toEqual(
          record,
        );
        expect(record[field]).not.toBe(h[side].job[field]);
        vi.mocked(fs.readFileSync).mockClear();

        const message = await rejectedUnchanged(h, verificationArgs(h), new RegExp(field, "u"));
        expect(message).toContain(h[side].job.run_id);
        const reads = vi.mocked(fs.readFileSync).mock.calls.map(([path]) => path);
        expect(reads).not.toContain(paths.build);
        expect(reads).not.toContain(paths.data);
      } finally {
        await h.dispose();
      }
    },
  );
}

test("candidate cannot borrow baseline provenance when its indexed job records different inputs", async () => {
  const h = await verificationHarness();
  try {
    const data = DataProvenanceSchema.parse({
      ...h.candidate.data,
      sources: {
        ...h.candidate.data.sources,
        files: h.candidate.data.sources.files.map((file) => ({ ...file, sha256: OTHER_SHA256 })),
      },
    });
    writeWorkspaceRecord(h.cwd, "data", data);
    const record = RunRecordSchema.parse({ ...h.candidate.run, data_id: h.base.job.data_id });
    const paths = fixturePaths(h, "candidate");
    putFixture(paths.run, record);
    expect(data.sources.files).not.toEqual(h.base.data.sources.files);
    expect(record.data_id).not.toBe(h.candidate.job.data_id);
    expect(await h.registry.listRunJobsByTask(h.card.task_id)).toEqual([
      h.base.job,
      h.candidate.job,
    ]);
    expect(await h.registry.collectShud(h.candidate.job.run_id, { readonly: true })).toEqual(
      record,
    );
    vi.mocked(fs.readFileSync).mockClear();

    await rejectedUnchanged(h, verificationArgs(h), /data_id/u);
    const reads = vi.mocked(fs.readFileSync).mock.calls.map(([path]) => path);
    expect(reads).not.toContain(paths.build);
    expect(reads).not.toContain(paths.data);
  } finally {
    await h.dispose();
  }
});
