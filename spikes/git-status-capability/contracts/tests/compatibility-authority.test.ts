import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { expectSuccess, invoke, invokeAuthority, successReceipt } from "./authority-test-helpers";

describe("public authority and structural compatibility seams", () => {
  test("emits one exact deterministic authority receipt before admitting compatibility fixtures", async () => {
    const first = await invokeAuthority();
    const second = await invokeAuthority();
    expectSuccess(first, "authority_set");
    expect(second).toEqual(first);

    const cases = [
      ["row_evidence", "row-platform-state-v1.json"],
      ["final_bundle", "final-reference-receipt-v1.json"]
    ] as const;
    for (const [kind, name] of cases) {
      const result = await invoke(["--input", join(import.meta.dir, "..", "fixtures", "compat", name), "--kind", kind]);
      expect(result).toEqual({ exit: 0, stdout: successReceipt(kind), stderr: "" });
    }
  });
});
