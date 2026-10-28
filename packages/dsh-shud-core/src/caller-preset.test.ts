import { expect, test } from "vitest";
import { readCallerPresetId } from "./index.ts";

test.each([
  undefined,
  null,
  {},
  { session: undefined },
  { session: null },
  { session: {} },
  { session: { header: null } },
  { session: { header: {} } },
  ...[undefined, null, "", 7, false, {}].map((agentPreset) => ({
    session: { header: { agentPreset } },
  })),
])("missing caller identity %j returns unknown without throwing", (agent) => {
  expect(readCallerPresetId(agent)).toBe("unknown");
});

test.each(["coordinator", "worker", "custom-preset", " custom-preset ", " "])(
  "caller preset %j is returned unchanged",
  (agentPreset) => {
    expect(readCallerPresetId({ session: { header: { agentPreset } } })).toBe(agentPreset);
  },
);
