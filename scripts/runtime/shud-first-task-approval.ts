import WebSocket from "ws";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { realpathSync, lstatSync } from "node:fs";
import {
  EvidenceReportSchema,
  ReportIdSchema,
} from "../../packages/dsh-shud-core/src/schemas/index.ts";
import { approvalReport } from "./shud-first-task-evidence.ts";
import { object, requireFact, text } from "./shud-restart-evidence.ts";
import { BUFFER_LIMIT, HTTP_MS, STOP_MS, load, screen, type WebHost } from "./shud-web-driver.ts";

/** Passive, owned-call-only interaction handling; completion never depends on seeing a card. */
export async function openReportApprovals(host: WebHost, sessionId: string, workspace: string) {
  const url = new URL("/api/remote.mux", host.origin);
  url.protocol = "ws:";
  const socket = new WebSocket(url, {
    headers: { cookie: host.cookie },
    handshakeTimeout: HTTP_MS,
    maxPayload: BUFFER_LIMIT,
    perMessageDeflate: false,
  });
  let clientId: string | undefined;
  let failure: Error | undefined;
  let closed = false;
  let closing = false;
  let bytes = 0;
  let chain = Promise.resolve();
  const requests = new AbortController();
  const seen = new Set<string>();
  const cancelled = new Set<string>();
  const streamId = "first-task-approvals";
  socket.on("error", () => {
    failure = new Error("First-task approval connection failed");
  });
  socket.on("close", () => {
    closed = true;
    requests.abort();
    if (!closing) failure = new Error("First-task approval connection closed unexpectedly");
  });
  socket.on("open", () => {
    socket.send(
      JSON.stringify({ type: "open", streamId, endpoint: "$events", payload: { args: {} } }),
    );
  });
  socket.on("message", (raw, binary) => {
    try {
      requireFact(!binary, "Approval stream returned binary data");
      const buffer = Array.isArray(raw)
        ? Buffer.concat(raw)
        : raw instanceof ArrayBuffer
          ? Buffer.from(raw)
          : raw;
      bytes += buffer.byteLength;
      requireFact(bytes <= BUFFER_LIMIT, "Approval stream exceeds byte budget");
      const source = buffer.toString("utf8");
      screen(source);
      const frame = object(JSON.parse(source) as unknown);
      requireFact(
        frame.streamId === streamId && frame.type === "item",
        "Approval stream frame failed",
      );
      const value = object(frame.value);
      if (value.type === "ready") {
        requireFact(!clientId, "Duplicate approval client identity");
        clientId = text(value.clientId);
      } else if (value.type === "cancel") {
        cancelled.add(text(value.eventId));
      } else if (value.type === "waterfall") {
        const eventId = text(value.eventId);
        requireFact(clientId && !seen.has(eventId), "Approval invocation identity mismatch");
        seen.add(eventId);
        const owner = clientId;
        // Serialize callbacks: an invocation is answered at most once on its original peer.
        chain = chain
          .then(async () => {
            if (cancelled.has(eventId) || closing) return;
            let allowed = false;
            const request = object(value.request);
            if (
              value.event === "approval/request" &&
              value.agentId === sessionId &&
              request.toolName === "report_submit" &&
              typeof request.callId === "string"
            ) {
              const prefix = await host.prefix(sessionId, requests.signal);
              const reportId = approvalReport(prefix, request.callId);
              if (
                ReportIdSchema.safeParse(reportId).success &&
                request.reason === `PI approval required for report ${reportId}`
              ) {
                const path = join(workspace, "reports", `${reportId}.json`);
                requireFact(
                  realpathSync(path) === path && lstatSync(path).isFile(),
                  "Unsafe report approval target",
                );
                const report = EvidenceReportSchema.parse(load(path));
                allowed =
                  report.report_id === reportId &&
                  report.status === "reviewed" &&
                  report.decision_history.length === 0;
              }
            }
            if (cancelled.has(eventId) || closing) return;
            await host.rpc(
              "$events/result",
              {
                clientId: owner,
                eventId,
                outcome: allowed ? { kind: "result", value: "allowed-once" } : { kind: "next" },
              },
              requests.signal,
            );
          })
          .catch(() => {
            failure = new Error("First-task owned approval processing failed");
          });
      }
    } catch {
      failure = new Error("First-task approval protocol failed");
    }
  });
  function healthy(): void {
    host.healthy();
    if (failure) throw failure;
    requireFact(!closed, "First-task approval stream is unavailable");
  }
  async function close(): Promise<void> {
    closing = true;
    // Keep the peer alive until any already-posted HTTP event result settles.
    const timer = new AbortController();
    let timedOut = false;
    try {
      await Promise.race([
        chain,
        delay(STOP_MS, undefined, { signal: timer.signal }).then(() => {
          timedOut = true;
          requests.abort();
        }),
      ]);
    } finally {
      timer.abort();
    }
    if (timedOut) socket.terminate();
    else if (socket.readyState === WebSocket.OPEN) socket.close();
    else if (!closed) socket.terminate();
    const deadline = Date.now() + STOP_MS;
    while (!closed && Date.now() < deadline) await delay(50);
    if (!closed) {
      socket.terminate();
      const stopped = Date.now() + STOP_MS;
      while (!closed && Date.now() < stopped) await delay(50);
    }
    requireFact(closed, "First-task approval stream cleanup failed");
    socket.removeAllListeners();
    requests.abort();
    await chain;
    requireFact(!timedOut, "First-task approval request drain deadline");
    if (failure) throw failure;
  }
  try {
    const deadline = Date.now() + HTTP_MS;
    while (!clientId && Date.now() < deadline) {
      healthy();
      await delay(50, undefined, { signal: host.abort });
    }
    requireFact(clientId, "First-task approval stream readiness deadline");
    return { healthy, close };
  } catch (error) {
    try {
      await close();
    } catch {
      throw new Error("First-task approval startup and cleanup failed");
    }
    throw error;
  }
}
