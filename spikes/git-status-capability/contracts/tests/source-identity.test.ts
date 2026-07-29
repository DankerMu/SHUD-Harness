import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { capture, failure, success, validIdentityPath, withTemporaryFile } from "./helpers";

describe("source identity projection", () => {
  test("the four admitted commit peers succeed twice without deriving state or decision", async () => {
    const expected = { exit: 0, stdout: success("source_identity_projection"), stderr: "" };
    expect(await capture(["--input", validIdentityPath, "--kind", "source_identity_projection"])).toEqual(expected);
    expect(await capture(["--input", validIdentityPath, "--kind", "source_identity_projection"])).toEqual(expected);
    const fixture = JSON.parse(await readFile(validIdentityPath, "utf8"));
    expect(Object.keys(fixture)).toEqual(["schema_version", "source_record", "platforms", "decision"]);
    expect(fixture.platforms.every((platform: Record<string, unknown>) => Object.keys(platform).sort().join() === "platform,source_commit")).toBe(true);
  });

  test("every independent and synchronized strict-subset SHA forgery fails before downstream use", async () => {
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

  test("missing, unknown, reordered platform, malformed SHA, and future state vocabulary are rejected", async () => {
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
