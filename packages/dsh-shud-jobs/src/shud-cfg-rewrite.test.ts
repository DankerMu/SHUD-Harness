import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import {
  ensureOutputInterval,
  ensureOutputIntervalBytes,
  submittedParameterBytes,
  updateEnd,
} from "./shud-cfg-rewrite.ts";
import { createHarness } from "./test-harness.ts";

test("END updates preserve mixed line endings, ignored lines, comments and non-UTF8 bytes", async () => {
  const h = await createHarness();
  const path = join(h.root, "fixture.cfg.para");
  const before = Buffer.from(
    "#\xff comment\r\n END 99\n\0END 88\n\tend\t1e2 # note\r\nEnD +0x1p+3\nOTHER 17",
    "latin1",
  );
  const expected = Buffer.from(
    "#\xff comment\r\n END 99\n\0END 88\n\tend\t30 # note\r\nEnD 30\nOTHER 17",
    "latin1",
  );
  try {
    await writeFile(path, before);
    await updateEnd(path, 30);
    expect(await readFile(path)).toEqual(expected);
  } finally {
    await h.dispose();
  }
});

test.each(["# END 1\n END 2\n", "ENDLESS 1\n", "END\n", "END invalid\n"])(
  "missing effective END leaves the parameter bytes unchanged: %j",
  async (text) => {
    const h = await createHarness();
    const path = join(h.root, "fixture.cfg.para");
    try {
      await writeFile(path, text);
      await expect(updateEnd(path, 30)).rejects.toThrow("No effective END");
      expect(await readFile(path, "utf8")).toBe(text);
    } finally {
      await h.dispose();
    }
  },
);

test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
  "invalid END override %s does not change bytes",
  async (days) => {
    const h = await createHarness();
    const path = join(h.root, "fixture.cfg.para");
    try {
      await writeFile(path, "END 7\n");
      await expect(updateEnd(path, days)).rejects.toThrow("positive integer");
      expect(await readFile(path, "utf8")).toBe("END 7\n");
    } finally {
      await h.dispose();
    }
  },
);

test("leading blank lines do not hide the following effective END", async () => {
  const h = await createHarness();
  const path = join(h.root, "fixture.cfg.para");
  try {
    await writeFile(path, "\nEND 7\nend 8");
    await updateEnd(path, 30);
    expect(await readFile(path, "utf8")).toBe("\nEND 30\nend 30");
  } finally {
    await h.dispose();
  }
});

test("a leading tab permits following spaces before the END key, unlike a leading space", async () => {
  const h = await createHarness();
  const path = join(h.root, "fixture.cfg.para");
  try {
    await writeFile(path, "\t END\t365 # keep\r\n \tEND 999\n");
    await updateEnd(path, 30);
    expect(await readFile(path, "utf8")).toBe("\t END\t30 # keep\r\n \tEND 999\n");
  } finally {
    await h.dispose();
  }
});

const latin1 = (text: string) => Buffer.from(text, "latin1");

test.each([
  [
    "effective lowercase line rewritten in place beside a commented line",
    "# DT_YE_IC 60\r\nSTART\t0\r\ndt_ye_ic  0\r\nEND\t7\r\n",
    "# DT_YE_IC 60\r\nSTART\t0\r\ndt_ye_ic  1440\r\nEND\t7\r\n",
  ],
  [
    "every effective line rewritten, trailing bytes and ignored lines kept",
    "DT_YE_IC 60 # hourly\n\tDt_Ye_Ic\t+1e1\r\n DT_YE_IC 5\n\0DT_YE_IC 5\nDT_YE_IC\t0x10",
    "DT_YE_IC 1440 # hourly\n\tDt_Ye_Ic\t1440\r\n DT_YE_IC 5\n\0DT_YE_IC 5\nDT_YE_IC\t1440",
  ],
  [
    "absent key appended with the first CRLF line ending after a missing final EOL",
    "START\t0\r\nEND\t7\nOTHER 1",
    "START\t0\r\nEND\t7\nOTHER 1\r\nDT_YE_IC\t1440\r\n",
  ],
  [
    "absent key appended with LF when the first line ending is LF",
    "START\t0\nEND\t7\r\n",
    "START\t0\nEND\t7\r\nDT_YE_IC\t1440\n",
  ],
  ["file without any line ending uses LF", "END\t7", "END\t7\nDT_YE_IC\t1440\n"],
  ["empty file receives only the appended line", "", "DT_YE_IC\t1440\n"],
  [
    "commented, space-led, valueless and prefixed keys are not effective",
    "# DT_YE_IC 60\n DT_YE_IC 60\nDT_YE_IC\nDT_YE_IC invalid\nDT_YE_ICX 60\n",
    "# DT_YE_IC 60\n DT_YE_IC 60\nDT_YE_IC\nDT_YE_IC invalid\nDT_YE_ICX 60\nDT_YE_IC\t1440\n",
  ],
  [
    "a trailing lone CR is not a line ending",
    "END\t7\r\nOTHER 1\r",
    "END\t7\r\nOTHER 1\r\r\nDT_YE_IC\t1440\r\n",
  ],
  [
    "latin-1 high bytes and NUL bytes round-trip",
    "#\xff\xe9 comment\nNAME \x80\x00\x81\nDT_YE_IC 1\n",
    "#\xff\xe9 comment\nNAME \x80\x00\x81\nDT_YE_IC 1440\n",
  ],
])("DT_YE_IC transform: %s", (_name, before, expected) => {
  const source = latin1(before);
  const retained = Buffer.from(source);
  expect(ensureOutputIntervalBytes(source, "DT_YE_IC", 1440)).toEqual(latin1(expected));
  expect(submittedParameterBytes(source)).toEqual(latin1(expected));
  expect(source).toEqual(retained);
});

