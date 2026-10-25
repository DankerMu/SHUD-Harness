import { access } from "node:fs/promises";
import type * as NodeChild from "node:child_process";
import { expect, test, vi } from "vitest";
import type { ShudExecution } from "./index.ts";
import {
  activeGroup,
  cleanupResources,
  detachedProducer,
  terminateGroup,
} from "./detached-shud/test-harness.ts";
import { submissionProducer } from "./submit-shud/test-harness.ts";
import { pollFixture, settlingProducer } from "./poll-shud/test-harness.ts";

const fault = vi.hoisted(() => ({ groupInspection: false }));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof NodeChild>();
  return {
    ...actual,
    spawnSync(command: string, args: readonly string[], options: NodeChild.SpawnSyncOptions) {
      if (fault.groupInspection && command === "ps" && args[0] === "-axo") {
        fault.groupInspection = false;
        return { pid: 0, output: [], stdout: "", stderr: "", status: 0, signal: null };
      }
      return actual.spawnSync(command, args, options);
    },
  };
});

test.each(["detached", "submission", "settlement"])(
  "%s cleanup exposes nested abort evidence and finishes registration after abort",
  async (surface) => {
    const h = await pollFixture();
    const producer =
      surface === "detached"
        ? detachedProducer()
        : surface === "submission"
          ? submissionProducer()
          : settlingProducer();
    const finish = () => ("cleanup" in producer ? producer.cleanup() : producer.finish());
    let native: ShudExecution | undefined;
    let originalAbort: ShudExecution["abort"] | undefined;
    let pid: number | undefined;
    try {
      const record = await h.registry.submitShud(h.request, (...args) => {
        native = producer.start(...args);
        return native;
      });
      if (!native || record.pid === null) throw new Error("No native cleanup fixture identity");
      pid = record.pid;
      const events: string[] = [];
      const done = native.hooks.done.then(() => {
        events.push("done");
      });
      const cause = new Error("native abort nested cause");
      const inner = new Error("native abort inner failure", { cause });
      const sibling = new Error("native abort sibling failure");
      const abort = native.abort.bind(native);
      originalAbort = abort;
      native.abort = async () => {
        events.push("abort");
        await abort();
        throw new AggregateError([inner, sibling], "native abort aggregate");
      };
      const failure: unknown = await finish().catch((error: unknown) => error);
      await done;
      expect(events).toEqual(["abort", "done"]);
      expect(failure).toBeInstanceOf(Error);
      if (!(failure instanceof Error)) throw new Error("Missing native cleanup evidence");
      for (const original of [inner, cause, sibling]) {
        expect(failure.message).toContain(original.message);
        expect(failure.message).toContain(original.stack?.split("\n")[1]?.trim());
      }
      expect(failure.message).toContain(`pid=${pid} pgid=${pid}`);
      expect(failure.message).toContain("ps pid pgid stat");
      expect(activeGroup(pid)).toEqual([]);
    } finally {
      if (native && originalAbort) native.abort = originalAbort;
      if (pid !== undefined) await terminateGroup(pid);
      await cleanupResources([finish, () => h.close()]);
    }
  },
  15000,
);

test("poll close retains a failed group check, continues abort/done, then disposes ownership", async () => {
  const h = await pollFixture();
  const { producer, pending } = h.start();
  let originalAbort: ShudExecution["abort"] | undefined;
  let native: ShudExecution | undefined;
  let pid: number | undefined;
  let closed = false;
  try {
    const record = await pending;
    if (record.pid === null) throw new Error("No polling fixture identity");
    pid = record.pid;
    native = producer.executions[0];
    const abort = native.abort.bind(native);
    originalAbort = abort;
    const events: string[] = [];
    native.abort = async () => {
      events.push("abort");
      await abort();
    };
    const done = native.hooks.done.then(() => {
      events.push("done");
    });
    fault.groupInspection = true;
    const failure: unknown = await h.close().catch((error: unknown) => error);
    await done;
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error("Polling cleanup swallowed group failure");
    expect(failure.message).toContain("Cannot independently inspect owned test process group");
    expect(failure.message).toContain(`pid=${pid} pgid=${pid}`);
    // The failure-time snapshot precedes abort and therefore still contains the live wrapper row.
    expect(failure.message).toMatch(new RegExp(`\\b${pid}\\s+${pid}\\s+[^Z\\s]`, "u"));
    expect(events).toEqual(["abort", "done"]);
    expect(activeGroup(pid)).toEqual([]);
    await expect(access(h.root)).rejects.toMatchObject({ code: "ENOENT" });
    closed = true;
  } finally {
    fault.groupInspection = false;
    if (native && originalAbort) native.abort = originalAbort;
    if (pid !== undefined) await terminateGroup(pid);
    if (!closed) await h.close();
  }
}, 15000);
