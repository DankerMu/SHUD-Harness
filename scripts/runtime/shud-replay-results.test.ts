import { expect, test } from "vitest";
import { makeReplayFixture } from "./replay/test-harness.ts";
import type { ReplayDiagnosticFailure } from "./replay/session/test-harness.ts";
import { assertReplayEvidence } from "./shud-replay-evidence.ts";
import { data } from "./shud-evidence-events.ts";
import { object } from "./shud-restart-evidence.ts";

const ordinaryCalls: Omit<ReplayDiagnosticFailure, "eventError">[] = [
  {
    sessionId: "coder-base",
    name: "bash",
    callId: "diagnostic-bash",
    arguments: { command: "exit 1" },
  },
  {
    sessionId: "coder-base",
    name: "edit",
    callId: "diagnostic-edit",
    arguments: { file_path: "missing.txt", old_string: "absent", new_string: "replacement" },
  },
  {
    sessionId: "reviewer",
    name: "read",
    callId: "diagnostic-read",
    arguments: { file_path: "missing.txt" },
  },
  {
    sessionId: "worker-base",
    name: "job_output",
    callId: "diagnostic-job-output",
    // This completed error cannot supply the required correct-id terminal wait.
    arguments: { wait: true },
  },
];

function diagnosticFixture(diagnostic: ReplayDiagnosticFailure) {
  const { snapshot } = makeReplayFixture("passed", [diagnostic]);
  const child = snapshot.children.find((log) => log.header.id === diagnostic.sessionId)!;
  const call = child.events.find(
    (event) => event.type === "tool/call" && data(event).callId === diagnostic.callId,
  )!;
  const result = child.events.find(
    (event) =>
      event.type === "tool/result" && object(data(event).message).toolCallId === diagnostic.callId,
  )!;
  return { snapshot, child, call, result };
}

test.each(
  ordinaryCalls.flatMap((call) => [false, true].map((eventError) => ({ ...call, eventError }))),
)(
  "accepts completed $sessionId/$name diagnostic failure (event error: $eventError)",
  (diagnostic) => {
    const { snapshot, result } = diagnosticFixture(diagnostic);
    expect(object(data(result).message).isError).toBe(true);
    expect(Object.hasOwn(data(result), "error")).toBe(diagnostic.eventError);
    const retained = structuredClone(snapshot);
    expect(assertReplayEvidence(snapshot).status).toBe("PASS");
    expect(snapshot).toEqual(retained);
  },
);

test.each(["missing", "duplicate", "misbound message", "misbound source", "before call"])(
  "rejects a %s result for a failed ordinary call",
  (defect) => {
    const { snapshot, child, call, result } = diagnosticFixture({
      ...ordinaryCalls[0],
      eventError: true,
    });
    const resultIndex = child.events.indexOf(result);
    if (defect === "missing") child.events.splice(resultIndex, 1);
    if (defect === "duplicate") child.events.splice(resultIndex + 1, 0, structuredClone(result));
    if (defect === "misbound message")
      object(data(result).message).toolCallId = "foreign-diagnostic-call";
    if (defect === "misbound source")
      object(object(data(result).message).source).callId = "foreign-diagnostic-call";
    if (defect === "before call") {
      child.events.splice(resultIndex, 1);
      result.time = call.time;
      child.events.splice(child.events.indexOf(call), 0, result);
    }
    child.events.forEach((event, seq) => {
      event.seq = seq;
    });
    child.asOfSeq = child.events.length - 1;
    child.flushedThroughSeq = child.asOfSeq;
    const retained = structuredClone(snapshot);
    expect(() => assertReplayEvidence(snapshot)).toThrow();
    expect(snapshot).toEqual(retained);
  },
);

test.each([undefined, null, 0, "false"])(
  "rejects a completed ordinary result with a nonboolean error flag: %s",
  (flag) => {
    const { snapshot, result } = diagnosticFixture({
      ...ordinaryCalls[0],
      eventError: true,
    });
    const message = object(data(result).message);
    if (flag === undefined) delete message.isError;
    else message.isError = flag;
    const retained = structuredClone(snapshot);
    expect(() => assertReplayEvidence(snapshot)).toThrow();
    expect(snapshot).toEqual(retained);
  },
);
