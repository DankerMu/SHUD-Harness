import { expect, test } from "vitest";
import { makeReplayFixture } from "./replay/test-harness.ts";
import type { ReplayCollectionScenario } from "./replay/session/test-harness.ts";
import { assertReplayEvidence } from "./shud-replay-evidence.ts";
import {
  argumentsOf,
  calls,
  completedResultFor,
  data,
  resultFor,
  resultObject,
} from "./shud-evidence-events.ts";
import { object } from "./shud-restart-evidence.ts";

const rereads: { name: string; scenario: ReplayCollectionScenario }[] = [
  { name: "reviewer cached reads", scenario: { observers: ["reviewer"] } },
  { name: "coordinator cached reads", scenario: { observers: ["coordinator"] } },
  {
    name: "reviewer and coordinator cached reads",
    scenario: { observers: ["reviewer", "coordinator"] },
  },
  { name: "repeated submitting-worker collection", scenario: { repeatWorker: true } },
  {
    name: "repeated own collection plus foreign cached reads",
    scenario: { observers: ["reviewer", "coordinator"], repeatWorker: true },
  },
  {
    name: "failed own read followed by successful own collection",
    scenario: {
      observers: ["reviewer", "coordinator"],
      baseCollection: "failed",
      repeatWorker: true,
    },
  },
];

test.each(rereads)("accepts the complete replay with $name", ({ scenario }) => {
  const { snapshot } = makeReplayFixture("passed", [], scenario);
  const retained = structuredClone(snapshot);
  expect(assertReplayEvidence(snapshot).status).toBe("PASS");
  expect(snapshot).toEqual(retained);
});

test.each(["missing", "failed"] as const)(
  "rejects %s required worker collection despite successful foreign cached reads",
  (baseCollection) => {
    const { snapshot, runs } = makeReplayFixture("passed", [], {
      observers: ["reviewer", "coordinator"],
      baseCollection,
    });
    const reviewer = snapshot.children.find((log) => log.header.agentPreset === "reviewer")!;
    for (const observer of [reviewer, snapshot.root]) {
      const observations = calls(observer, "shud_collect");
      expect(observations).toHaveLength(2);
      expect(
        observations.map((call) => resultObject(resultFor(observer, call, "TOOL_RESULT"))),
      ).toEqual(runs.map(({ record }) => record));
    }
    const job = runs[0].job;
    const worker = snapshot.children.find((log) => log.header.id === job.owner_session)!;
    const owned = calls(worker, "shud_collect").filter((call) => {
      const args = argumentsOf(call);
      return args.run_id === job.run_id || args.job_id === job.job_id;
    });
    expect(owned).toHaveLength(baseCollection === "missing" ? 0 : 1);
    if (baseCollection === "failed") {
      const result = completedResultFor(worker, owned[0], "TOOL_RESULT");
      expect(object(data(result).message).isError).toBe(true);
    }
    const retained = structuredClone(snapshot);
    expect(() => assertReplayEvidence(snapshot)).toThrow();
    expect(snapshot).toEqual(retained);
  },
);

test("rejects an own collection preceding the terminal wait despite successful foreign reads", () => {
  const { snapshot, runs } = makeReplayFixture("passed", [], {
    observers: ["reviewer", "coordinator"],
  });
  const worker = snapshot.children.find((log) => log.header.id === runs[0].job.owner_session)!;
  const collect = calls(worker, "shud_collect")[0];
  const wait = calls(worker, "job_output")[0];
  const times = worker.events.map((event) => event.time);
  const invocation = worker.events.splice(collect.seq - 1, 3);
  expect(invocation.map((event) => event.type)).toEqual([
    "assistant/message",
    "tool/call",
    "tool/result",
  ]);
  worker.events.splice(wait.seq - 1, 0, ...invocation);
  worker.events.forEach((event, seq) => {
    event.seq = seq;
    event.time = times[seq];
  });
  expect(resultFor(worker, collect, "TOOL_RESULT").seq).toBeLessThan(wait.seq);
  const retained = structuredClone(snapshot);
  expect(() => assertReplayEvidence(snapshot)).toThrow();
  expect(snapshot).toEqual(retained);
});
