import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { capture, directCommand, failure, success, validIdentityPath, withTemporaryFile } from "./helpers";

describe("source identity projection", () => {
  test("the two direct public commands emit exact LF-terminated receipts", async () => {
    const result = await directCommand(["--input", validIdentityPath, "--kind", "source_identity_projection"]);
    expect(result).toEqual({ exit: 0, stdout: success("source_identity_projection"), stderr: "" });
    expect(result.stdout.endsWith("\n")).toBe(true);
  });

  test("the four admitted SHA peers succeed byte-identically across repeats", async () => {
    const expected = { exit: 0, stdout: success("source_identity_projection"), stderr: "" };
    expect(await capture(["--input", validIdentityPath, "--kind", "source_identity_projection"])).toEqual(expected);
    expect(await capture(["--input", validIdentityPath, "--kind", "source_identity_projection"])).toEqual(expected);
  });

  test("every independent and synchronized strict-subset four-SHA forgery fails", async () => {
    const fixture = JSON.parse(await readFile(validIdentityPath, "utf8"));
    const forged = "b".repeat(40);
    for (let mask = 1; mask < 15; mask += 1) {
      const changed = structuredClone(fixture);
      if (mask & 1) changed.source_record.source_sha = forged;
      if (mask & 2) changed.platforms[0].source_commit = forged;
      if (mask & 4) changed.platforms[1].source_commit = forged;
      if (mask & 8) changed.decision.base_sha = forged;
      await withTemporaryFile(JSON.stringify(changed), async (path) => {
        expect(await capture(["--input", path, "--kind", "source_identity_projection"])).toEqual({
          exit: 2, stdout: "", stderr: failure("CONTRACT_SCHEMA_INVALID")
        });
      });
    }
  });

  test("missing, unknown, reordered platform, malformed SHA, and future vocabulary fail closed", async () => {
    const fixture = JSON.parse(await readFile(validIdentityPath, "utf8"));
    const mutations = [
      (value: any) => { delete value.decision; },
      (value: any) => { value.run_status = "valid_complete"; },
      (value: any) => { value.platforms.reverse(); },
      (value: any) => { value.source_record.source_sha = "A".repeat(40); },
      (value: any) => { value.platforms[0].observer_outcome = "clean"; },
      (value: any) => { value.decision.terminal_decision = "accepted"; }
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(fixture);
      mutate(changed);
      await withTemporaryFile(JSON.stringify(changed), async (path) => {
        expect(await capture(["--input", path, "--kind", "source_identity_projection"])).toEqual({
          exit: 2, stdout: "", stderr: failure("CONTRACT_SCHEMA_INVALID")
        });
      });
    }
  });
});
