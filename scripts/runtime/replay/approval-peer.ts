import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer, type WebSocket } from "ws";
import { expect } from "vitest";
import { object, text } from "../shud-restart-evidence.ts";
import { data } from "../shud-evidence-events.ts";
import { WebHost } from "../shud-web-driver.ts";
import type { SessionLog } from "../shud-session-log.ts";

/** A canonical log cut immediately after the `approval/asked` for `callId`. */
export function pending(log: SessionLog, callId: string): SessionLog {
  const ask = log.events.find(
    (event) => event.type === "approval/asked" && data(event).callId === callId,
  );
  if (!ask) throw new Error("Missing constructed pending ask");
  return {
    ...log,
    events: log.events.slice(0, ask.seq + 1),
    asOfSeq: ask.seq,
    flushedThroughSeq: ask.seq,
  };
}

/** In-process public HTTP + remote.mux WS server; production clients run against it unchanged. */
export async function peer(
  prefix?: SessionLog,
  roster: (sessionId: string) => unknown[] = () => [],
  strict = false,
) {
  const published: Record<string, unknown>[] = [];
  const frames: Record<string, unknown>[] = [];
  let connections = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        const bytes: unknown = chunk;
        if (!(bytes instanceof Uint8Array)) throw new Error("Non-byte request");
        chunks.push(Buffer.from(bytes));
      }
      const envelope = object(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      const args = object(object(envelope.payload).args);
      let value: unknown = null;
      if (envelope.method === "$events/result") published.push(args);
      else if (prefix && envelope.method === "session/projections")
        value = { kind: "sequenced", asOfSeq: prefix.asOfSeq };
      else if (prefix && envelope.method === "session/page") {
        const input = object(args.request);
        const end = Number(input.beforeSeq),
          start = Math.max(0, end - 64);
        value = {
          records: prefix.events.slice(start, end).map((event) => ({ type: "event", event })),
          hasMore: start > 0,
        };
      } else throw new Error("Unexpected public request");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          type: "server-response",
          rpcId: envelope.rpcId,
          result: { ok: true, value },
        }),
      );
    })().catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  const websocket = new WebSocketServer({ server, path: "/api/remote.mux" });
  let client: WebSocket | undefined,
    streamId = "";
  websocket.on("connection", (socket) => {
    connections++;
    let rejected = false;
    client = socket;
    socket.on("message", (bytes) => {
      const buffer = Array.isArray(bytes)
        ? Buffer.concat(bytes)
        : bytes instanceof ArrayBuffer
          ? Buffer.from(bytes)
          : bytes;
      const frame = object(JSON.parse(buffer.toString("utf8")) as unknown);
      if (rejected) return;
      frames.push(frame);
      if (strict) {
        if (!["cancel", "end", "item", "open"].includes(text(frame.type))) {
          rejected = true;
          socket.close(1008, "Invalid stream frame");
          return;
        }
        if (frame.type !== "open") return;
      }
      if (frame.type === "close") return;
      if (frame.endpoint === "job/list") {
        const sessionId = text(object(object(object(frame.payload).args).request).sessionId);
        socket.send(
          JSON.stringify({
            type: "item",
            streamId: frame.streamId,
            value: { type: "rows", jobs: roster(sessionId) },
          }),
        );
      } else {
        streamId = text(frame.streamId);
        socket.send(
          JSON.stringify({
            type: "item",
            streamId,
            value: { type: "ready", clientId: "owned-peer" },
          }),
        );
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing peer address");
  // Exercise the real public HTTP client and WS transport; only the remote server is constructed.
  const host: WebHost = Object.assign(Object.create(WebHost.prototype) as WebHost, {
    origin: `http://127.0.0.1:${address.port}`,
    cookie: "",
    abort: new AbortController().signal,
    exited: false,
  });
  return {
    host,
    published,
    frames,
    connections() {
      return connections;
    },
    send(value: unknown) {
      if (!client) throw new Error("Peer not connected");
      client.send(JSON.stringify({ type: "item", streamId, value }));
    },
    async waitFor(count: number) {
      const deadline = Date.now() + 3000;
      while (published.length < count && Date.now() < deadline) await delay(10);
      expect(published).toHaveLength(count);
    },
    async dispose() {
      for (const socket of websocket.clients) socket.terminate();
      await new Promise<void>((resolve) => {
        websocket.close(() => resolve());
      });
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
