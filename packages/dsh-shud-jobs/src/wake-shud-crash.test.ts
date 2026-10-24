import * as io from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { RunJobSchema, RunRecordSchema } from "@shud-harness/dsh-shud-core";
import {
  activeGroup,
  cleanupResources,
  readInvocation,
  releaseInvocation,
  terminateGroup,
} from "./detached-shud/test-harness.ts";
import { persisted } from "./state-indexes/test-harness.ts";
import { submissionFixture } from "./submit-shud/test-harness.ts";
import {
  createWakeCrashHost,
  installCrashSolver,
  type WakeCrashHost,
} from "./wake-shud-crash/test-harness.ts";

test.each(["flush-window", "running"] as const)(
  "actual host SIGKILL during %s recovers in a fresh process without respawning native SHUD",
  async (scenario) => {
    const h = await submissionFixture();
    const hosts: WakeCrashHost[] = [];
    let wrapperPid: number | undefined;
    try {
      await installCrashSolver(h.shudBin);
      const directory = join(h.root, "crash-observations");
      await io.mkdir(directory);
      const input = {
        config: { ...h.config, pumpPollMs: 7 },
        request: h.request,
        directory,
        scenario,
      };
      const first = createWakeCrashHost({ ...input, phase: "submit" });
      hosts.push(first);
      const submitted = RunJobSchema.parse(JSON.parse(await first.file("submitted.json")));
      expect(submitted.status).toBe("running");
      expect(submitted.job_id).toEqual(expect.any(String));
      if (submitted.pid === null || submitted.dsh_job_id === null)
        throw new Error(
          "The first host did not publish genuine execution and registration identities",
        );
      wrapperPid = submitted.pid;
      const invocation = await readInvocation(submitted.run_dir);
      if (!invocation) throw new Error("The native solver did not publish its held invocation");
      expect(invocation.ppid).toBe(wrapperPid);
      expect(activeGroup(wrapperPid)).toContain(invocation.pid);
      const invocationPath = join(submitted.run_dir, "invocation.json");
      const invocationBytes = await io.readFile(invocationPath);
      const invocationMtime = (await io.stat(invocationPath, { bigint: true })).mtimeNs;
      const resultPath = join(submitted.run_dir, "run-record.json");
      let immutableResult: Buffer | undefined;
      let immutableMtime: bigint | undefined;
      if (scenario === "flush-window") {
        await releaseInvocation(invocation);
        expect(JSON.parse(await first.file("pre-marker.json"))).toEqual({ host: first.pid });
        expect(JSON.parse(await first.file(`flush-${first.pid}.json`))).toEqual({
          host: first.pid,
          acknowledged: true,
        });
        const pending = RunJobSchema.parse(
          JSON.parse(await io.readFile(join(submitted.run_dir, "run-job.json"), "utf8")),
        );
        expect(pending).toMatchObject({
          status: "collected",
          notify: { status: "pending", attempts: 0 },
        });
        immutableResult = await io.readFile(resultPath);
        immutableMtime = (await io.stat(resultPath, { bigint: true })).mtimeNs;
      }
      expect(await first.kill()).toMatchObject({ signal: "SIGKILL" });
      if (scenario === "running") {
        expect(activeGroup(wrapperPid)).toContain(wrapperPid);
        expect(activeGroup(wrapperPid)).toContain(invocation.pid);
      }
      const second = createWakeCrashHost({ ...input, phase: "recover", record: submitted });
      hosts.push(second);
      expect(second.pid).not.toBe(first.pid);
      const recovered = RunJobSchema.parse(JSON.parse(await second.file("recovered.json")));
      expect(recovered).toMatchObject({
        run_id: submitted.run_id,
        job_id: submitted.job_id,
        pid: submitted.pid,
        pid_started_at: submitted.pid_started_at,
      });
      if (scenario === "running") {
        expect(recovered.status).toBe("running");
        expect(recovered.dsh_job_id).not.toBe(submitted.dsh_job_id);
        expect(recovered.dsh_job_ids).toEqual([submitted.dsh_job_id, recovered.dsh_job_id]);
        expect(activeGroup(wrapperPid)).toContain(invocation.pid);
        await releaseInvocation(invocation);
      }
      const final = RunJobSchema.parse(JSON.parse(await second.file("finished.json")));
      expect(await second.exited()).toEqual({ code: 0, signal: null });
      expect(
        RunJobSchema.parse(
          JSON.parse(await io.readFile(join(submitted.run_dir, "run-job.json"), "utf8")),
        ),
      ).toEqual(final);
      // D12: durable state advances, one immutable outcome exists, the original native invocation
      // is the only one, notification finishes, and completed/active indexes converge.
      expect(final).toMatchObject({
        run_id: submitted.run_id,
        job_id: submitted.job_id,
        status: "collected",
        pid: submitted.pid,
        pid_started_at: submitted.pid_started_at,
        exit_code: 0,
        notify: { status: "delivered", attempts: 0 },
      });
      const result = RunRecordSchema.parse(JSON.parse(await io.readFile(resultPath, "utf8")));
      expect(result).toMatchObject({
        run_id: submitted.run_id,
        job_id: submitted.job_id,
        exit_code: 0,
        exit_class: "ok",
        artifacts: { files: [{ path: "flow.dat", size_bytes: 5 }] },
      });
      expect(await io.readFile(join(submitted.run_dir, "invocations"), "utf8")).toBe("invoked\n");
      expect(await io.readFile(invocationPath)).toEqual(invocationBytes);
      expect((await io.stat(invocationPath, { bigint: true })).mtimeNs).toBe(invocationMtime);
      expect(activeGroup(wrapperPid)).toEqual([]);
      const events = (await io.readFile(join(directory, "wake-events.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line): unknown => JSON.parse(line));
      expect(events).toHaveLength(scenario === "flush-window" ? 2 : 1);
      for (const event of events) {
        expect(event).toMatchObject({
          message: {
            role: "user",
            source: { kind: "shud-jobs" },
          },
        });
        expect(event).toHaveProperty("message.id", expect.any(String));
        expect(JSON.stringify(event)).toContain(submitted.run_id);
      }
      for (const host of hosts)
        expect(
          JSON.parse(await io.readFile(join(directory, `session-events-${host.pid}.json`), "utf8")),
        ).toEqual([]);
      const entry = {
        run_id: submitted.run_id,
        job_id: submitted.job_id,
        run_dir: submitted.run_dir,
      };
      expect(await persisted(h.stateDir)).toEqual([]);
      expect(await persisted(h.stateDir, "completed.json")).toEqual([entry]);
      if (immutableResult) {
        expect(await io.readFile(resultPath)).toEqual(immutableResult);
        expect((await io.stat(resultPath, { bigint: true })).mtimeNs).toBe(immutableMtime);
      }
    } finally {
      await cleanupResources([
        ...hosts.map((host) => () => host.stop()),
        async () => {
          if (wrapperPid !== undefined) await terminateGroup(wrapperPid);
        },
        () => h.dispose(),
      ]);
    }
  },
  15000,
);
