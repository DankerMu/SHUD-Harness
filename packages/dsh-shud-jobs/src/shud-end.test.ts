import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { updateEnd } from "./shud-end.ts";
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
