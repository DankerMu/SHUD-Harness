import { createHash } from "node:crypto";
import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { DataProvenanceSchema, type RunJob } from "@shud-harness/dsh-shud-core";
import { ShudJobRegistry } from "./index.ts";
import {
  actualRegistry,
  submissionFixture,
  submissionProducer,
} from "./submit-shud/test-harness.ts";
import { buildFixture } from "./submit-shud-build/test-harness.ts";
import { settlingProducer } from "./poll-shud/test-harness.ts";

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const ccw = fileURLToPath(new URL("../../../SHUD/input/ccw/", import.meta.url));

/** The persisted provenance must hash the rewritten copy, i.e. exactly what SHUD reads. */
async function expectSubmittedCfg(cwd: string, record: RunJob, expected: Buffer) {
  const name = `${record.project}.cfg.para`;
  expect(await readFile(join(record.run_dir, "input", record.project, name))).toEqual(expected);
  const data = DataProvenanceSchema.parse(
    JSON.parse(await readFile(join(cwd, "provenance", `${record.data_id}.json`), "utf8")),
  );
  expect(data.sources.files.find((file) => file.path === name)).toEqual({
    path: name,
    sha256: sha256(expected),
    size_bytes: expected.length,
  });
}

test.each([
  [
    "existing CRLF line rewritten in place beside a comment",
    "# DT_YE_IC 60\r\nSTART\t0\r\ndt_ye_ic  0\r\nEND\t7\r\n",
    "# DT_YE_IC 60\r\nSTART\t0\r\ndt_ye_ic  1440\r\nEND\t7\r\n",
  ],
  [
    "every effective line rewritten",
    "DT_YE_IC 60\nEND\t7\n\tdt_ye_ic\t0 # keep\n",
    "DT_YE_IC 1440\nEND\t7\n\tdt_ye_ic\t1440 # keep\n",
  ],
  [
    "absent line appended after the file's first CRLF ending",
    "START\t0\r\nEND\t7",
    "START\t0\r\nEND\t7\r\nDT_YE_IC\t1440\r\n",
  ],
  [
    "absent line appended with LF when the file has no ending",
    "END\t7",
    "END\t7\nDT_YE_IC\t1440\n",
  ],
])(
  "submission without end_days writes DT_YE_IC before provenance: %s",
  async (_name, parameter, expected) => {
    const h = await submissionFixture(parameter);
    const execution = submissionProducer();
    try {
      await h.apply(ShudJobRegistry, h.config);
      const record = await actualRegistry(h.ctx).submitShud(h.request, execution.start);
      expect(record).toMatchObject({ status: "running", end_days: null });
      await expectSubmittedCfg(h.cwd, record, Buffer.from(expected));
      for (const [name, bytes] of Object.entries(h.originals))
        expect(await readFile(join(h.inputDir, name))).toEqual(bytes);
      // input_bytes keeps its meaning: bytes copied before any rewrite.
      expect(record.input_bytes).toBe(
        Object.values(h.originals).reduce((sum, bytes) => sum + bytes.length, 0),
      );
    } finally {
      await execution.finish();
      await h.dispose();
    }
  },
);

test("ccw with end_days 30 patches END and appends DT_YE_IC to the copy only", async () => {
  const h = await submissionFixture();
  const execution = submissionProducer();
  try {
    const source = await readFile(join(ccw, "ccw.cfg.para"));
    const input = join(h.root, "ccw");
    await cp(ccw, input, { recursive: true });
    await h.apply(ShudJobRegistry, h.config);
    const record = await actualRegistry(h.ctx).submitShud(
      { ...h.request, input_dir: input, project: "ccw", end_days: 30 },
      execution.start,
    );
    expect(record.status).toBe("running");
    const text = source.toString("latin1");
    expect(text).toContain("\nEND 1827\n");
    expect(text).not.toMatch(/dt_ye_ic/iu);
    await expectSubmittedCfg(
      h.cwd,
      record,
      Buffer.from(`${text.replace("\nEND 1827\n", "\nEND 30\n")}DT_YE_IC\t1440\n`, "latin1"),
    );
    expect(await readFile(join(input, "ccw.cfg.para"))).toEqual(source);
    expect(await readFile(join(ccw, "ccw.cfg.para"))).toEqual(source);
    expect(JSON.parse(await readFile(join(record.run_dir, "run-job.json"), "utf8"))).toMatchObject({
      status: "running",
    });
  } finally {
    await execution.finish();
    await h.dispose();
  }
});

test("build_id and threads submissions get DT_YE_IC without touching NUM_OPENMP, START or END", async () => {
  const h = await buildFixture();
  const execution = settlingProducer();
  try {
    const parameter = "START\t0\nEND\t7\nNUM_OPENMP\t8\n";
    await writeFile(join(h.inputDir, "tiny.cfg.para"), parameter);
    await h.apply(ShudJobRegistry, h.config);
    const record = await actualRegistry(h.ctx).submitShud(
      { ...h.buildRequest, threads: 2 },
      execution.start,
    );
    expect(record).toMatchObject({ status: "running", threads: 2, build_id: h.build.build_id });
    await expectSubmittedCfg(h.cwd, record, Buffer.from(`${parameter}DT_YE_IC\t1440\n`));
    expect(await readFile(join(h.inputDir, "tiny.cfg.para"), "utf8")).toBe(parameter);
  } finally {
    await execution.cleanup();
    await h.dispose();
  }
});