test("the transform is idempotent for an already daily output switch", () => {
  const source = latin1("END 7\r\nDT_YE_IC\t1440\r\n");
  expect(submittedParameterBytes(source)).toEqual(source);
  expect(submittedParameterBytes(submittedParameterBytes(latin1("END 7")))).toEqual(
    latin1("END 7\nDT_YE_IC\t1440\n"),
  );
});

test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
  "invalid output interval %s is rejected without touching the file",
  async (minutes) => {
    const directory = await mkdtemp(join(tmpdir(), "shud-cfg-rewrite-"));
    const path = join(directory, "fixture.cfg.para");
    try {
      await writeFile(path, "END 7\n");
      await expect(ensureOutputInterval(path, "DT_YE_IC", minutes)).rejects.toThrow(
        "positive integer",
      );
      expect(() => ensureOutputIntervalBytes(latin1("END 7\n"), "DT_YE_IC", minutes)).toThrow(
        "positive integer",
      );
      expect(await readFile(path, "utf8")).toBe("END 7\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("output interval keys must be plain parameter names", () => {
  expect(() => ensureOutputIntervalBytes(latin1("END 7\n"), "DT.*", 1440)).toThrow("parameter key");
});

test("the file rewrite applies the same transform after END and preserves other bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shud-cfg-rewrite-"));
  const path = join(directory, "fixture.cfg.para");
  try {
    await writeFile(path, latin1("#\xff note\r\nEND 99\r\ndt_ye_ic  0\r\nNUM_OPENMP\t8"));
    await updateEnd(path, 30);
    await ensureOutputInterval(path, "DT_YE_IC", 1440);
    expect(await readFile(path)).toEqual(
      latin1("#\xff note\r\nEND 30\r\ndt_ye_ic  1440\r\nNUM_OPENMP\t8"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an already daily DT_YE_IC copy is not rewritten, keeping its file identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shud-cfg-rewrite-"));
  const path = join(directory, "fixture.cfg.para");
  try {
    await writeFile(path, "END 7\r\ndt_ye_ic\t1440\r\n", { mode: 0o644 });
    const before = await stat(path, { bigint: true });
    await ensureOutputInterval(path, "DT_YE_IC", 1440);
    const after = await stat(path, { bigint: true });
    expect(await readFile(path, "utf8")).toBe("END 7\r\ndt_ye_ic\t1440\r\n");
    expect([after.ino, after.mtimeNs, after.mode]).toEqual([
      before.ino,
      before.mtimeNs,
      before.mode,
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the CLI entry still rewrites only END", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shud-cfg-rewrite-"));
  const path = join(directory, "fixture.cfg.para");
  try {
    await writeFile(path, "START\t0\nEND 1827\nNUM_OPENMP\t8\n");
    await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL("./shud-cfg-rewrite.ts", import.meta.url)),
      path,
      "30",
    ]);
    expect(await readFile(path, "utf8")).toBe("START\t0\nEND 30\nNUM_OPENMP\t8\n");
    await expect(
      promisify(execFile)(process.execPath, [
        fileURLToPath(new URL("./shud-cfg-rewrite.ts", import.meta.url)),
        path,
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Usage: shud-cfg-rewrite.ts") as unknown,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
