import { expect, test } from "vitest";
import { makeReplayFixture, type ReplayFixture } from "./replay/test-harness.ts";
import { assertReplayEvidence } from "./shud-replay-evidence.ts";
import {
  argumentsOf,
  calls,
  data,
  resultFor,
  resultObject,
  resultText,
} from "./shud-evidence-events.ts";
import { object, type CanonicalEvent } from "./shud-restart-evidence.ts";
import { rememberReplayBuilds, type ReplayBuildBinding } from "./shud-replay-snapshot.ts";

interface ProducerStage {
  name: string;
  sessionId: string;
  callId: string;
  tool: "shud_build" | "shud_run";
}
const stages: ProducerStage[] = [
  { name: "base build", sessionId: "coder-base", callId: "call-build-base", tool: "shud_build" },
  {
    name: "candidate build",
    sessionId: "coder-candidate",
    callId: "call-build-candidate",
    tool: "shud_build",
  },
  { name: "base run", sessionId: "worker-base", callId: "call-run-base", tool: "shud_run" },
  {
    name: "candidate run",
    sessionId: "worker-candidate",
    callId: "call-run-candidate",
    tool: "shud_run",
  },
];

function producer(fixture: ReplayFixture, stage: ProducerStage) {
  const log = fixture.snapshot.children.find((child) => child.header.id === stage.sessionId)!;
  const call = calls(log, stage.tool).find((event) => data(event).callId === stage.callId)!;
  return { log, call, result: resultFor(log, call, "TOOL_RESULT") };
}

function failedAttemptFixture(stage: ProducerStage): ReplayFixture {
  const original = producer(makeReplayFixture(), stage);
  return makeReplayFixture("passed", [
    {
      sessionId: stage.sessionId,
      name: stage.tool,
      callId: `failed-${stage.callId}`,
      arguments: argumentsOf(original.call),
      eventError: true,
    },
  ]);
}

test.each(stages)(
  "accepts a failed same-parameter $name attempt before its successful durable producer",
  (stage) => {
    const { snapshot } = failedAttemptFixture(stage);
    expect(
      Object.keys(snapshot.files).filter((path) =>
        /^builds\/[^/]+\/build-record\.json$/u.test(path),
      ),
    ).toHaveLength(2);
    expect(
      Object.keys(snapshot.files).filter((path) => /^runs\/[^/]+\/run-job\.json$/u.test(path)),
    ).toHaveLength(2);
    const retained = structuredClone(snapshot);
    expect(assertReplayEvidence(snapshot).status).toBe("PASS");
    expect(snapshot).toEqual(retained);
  },
);

test.each(stages.filter((stage) => stage.tool === "shud_build"))(
  "retains live native build bindings despite a completed failed $name attempt",
  (stage) => {
    const { snapshot } = failedAttemptFixture(stage);
    const retained = structuredClone(snapshot);
    const bindings = new Map<string, ReplayBuildBinding>();
    rememberReplayBuilds(snapshot.root, snapshot.children, bindings);
    expect([...bindings]).toEqual([
      ["BUILD-20261102T090000-f6a7", { taskId: "TASK-20261102T090000-c3d4", changeId: null }],
      [
        "BUILD-20261102T090000-a7b8",
        { taskId: "TASK-20261102T090000-c3d4", changeId: "CHG-20261102T090000-a1b2" },
      ],
    ]);
    expect(snapshot).toEqual(retained);
  },
);

test.each(
  stages.flatMap((stage) =>
    (["missing", "failed"] as const).map((defect) => ({ ...stage, defect })),
  ),
)("rejects a $defect required $name producer despite successful durable records", (stage) => {
  const fixture = makeReplayFixture();
  const { log, call, result } = producer(fixture, stage);
  if (stage.defect === "missing") {
    const removed = log.events.splice(call.seq - 1, 3);
    expect(removed.map((event) => event.type)).toEqual([
      "assistant/message",
      "tool/call",
      "tool/result",
    ]);
    log.events.forEach((event, seq) => {
      event.seq = seq;
    });
    log.asOfSeq = log.events.length - 1;
    log.flushedThroughSeq = log.asOfSeq;
  } else object(data(result).message).isError = true;
  const retained = structuredClone(fixture.snapshot);
  expect(() => assertReplayEvidence(fixture.snapshot)).toThrow();
  expect(fixture.snapshot).toEqual(retained);
});

test("a successful foreign submission and collection cannot replace the failed recorded owner", () => {
  const fixture = makeReplayFixture("passed", [], {}, { incidentalWorkers: ["readonly"] });
  const { snapshot, runs } = fixture;
  const own = producer(fixture, stages[2]);
  const collection = resultFor(own.log, calls(own.log, "shud_collect")[0], "TOOL_RESULT");
  // Reuse complete builder-produced invocation envelopes for a foreign claim
  // about the existing durable run. Do not add a third record to mask ownership.
  const block = JSON.parse(
    JSON.stringify(own.log.events.slice(own.call.seq - 1, collection.seq + 1))
      .replaceAll("call-run-base", "foreign-run")
      .replaceAll("call-wait-base", "foreign-wait")
      .replaceAll("call-collect-base", "foreign-collect"),
  ) as CanonicalEvent[];
  const foreign = snapshot.children.find((child) => child.header.id === "worker-readonly")!;
  const insert = foreign.events.length - 2;
  for (const event of block) event.time = foreign.events[insert - 1].time;
  foreign.events.splice(insert, 0, ...block);
  foreign.events.forEach((event, seq) => {
    event.seq = seq;
    if (event.type === "request/header")
      object(object(data(event).header).config).model = "fixture-model";
    if (event.type === "assistant/message")
      object(object(data(event).message).source).model = "fixture-model";
  });
  foreign.asOfSeq = foreign.events.length - 1;
  foreign.flushedThroughSeq = foreign.asOfSeq;
  object(data(own.result).message).isError = true;
  expect(foreign.header.id).not.toBe(runs[0].job.owner_session);
  expect(resultText(resultFor(foreign, calls(foreign, "shud_run")[0], "TOOL_RESULT"))).toContain(
    `run_id=${runs[0].job.run_id}`,
  );
  expect(
    resultObject(resultFor(foreign, calls(foreign, "shud_collect")[0], "TOOL_RESULT")),
  ).toEqual(runs[0].record);
  expect(object(data(own.result).message).isError).toBe(true);
  const retained = structuredClone(snapshot);
  expect(() => assertReplayEvidence(snapshot)).toThrow();
  expect(snapshot).toEqual(retained);
});
