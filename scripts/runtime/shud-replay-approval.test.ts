import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import { pending, peer } from "./replay/approval-peer.ts";
import { makeReplayFixture } from "./replay/test-harness.ts";
import { object } from "./shud-restart-evidence.ts";
import { data } from "./shud-evidence-events.ts";
import { openOwnedApprovals } from "./shud-approval-transport.ts";
import { openReplayApprovals, replayApprovalState } from "./shud-replay-approval.ts";
import { openReportApprovals } from "./shud-first-task-approval.ts";
import type { ReplayEvidence } from "./shud-replay-evidence.ts";

function approvalFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "replay-approval-")));
  const original = makeReplayFixture();
  // Relocate constructed paths as data; never replace a production collaborator.
  const snapshot = JSON.parse(
    JSON.stringify(original.snapshot).replaceAll("/fixture/replay workspace", root),
  ) as ReplayEvidence;
  const changePath = join(root, `changes/${original.change.change_id}.json`);
  const reportPath = join(root, `reports/${original.report.report_id}.json`);
  for (const path of [changePath, reportPath, join(root, original.change.patch_path)])
    fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(
    changePath,
    JSON.stringify({
      ...original.change,
      status: "proposed",
      approval_ref: null,
      approved_at: null,
    }),
  );
  fs.writeFileSync(join(root, original.change.patch_path), "abc");
  fs.writeFileSync(
    reportPath,
    JSON.stringify({ ...original.report, status: "reviewed", decision_history: [] }),
  );
  const coder = snapshot.children.find((child) => child.header.id === "coder-base")!;
  const changeRoot = structuredClone(snapshot.root);
  const dispatchResult = changeRoot.events.find(
    (event) =>
      event.type === "tool/result" &&
      object(data(event).message).toolCallId === "dispatch-coder-base",
  )!;
  changeRoot.events = changeRoot.events.slice(0, dispatchResult.seq + 1);
  changeRoot.asOfSeq = dispatchResult.seq;
  changeRoot.flushedThroughSeq = dispatchResult.seq;
  let current = { root: changeRoot, children: [pending(coder, "call-change-submit")] };
  const state = replayApprovalState("replay-root", root, () => Promise.resolve(current));
  return {
    root,
    snapshot,
    state,
    changePath,
    reportPath,
    logs() {
      return current;
    },
    report() {
      current = { root: pending(snapshot.root, "call-report-submit"), children: snapshot.children };
    },
    changeRequest: {
      event: "approval/request",
      agentId: "coder-base",
      request: {
        toolName: "change_submit",
        callId: "call-change-submit",
        reason: `PI approval required for change ${original.change.change_id}`,
      },
    },
    reportRequest: {
      event: "approval/request",
      agentId: "replay-root",
      request: {
        toolName: "report_submit",
        callId: "call-report-submit",
        reason: `PI approval required for report ${original.report.report_id}`,
      },
    },
    dispose() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("answers exactly one owned coder change and root report on the original peer through real WS/HTTP", async () => {
  const h = approvalFixture(),
    remote = await peer();
  let close: (() => Promise<void>) | undefined;
  try {
    const transport = await openOwnedApprovals(remote.host, h.state.authorize, {
      streamId: "replay-test",
      healthy: h.state.healthy,
    });
    close = transport.close;
    // Public emit frames are not waterfall requests and must remain harmless.
    remote.send({ type: "emit", event: "session/event", args: {} });
    remote.send({ type: "waterfall", eventId: "event-change", ...h.changeRequest });
    await remote.waitFor(1);
    h.report();
    remote.send({ type: "waterfall", eventId: "event-report", ...h.reportRequest });
    await remote.waitFor(2);
    expect(remote.published).toEqual([
      {
        clientId: "owned-peer",
        eventId: "event-change",
        outcome: { kind: "result", value: "allowed-once" },
      },
      {
        clientId: "owned-peer",
        eventId: "event-report",
        outcome: { kind: "result", value: "allowed-once" },
      },
    ]);
    transport.healthy();
  } finally {
    try {
      await close?.();
    } finally {
      await remote.dispose();
      h.dispose();
    }
  }
});

test.each(["unknown", "reviewer"])(
  "does not grant an owned change request attributed to %s through real WS/HTTP",
  async (createdBy) => {
    const h = approvalFixture();
    const remote = await peer();
    let close: (() => Promise<void>) | undefined;
    let rejected = false;
    try {
      const proposed = JSON.stringify({
        ...object(JSON.parse(fs.readFileSync(h.changePath, "utf8")) as unknown),
        created_by: createdBy,
      });
      fs.writeFileSync(h.changePath, proposed);
      const transport = await openOwnedApprovals(remote.host, h.state.authorize, {
        streamId: "creator-binding-test",
        healthy: h.state.healthy,
      });
      close = transport.close;
      remote.send({ type: "waterfall", eventId: "creator-mismatch", ...h.changeRequest });
      // Wait for rejection or actual publication, never close early enough to
      // suppress an erroneous grant that is still being processed.
      await expect
        .poll(() => {
          try {
            h.state.healthy();
          } catch {
            rejected = true;
          }
          return rejected || remote.published.length > 0;
        })
        .toBe(true);
      expect(remote.published.map((entry) => entry.outcome)).not.toContainEqual({
        kind: "result",
        value: "allowed-once",
      });
      expect(rejected).toBe(true);
      expect(fs.readFileSync(h.changePath, "utf8")).toBe(proposed);
      expect(JSON.parse(proposed) as unknown).toMatchObject({
        status: "proposed",
        approval_ref: null,
        approved_at: null,
        created_by: createdBy,
      });
    } finally {
      try {
        if (close) {
          if (rejected) await expect(close()).rejects.toThrow();
          else await close();
        }
      } finally {
        await remote.dispose();
        h.dispose();
      }
    }
  },
);

test("successive roster cancellations preserve the same strict WS peer and owned approval handler", async () => {
  const h = approvalFixture();
  const remote = await peer(
    undefined,
    (sessionId) => [{ id: `job-${sessionId}`, status: "completed" }],
    true,
  );
  let close: (() => Promise<void>) | undefined;
  try {
    const transport = await openOwnedApprovals(remote.host, h.state.authorize, {
      streamId: "strict-roster-test",
      healthy: h.state.healthy,
    });
    close = transport.close;
    expect(await transport.jobRoster("replay-root")).toEqual({
      type: "rows",
      jobs: [{ id: "job-replay-root", status: "completed" }],
    });
    expect(await transport.jobRoster("coder-base")).toEqual({
      type: "rows",
      jobs: [{ id: "job-coder-base", status: "completed" }],
    });
    // Observe cancellation at the remote boundary before issuing the approval.
    await expect
      .poll(() => remote.frames.filter((frame) => frame.type === "cancel"))
      .toHaveLength(2);
    const rosterStreams = remote.frames.filter(
      (frame) => frame.type === "open" && frame.endpoint === "job/list",
    );
    expect(rosterStreams).toHaveLength(2);
    expect(new Set(rosterStreams.map((frame) => frame.streamId)).size).toBe(2);
    expect(
      remote.frames.filter((frame) => frame.type === "cancel").map((frame) => frame.streamId),
    ).toEqual(rosterStreams.map((frame) => frame.streamId));
    remote.send({ type: "waterfall", eventId: "after-rosters", ...h.changeRequest });
    await remote.waitFor(1);
    expect(remote.published).toEqual([
      {
        clientId: "owned-peer",
        eventId: "after-rosters",
        outcome: { kind: "result", value: "allowed-once" },
      },
    ]);
    expect(remote.connections()).toBe(1);
    transport.healthy();
  } finally {
    try {
      await close?.();
    } finally {
      await remote.dispose();
      h.dispose();
    }
  }
});

test.each(["caller", "call", "reason", "record", "patch"])(
  "refuses mismatched %s approval evidence without a grant",
  async (kind) => {
    const h = approvalFixture();
    try {
      const request = structuredClone(h.changeRequest);
      if (kind === "caller") request.agentId = "foreign-session";
      if (kind === "call") request.request.callId = "foreign-call";
      if (kind === "reason") request.request.reason = "different business record";
      if (kind === "record")
        fs.writeFileSync(
          h.changePath,
          JSON.stringify({
            ...makeReplayFixture().change,
            status: "proposed",
            approval_ref: null,
            approved_at: null,
            task_id: "TASK-20261102T090000-ffff",
          }),
        );
      if (kind === "patch")
        fs.writeFileSync(join(h.root, makeReplayFixture().change.patch_path), "hello");
      await expect(h.state.authorize(request, new AbortController().signal)).rejects.toThrow();
      expect(() => h.state.healthy()).toThrow();
    } finally {
      h.dispose();
    }
  },
);

test("cancellation received during authorization prevents publication", async () => {
  const remote = await peer();
  let resolveEntered!: () => void;
  let resolveRelease!: (allowed: boolean) => void;
  const entered = new Promise<void>((resolve) => {
    resolveEntered = resolve;
  });
  const release = new Promise<boolean>((resolve) => {
    resolveRelease = resolve;
  });
  let close: (() => Promise<void>) | undefined;
  try {
    const transport = await openOwnedApprovals(
      remote.host,
      () => {
        resolveEntered();
        return release;
      },
      { streamId: "cancel-test" },
    );
    close = transport.close;
    remote.send({
      type: "waterfall",
      eventId: "cancelled-event",
      event: "approval/request",
      agentId: "owned",
      request: {},
    });
    await entered;
    remote.send({ type: "cancel", eventId: "cancelled-event" });
    await delay(30);
    resolveRelease(true);
    await delay(30);
    expect(remote.published).toEqual([]);
    transport.healthy();
  } finally {
    resolveRelease(false);
    try {
      await close?.();
    } finally {
      await remote.dispose();
    }
  }
});

test("duplicate waterfall invocation fails closed rather than granting twice", async () => {
  const remote = await peer();
  let close: (() => Promise<void>) | undefined;
  try {
    const transport = await openOwnedApprovals(remote.host, () => Promise.resolve(true), {
      streamId: "duplicate-test",
    });
    close = transport.close;
    const event = {
      type: "waterfall",
      eventId: "duplicate",
      event: "approval/request",
      agentId: "owned",
      request: {},
    };
    remote.send(event);
    await remote.waitFor(1);
    remote.send(event);
    await delay(30);
    expect(() => transport.healthy()).toThrow();
    expect(remote.published).toHaveLength(1);
  } finally {
    try {
      if (close) await expect(close()).rejects.toThrow();
    } finally {
      await remote.dispose();
    }
  }
});

test("first-task keeps report-only authorization on the shared public transport", async () => {
  const h = approvalFixture();
  const remote = await peer(pending(h.snapshot.root, "call-report-submit"));
  let close: (() => Promise<void>) | undefined;
  try {
    const transport = await openReportApprovals(remote.host, "replay-root", h.root);
    close = transport.close;
    remote.send({ type: "waterfall", eventId: "child-change", ...h.changeRequest });
    await remote.waitFor(1);
    remote.send({ type: "waterfall", eventId: "root-report", ...h.reportRequest });
    await remote.waitFor(2);
    expect(remote.published.map((entry) => entry.outcome)).toEqual([
      { kind: "next" },
      { kind: "result", value: "allowed-once" },
    ]);
  } finally {
    try {
      await close?.();
    } finally {
      await remote.dispose();
      h.dispose();
    }
  }
});

test("waits for current ownerless SHUD ids and owned child jobs, ignoring unrelated global jobs", async () => {
  const h = approvalFixture();
  let childStatus = "running",
    shudStatus = "running";
  const remote = await peer(undefined, (sessionId) => [
    { id: "shud-current", kind: "shud", status: shudStatus },
    { id: "shud-unrelated", kind: "shud", status: "running" },
    ...(sessionId === "coder-base"
      ? [{ id: "bash-owned", kind: "bash", owner: sessionId, status: childStatus }]
      : []),
  ]);
  let close: (() => Promise<void>) | undefined;
  try {
    const transport = await openReplayApprovals(
      remote.host,
      h.snapshot.home,
      "replay-root",
      h.root,
    );
    close = transport.close;
    expect(
      (await transport.jobsTerminal(["replay-root", "coder-base"], ["shud-current"])).terminal,
    ).toBe(false);
    shudStatus = "completed";
    expect(
      (await transport.jobsTerminal(["replay-root", "coder-base"], ["shud-current"])).terminal,
    ).toBe(false);
    childStatus = "completed";
    const result = await transport.jobsTerminal(["replay-root", "coder-base"], ["shud-current"]);
    expect(result.terminal).toBe(true);
    expect(JSON.stringify(result.rosters)).not.toContain("shud-unrelated");
    expect((await transport.jobsTerminal(["replay-root"], ["shud-missing"])).terminal).toBe(false);
    expect(remote.published).toEqual([]);
  } finally {
    try {
      await close?.();
    } finally {
      await remote.dispose();
      h.dispose();
    }
  }
});

test.each(["unavailable", "cancelled", "rejected"])(
  "never grants an already %s invocation",
  async (outcome) => {
    const h = approvalFixture();
    try {
      const child = h.logs().children[0];
      child.events.push({
        type: "approval/decided",
        seq: child.events.length,
        time: child.events.at(-1)!.time + 1,
        data: { id: "ask-change", outcome },
      });
      child.asOfSeq = child.events.length - 1;
      child.flushedThroughSeq = child.asOfSeq;
      await expect(
        h.state.authorize(h.changeRequest, new AbortController().signal),
      ).rejects.toThrow("already decided");
    } finally {
      h.dispose();
    }
  },
);
