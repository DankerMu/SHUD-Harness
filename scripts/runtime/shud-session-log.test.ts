import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { zstdCompressSync } from "node:zlib";
import { expect, test } from "vitest";
import { readLog } from "./shud-session-log.ts";
import { collectReplayLogs } from "./shud-replay-snapshot.ts";
import { WebHost } from "./shud-web-driver.ts";

function fixture() {
  const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "canonical-replay-")));
  const id = "session-fixture";
  const directory = join(home, "sessions/project", id);
  fs.mkdirSync(directory, { recursive: true });
  const header = { type: "session", version: 4, id, createdAt: 1, isSeeded: false };
  const event = { type: "turn/start", seq: 0, time: 2, data: { turn: 1 } };
  const path = join(directory, "session.v4.jsonl.zstd");
  return { home, id, path, header, event };
}

test("reads every concatenated zstd frame and preserves canonical identity and dense sequences", () => {
  const h = fixture();
  try {
    const first = `${JSON.stringify(h.header)}\n`,
      second = `${JSON.stringify(h.event)}\n`;
    fs.writeFileSync(h.path, Buffer.concat([zstdCompressSync(first), zstdCompressSync(second)]));
    expect(readLog(h.home, h.id)).toEqual({
      header: h.header,
      events: [h.event],
      asOfSeq: 0,
      flushedThroughSeq: -1,
      canonicalLog: h.path,
      byteLength: Buffer.byteLength(first + second),
    });
  } finally {
    fs.rmSync(h.home, { recursive: true, force: true });
  }
});

test.each([
  "foreign-id",
  "old-version",
  "sparse-sequence",
  "malformed-json",
  "expansion",
  "secret",
  "symlink",
])("rejects %s canonical evidence", (kind) => {
  const h = fixture();
  try {
    const header = {
      ...h.header,
      ...(kind === "foreign-id" ? { id: "session-other" } : {}),
      ...(kind === "old-version" ? { version: 3 } : {}),
    };
    const event = {
      ...h.event,
      seq: kind === "sparse-sequence" ? 1 : 0,
      data: kind === "secret" ? { text: "DMXAPI_KEY=constructed-only" } : h.event.data,
    };
    let bytes = `${JSON.stringify(header)}\n${JSON.stringify(event)}\n`;
    if (kind === "malformed-json") bytes += "{broken\n";
    if (kind === "expansion") bytes += "x".repeat(10000);
    fs.writeFileSync(h.path, zstdCompressSync(bytes));
    if (kind === "symlink") {
      const outside = join(h.home, "outside.zstd");
      fs.renameSync(h.path, outside);
      fs.symlinkSync(outside, h.path);
    }
    expect(() => readLog(h.home, h.id, kind === "expansion" ? 1024 : undefined)).toThrow();
  } finally {
    fs.rmSync(h.home, { recursive: true, force: true });
  }
});

test("flushes each actual child through the public export barrier rather than only the root", async () => {
  const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "canonical-flush-")));
  const flushed: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    const id = url.searchParams.get("sessionId")!;
    flushed.push(id);
    const directory = join(home, "sessions/project", id);
    fs.mkdirSync(directory, { recursive: true });
    const header = { type: "session", version: 4, id, createdAt: 1, isSeeded: false };
    const events =
      id === "session-root"
        ? [{ type: "subagent/catalog", seq: 0, time: 2, data: { childId: "session-child" } }]
        : [];
    fs.writeFileSync(
      join(directory, "session.v4.jsonl.zstd"),
      zstdCompressSync([header, ...events].map((row) => JSON.stringify(row)).join("\n") + "\n"),
    );
    response.writeHead(200);
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");
    // Network-only host boundary: exercise the actual WebHost.flush implementation, no host spawn.
    const host = Object.assign(Object.create(WebHost.prototype) as WebHost, {
      origin: `http://127.0.0.1:${address.port}`,
      cookie: "",
      abort: new AbortController().signal,
    });
    const logs = await collectReplayLogs(home, "session-root", host);
    expect(flushed).toEqual(["session-root", "session-child"]);
    expect(logs.root.flushedThroughSeq).toBe(0);
    expect(logs.children[0].header.id).toBe("session-child");
    expect(logs.children[0].flushedThroughSeq).toBe(-1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
