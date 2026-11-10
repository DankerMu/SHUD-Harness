import WebSocket from "ws";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { object, requireFact, text } from "./shud-restart-evidence.ts";
import { BUFFER_LIMIT, HTTP_MS, STOP_MS, screen } from "./shud-web-driver.ts";

interface ApprovalPeer {
  origin: string;
  cookie: string;
  abort: AbortSignal;
  healthy(): void;
  rpc(endpoint: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}
type ApprovalPredicate = (
  invocation: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<boolean>;
/** Passive, owned-call-only interaction handling; completion never depends on seeing a card. */
export async function openOwnedApprovals(
  host: ApprovalPeer,
  decide: ApprovalPredicate,
  options: { streamId: string; label?: string; healthy?: () => void },
) {
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
  const rosterRequests = new AbortController();
  const seen = new Set<string>();
  const cancelled = new Set<string>();
  const observations = new Map<string, (value: unknown) => void>();
  const retired = new Set<string>();
  const streamId = options.streamId;
  const label = options.label ?? "First-task";
  socket.on("error", () => {
    failure = new Error(`${label} approval connection failed`);
  });
  socket.on("close", () => {
    closed = true;
    requests.abort();
    if (!closing) failure = new Error(`${label} approval connection closed unexpectedly`);
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
      const frameId = text(frame.streamId);
      if (frameId !== streamId) {
        if (retired.has(frameId)) return;
        const consume = observations.get(frameId);
        requireFact(consume && frame.type === "item", "Owned observation stream failed");
        observations.delete(frameId);
        retired.add(frameId);
        consume(frame.value);
        return;
      }
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
            if (cancelled.has(eventId) || closing || failure) return;
            host.abort.throwIfAborted();
            const allowed = await decide(value, requests.signal);
            if (cancelled.has(eventId) || closing || failure) return;
            host.abort.throwIfAborted();
            options.healthy?.();
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
            failure = new Error(`${label} owned approval processing failed`);
          });
      }
    } catch {
      failure = new Error(`${label} approval protocol failed`);
    }
  });
  function healthy(): void {
    host.healthy();
    if (failure) throw failure;
    requireFact(!closed, `${label} approval stream is unavailable`);
  }
  /** Take one bounded job/list roster on the existing owner connection, then cancel its stream. */
  async function jobRoster(sessionId: string): Promise<unknown> {
    healthy();
    requireFact(!closing, "Owner transport is closing");
    requireFact(observations.size + retired.size < 4096, "Job roster observation budget exceeded");
    const id = `observation-${randomUUID()}`;
    let resolvePending!: (value: unknown) => void;
    let rejectPending!: (reason?: unknown) => void;
    const promise = new Promise<unknown>((resolve, reject) => {
      resolvePending = resolve;
      rejectPending = reject;
    });
    const pending = { promise, resolve: resolvePending, reject: rejectPending };
    const signal = AbortSignal.any([
      host.abort,
      requests.signal,
      rosterRequests.signal,
      AbortSignal.timeout(HTTP_MS),
    ]);
    const cancel = () =>
      pending.reject(new Error("Public job/list observation cancelled or timed out"));
    signal.addEventListener("abort", cancel, { once: true });
    observations.set(id, pending.resolve);
    try {
      signal.throwIfAborted();
      socket.send(
        JSON.stringify({
          type: "open",
          streamId: id,
          endpoint: "job/list",
          payload: { args: { request: { sessionId } } },
        }),
      );
      const value = await pending.promise;
      healthy();
      return value;
    } finally {
      signal.removeEventListener("abort", cancel);
      observations.delete(id);
      retired.add(id);
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ type: "cancel", streamId: id }));
    }
  }
  /**
   * Owned host jobs of every session are terminal: each current RunJob host id is observed
   * ownerless as a `shud` job in one of `accepted`; any other owned job has ended.
   */
  async function jobsTerminal(
    sessionIds: string[],
    currentJobIds: string[],
    accepted: readonly string[],
  ): Promise<{ terminal: boolean; rosters: unknown[] }> {
    const expected = new Set(currentJobIds);
    const observed = new Set<string>();
    const rosters: unknown[] = [];
    let terminal = true;
    for (const sessionId of sessionIds) {
      const frame = object(await jobRoster(sessionId));
      requireFact(
        frame.type === "rows" && Array.isArray(frame.jobs),
        "Malformed public job roster",
      );
      const owned = frame.jobs
        .map(object)
        .filter(
          (job) =>
            job.owner === sessionId || (job.owner === undefined && expected.has(text(job.id))),
        );
      for (const job of owned) {
        const id = text(job.id),
          status = text(job.status);
        requireFact(
          ["running", "stopping", "completed", "killed", "failed"].includes(status),
          `Unknown job status ${id}`,
        );
        if (expected.has(id)) {
          requireFact(
            job.owner === undefined && job.kind === "shud",
            `RunJob registry identity ${id}`,
          );
          observed.add(id);
          terminal &&= accepted.includes(status);
        } else terminal &&= ["completed", "killed", "failed"].includes(status);
      }
      rosters.push({ sessionId, jobs: owned });
    }
    return { terminal: terminal && [...expected].every((id) => observed.has(id)), rosters };
  }
  async function close(): Promise<void> {
    closing = true;
    // Roster reads can stop immediately; already-posted approval results must still drain.
    rosterRequests.abort();
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
    requireFact(closed, `${label} approval stream cleanup failed`);
    socket.removeAllListeners();
    requests.abort();
    await chain;
    requireFact(!timedOut, `${label} approval request drain deadline`);
    if (failure) throw failure;
  }
  try {
    const deadline = Date.now() + HTTP_MS;
    while (!clientId && Date.now() < deadline) {
      healthy();
      await delay(50, undefined, { signal: host.abort });
    }
    requireFact(clientId, `${label} approval stream readiness deadline`);
    return { healthy, close, jobRoster, jobsTerminal };
  } catch (error) {
    try {
      await close();
    } catch {
      throw new Error(`${label} approval startup and cleanup failed`);
    }
    throw error;
  }
}
