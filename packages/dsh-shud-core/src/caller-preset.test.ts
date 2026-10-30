import { expect, test, vi } from "vitest";
import { presetIdToRole, readCallerPresetId } from "./index.ts";

function callerWithProjection(preset: unknown, headerPreset = "coordinator") {
  const session = { header: { agentPreset: headerPreset } };
  const current = { preset };
  const stateOf = vi.fn((actualSession: object, key: string) =>
    actualSession === session && key === "agentPreset" ? current.preset : undefined,
  );
  const sessionProjections = { stateOf };
  const ctx = {
    sessionProjections,
    get: (name: string) => (name === "sessionProjections" ? sessionProjections : undefined),
  };
  return { agent: { session, ctx }, current, stateOf };
}

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
  "current caller preset %j is returned unchanged",
  (agentPreset) => {
    const { agent, stateOf } = callerWithProjection(agentPreset, "stale-header");
    expect(readCallerPresetId(agent)).toBe(agentPreset);
    expect(stateOf).toHaveBeenCalledWith(agent.session, "agentPreset");
  },
);

test.each([
  { header: "coordinator", current: "worker", switched: "coordinator" },
  { header: "worker", current: "coordinator", switched: "worker" },
])(
  "current $current overrides frozen $header header and follows subsequent switches",
  ({ header, current: preset, switched }) => {
    const { agent, current, stateOf } = callerWithProjection(preset, header);
    expect(readCallerPresetId(agent)).toBe(preset);
    current.preset = switched;
    expect(readCallerPresetId(agent)).toBe(switched);
    expect(agent.session.header.agentPreset).toBe(header);
    expect(stateOf).toHaveBeenCalledTimes(2);
    expect(stateOf).toHaveBeenNthCalledWith(1, agent.session, "agentPreset");
    expect(stateOf).toHaveBeenNthCalledWith(2, agent.session, "agentPreset");
  },
);

test.each([undefined, null, "", 7, false, {}, []])(
  "missing or invalid current projection %j never falls back to the header",
  (preset) => {
    const { agent, stateOf } = callerWithProjection(preset);
    expect(readCallerPresetId(agent)).toBe("unknown");
    expect(stateOf).toHaveBeenCalledWith(agent.session, "agentPreset");
  },
);

test.each([
  undefined,
  null,
  {},
  ...[undefined, null, {}, { stateOf: 7 }].map((sessionProjections) => ({
    sessionProjections,
    get: () => sessionProjections,
  })),
])("missing projection service in context %j never falls back to the header", (ctx) => {
  const agent = { session: { header: { agentPreset: "coordinator" } }, ctx };
  expect(readCallerPresetId(agent)).toBe("unknown");
});

test.each([undefined, null])("missing session %j returns unknown with a service", (session) => {
  const { agent } = callerWithProjection("worker");
  expect(readCallerPresetId({ ...agent, session })).toBe("unknown");
});

test("projection read failure returns unknown without a header fallback", () => {
  const { agent, stateOf } = callerWithProjection("worker");
  stateOf.mockImplementation(() => {
    throw new Error("projection unavailable");
  });
  expect(readCallerPresetId(agent)).toBe("unknown");
  expect(stateOf).toHaveBeenCalledWith(agent.session, "agentPreset");
});

test("service access failure returns unknown without a header fallback", () => {
  const unavailable = () => {
    throw new Error("service unavailable");
  };
  const agent = {
    session: { header: { agentPreset: "coordinator" } },
    ctx: {
      get sessionProjections() {
        return unavailable();
      },
      get: unavailable,
    },
  };
  expect(readCallerPresetId(agent)).toBe("unknown");
});

test("projection reads retain the public service receiver", () => {
  const session = { header: { agentPreset: "coordinator" } };
  const sessionProjections = {
    preset: "worker",
    stateOf(actualSession: object, key: string) {
      return actualSession === session && key === "agentPreset" ? this.preset : undefined;
    },
  };
  const agent = { session, ctx: { sessionProjections } };
  expect(readCallerPresetId(agent)).toBe("worker");
});

test.each([
  { preset: "coordinator", role: "coordinator" },
  { preset: "worker", role: "worker" },
  { preset: "unknown", role: "unknown" },
  { preset: "standard", role: "unknown" },
  { preset: "repo_explorer", role: "unknown" },
  { preset: "coder", role: "unknown" },
  { preset: "reviewer", role: "unknown" },
  { preset: "custom-preset", role: "unknown" },
  { preset: "", role: "unknown" },
  { preset: " ", role: "unknown" },
  { preset: "Coordinator", role: "unknown" },
  { preset: "WORKER", role: "unknown" },
  { preset: " coordinator", role: "unknown" },
  { preset: "worker ", role: "unknown" },
])("preset $preset maps to policy role $role", ({ preset, role }) => {
  expect(presetIdToRole(preset)).toBe(role);
});

test("custom attribution is preserved without granting a coordinator policy role", () => {
  const { agent } = callerWithProjection(" custom-preset ", "coordinator");
  const attribution = readCallerPresetId(agent);
  expect(attribution).toBe(" custom-preset ");
  expect(presetIdToRole(attribution)).toBe("unknown");
});
