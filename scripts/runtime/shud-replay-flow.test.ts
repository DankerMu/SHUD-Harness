import { expect, test } from "vitest";
import { makeReplayFixture } from "./replay/test-harness.ts";
import { data } from "./shud-evidence-events.ts";
import { object, type CanonicalEvent } from "./shud-restart-evidence.ts";
import { replayReady, sessionComplete } from "./shud-replay-flow.ts";
import type { SessionLog } from "./shud-session-log.ts";

function append(log: SessionLog, type: string, time: number, value: unknown): void {
  log.events.push({ type, seq: log.events.length, time, data: value });
  log.asOfSeq = log.events.length - 1;
  log.flushedThroughSeq = log.asOfSeq;
}

function awaitingReviewerNotice() {
  const { root, children } = makeReplayFixture().snapshot;
  const reviewer = children.find((child) => child.header.agentPreset === "reviewer")!;
  const notice = root.events.find(
    (event) =>
      event.type === "user/message" &&
      object(data(event).source).kind === "subagent-settled" &&
      object(data(event).source).senderSessionId === reviewer.header.id,
  )!;
  const childEnd = reviewer.events.at(-1)!;
  root.events = root.events.slice(0, notice.seq);
  // Like the observed root 109 / reviewer 99 race: the root has finished its
  // dispatch turn, but that turn predates the child's completion and delivery.
  append(root, "turn/end", root.events.at(-1)!.time + 1, {
    turn: 1,
    reason: { kind: "completed" },
  });
  expect(root.events.at(-1)!.time).toBeLessThan(childEnd.time);
  expect(
    root.events.some(
      (event) => event.type === "subagent/catalog" && data(event).childId === reviewer.header.id,
    ),
  ).toBe(true);
  expect([root, ...children].every(sessionComplete)).toBe(true);
  return { root, children, notice, childEnd };
}

function deliverReviewerNotice(logs: {
  root: SessionLog;
  notice: CanonicalEvent;
  childEnd: CanonicalEvent;
}): void {
  append(logs.root, "turn/start", logs.childEnd.time + 12, { turn: 2 });
  append(logs.root, "user/message", logs.childEnd.time + 32, logs.notice.data);
}

test("replay waits for the latest catalog child settlement despite an old completed root turn", () => {
  const logs = awaitingReviewerNotice();
  expect(replayReady(logs)).toBe(false);
});

test("replay waits for the new root turn after the latest child notice arrives", () => {
  const logs = awaitingReviewerNotice();
  deliverReviewerNotice(logs);
  expect(replayReady(logs)).toBe(false);
});

test("replay is ready when the complete fixture has settled children and a completed root", () => {
  expect(replayReady(makeReplayFixture().snapshot)).toBe(true);
});

test("replay readiness does not require report work once child notices and the root turn finish", () => {
  const logs = awaitingReviewerNotice();
  deliverReviewerNotice(logs);
  append(logs.root, "turn/end", logs.childEnd.time + 33, {
    turn: 2,
    reason: { kind: "completed" },
  });
  expect(
    logs.root.events.some(
      (event) => event.type === "tool/call" && data(event).name === "report_generate",
    ),
  ).toBe(false);
  expect(replayReady(logs)).toBe(true);
});

test.each(["missing child log", "uncataloged child", "duplicate child log", "duplicate catalog"])(
  "replay is not ready with %s",
  (mismatch) => {
    const logs = makeReplayFixture().snapshot;
    if (mismatch === "missing child log") logs.children.pop();
    if (mismatch === "uncataloged child") logs.children.at(-1)!.header.id = "uncataloged-child";
    if (mismatch === "duplicate child log")
      logs.children[logs.children.length - 1] = logs.children[0];
    if (mismatch === "duplicate catalog") {
      const catalogs = logs.root.events.filter((event) => event.type === "subagent/catalog");
      data(catalogs.at(-1)!).childId = data(catalogs[0]).childId;
    }
    expect(replayReady(logs)).toBe(false);
  },
);
