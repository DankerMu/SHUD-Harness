import { isAbsolute, join, relative, sep } from "node:path";
import { object, requireFact, text, type CanonicalEvent } from "./shud-restart-evidence.ts";
import type { SessionLog } from "./shud-session-log.ts";

function fact(value: unknown, predicate: string): asserts value {
  if (!value)
    throw Object.assign(new Error(`Evidence predicate failed: ${predicate}`), { predicate });
}
type EventLog = Pick<SessionLog, "events">;
export function data(event: CanonicalEvent): Record<string, unknown> {
  return object(event.data);
}
export function calls(log: EventLog, name: string): CanonicalEvent[] {
  return log.events.filter((event) => event.type === "tool/call" && data(event).name === name);
}
export function onlyCall(log: EventLog, name: string, code: string): CanonicalEvent {
  const values = calls(log, name);
  fact(values.length === 1, code);
  return values[0];
}
export function argumentsOf(call: CanonicalEvent): Record<string, unknown> {
  return object(JSON.parse(text(data(call).arguments)) as unknown);
}
export function completedResultFor(
  log: EventLog,
  call: CanonicalEvent,
  code: string,
): CanonicalEvent {
  const id = text(data(call).callId);
  const results = log.events.filter(
    (event) => event.type === "tool/result" && object(data(event).message).toolCallId === id,
  );
  fact(results.length === 1, "TOOL_RESULT");
  const event = results[0];
  const value = data(event);
  const message = object(value.message);
  fact(
    message.role === "tool" &&
      object(message.source).kind === "tool" &&
      object(message.source).callId === id,
    "TOOL_RESULT",
  );
  fact(event.seq > call.seq, "ORDER");
  fact(typeof message.isError === "boolean", code);
  return event;
}
export function resultFor(log: EventLog, call: CanonicalEvent, code: string): CanonicalEvent {
  const event = completedResultFor(log, call, code);
  const value = data(event);
  fact(!value.error && object(value.message).isError === false, code);
  return event;
}
export function resultText(event: CanonicalEvent): string {
  const content = object(data(event).message).content;
  fact(Array.isArray(content), "TOOL_RESULT");
  return content
    .map((part: unknown) => {
      const item = object(part);
      return item.type === "text" ? text(item.text) : "";
    })
    .join("");
}
export function resultObject(event: CanonicalEvent): Record<string, unknown> {
  return object(JSON.parse(resultText(event)) as unknown);
}
export function validateLog(log: SessionLog, home: string): void {
  fact(
    log.header.type === "session" &&
      log.header.version === 4 &&
      typeof log.header.id === "string" &&
      /^[A-Za-z0-9-]+$/u.test(log.header.id) &&
      Number.isSafeInteger(log.asOfSeq) &&
      log.asOfSeq >= -1 &&
      log.events.length === log.asOfSeq + 1 &&
      log.flushedThroughSeq >= log.asOfSeq &&
      Number.isSafeInteger(log.flushedThroughSeq) &&
      log.events.every((event, i) => event.seq === i && Number.isFinite(event.time)),
    "CANONICAL_LOG",
  );
  const path = relative(join(home, "sessions"), log.canonicalLog);
  fact(
    isAbsolute(log.canonicalLog) &&
      !isAbsolute(path) &&
      !path.split(sep).includes("..") &&
      path.split(sep).length === 3 &&
      path.split(sep)[1] === log.header.id &&
      /^session\.v4\.jsonl(?:\.zstd)?$/u.test(path.split(sep)[2]),
    "CANONICAL_LOG",
  );
  const ids = log.events
    .filter((event) => event.type === "tool/call")
    .map((event) => text(data(event).callId));
  fact(new Set(ids).size === ids.length, "TOOL_RESULT");
}
export function successfulValidation(log: EventLog, reportId: string) {
  const validations = calls(log, "report_validate").filter(
    (call) => argumentsOf(call).report_id === reportId,
  );
  fact(validations.length > 0, "REPORT_VALIDATION");
  const validated = validations.map((call) => ({
    call,
    result: resultFor(log, call, "REPORT_VALIDATION"),
  }));
  const validation = validated.find(({ result }) => {
    const output = resultObject(result);
    return output.report_id === reportId && output.ok === true && output.status === "reviewed";
  });
  fact(validation, "REPORT_VALIDATION");
  return validation;
}
export function responseModel(worker: SessionLog): string {
  const run = worker.events.find(
    (event) => event.type === "tool/call" && object(event.data).name === "shud_run",
  );
  requireFact(run, "Missing worker model provenance");
  const headers = worker.events.filter(
    (event) => event.type === "request/header" && event.seq < run.seq,
  );
  requireFact(headers.length > 0, "Missing worker request model metadata");
  return text(object(object(object(headers[headers.length - 1].data).header).config).model);
}
