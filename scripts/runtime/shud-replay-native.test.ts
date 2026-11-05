import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import { makeRunJob } from "../../packages/dsh-shud-records/src/task-lifecycle-test-harness.ts";
import { processStart } from "../../packages/dsh-shud-jobs/src/process-identity.ts";
import type { ShudProcessGroup } from "../../packages/dsh-shud-jobs/src/process-group.ts";
import { cleanupOwnedRuns, ownRunGroup, type NativeRunPolicy } from "./shud-web-driver.ts";

function nativeFixture() {
  const workspace = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "replay-owned-groups-")));
  const children: ChildProcess[] = [];
  const groups = new Map<number, ShudProcessGroup>();
  const owners = new Set(["worker-base", "worker-candidate"]);
  const policy: NativeRunPolicy = {
    minRuns: 0,
    maxRuns: 2,
    expectedArgv: (job) => [join(job.run_dir, "bin/shud"), "-o", "output/keliya.out", "keliya"],
  };
  async function start(index: number) {
    const job = makeRunJob(`JOB-20261102T090000-000${index}`, {
      project: "keliya",
      owner_session: index === 1 ? "worker-base" : "worker-candidate",
      run_dir: join(workspace, `runs/RUN-20261102T090000-000${index}`),
    });
    fs.mkdirSync(join(job.run_dir, "bin"), { recursive: true });
    const bin = join(job.run_dir, "bin/shud");
    fs.writeFileSync(bin, "#!/bin/sh\nexec sleep 60\n", { mode: 0o700 });
    job.command = [bin, "-o", "output/keliya.out", "keliya"];
    // This is a process-ownership fixture, not a solver or scientific run.
    const child = spawn(
      "/bin/sh",
      ["-c", 'printf "%s\\n" "$$" > wrapper.pid; exec "$@"', "wrapper", ...job.command],
      {
        cwd: job.run_dir,
        detached: true,
        stdio: "ignore",
      },
    );
    children.push(child);
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(join(job.run_dir, "wrapper.pid")) && Date.now() < deadline)
      await delay(10);
    if (!child.pid) throw new Error("Missing owned native fixture pid");
    const stamp = processStart(child.pid);
    if (!stamp) throw new Error("Missing native fixture birth identity");
    job.pid = child.pid;
    job.pid_started_at = new Date(`${stamp} UTC`).toISOString();
    fs.writeFileSync(join(job.run_dir, "run-job.json"), JSON.stringify(job));
    return job;
  }
  async function dispose() {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        const exit = once(child, "exit");
        child.kill("SIGKILL");
        await exit;
      }
    fs.rmSync(workspace, { recursive: true, force: true });
  }
  async function finish(pid: number) {
    const child = children.find((entry) => entry.pid === pid);
    if (!child) throw new Error("Not an owned fixture child");
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit");
      child.kill("SIGTERM");
      await exit;
    }
  }
  return { workspace, groups, owners, policy, start, finish, dispose };
}

test("captures and stops two freshly owned keliya groups only after host shutdown", async () => {
  const h = nativeFixture();
  try {
    const jobs = [await h.start(1), await h.start(2)];
    for (const job of jobs) expect(ownRunGroup(job, h.policy, h.owners, h.groups)).toBe(true);
    expect(h.groups.size).toBe(2);
    expect(await cleanupOwnedRuns(h.workspace, h.policy, h.owners, h.groups, false)).toEqual([
      "Solver cleanup withheld while a submission host may remain live",
    ]);
    expect([...h.groups.values()].every((group) => group.isGroupActive())).toBe(true);
    expect(await cleanupOwnedRuns(h.workspace, h.policy, h.owners, h.groups, true)).toEqual([]);
    expect([...h.groups.values()].every((group) => !group.isGroupActive())).toBe(true);
  } finally {
    await h.dispose();
  }
}, 20000);

test.each(["argv", "owner", "cwd", "wrapper", "birth"])(
  "refuses a live group with wrong %s without claiming ownership",
  async (kind) => {
    const h = nativeFixture();
    try {
      const original = await h.start(1),
        job = structuredClone(original);
      if (kind === "argv") job.command[3] = "ccw";
      if (kind === "owner") job.owner_session = "foreign-owner";
      if (kind === "cwd") {
        job.run_dir = h.workspace;
        job.command = [join(h.workspace, "bin/shud"), "-o", "output/keliya.out", "keliya"];
      }
      if (kind === "wrapper") fs.writeFileSync(join(job.run_dir, "wrapper.pid"), "1\n");
      if (kind === "birth") job.pid_started_at = "2000-01-01T00:00:00Z";
      expect(() => ownRunGroup(job, h.policy, h.owners, h.groups)).toThrow();
      expect(h.groups.size).toBe(0);
      expect(processStart(original.pid!)).not.toBeNull();
    } finally {
      await h.dispose();
    }
  },
);

test("retains historical uncertainty and preserves restart's explicit stopped-process sampler", async () => {
  const h = nativeFixture();
  try {
    const job = await h.start(1);
    const childPid = job.pid!;
    // No capability is captured before this native fixture ends.
    await h.finish(childPid);
    const errors = await cleanupOwnedRuns(h.workspace, h.policy, h.owners, h.groups, true);
    expect(errors.join(" ")).toContain("historical group quiescence unproved");
    expect(fs.existsSync(join(job.run_dir, "run-job.json"))).toBe(true);
    const sampled: string[] = [];
    expect(
      await cleanupOwnedRuns(
        h.workspace,
        { ...h.policy, minRuns: 1, maxRuns: 1 },
        h.owners,
        h.groups,
        true,
        (record) => {
          sampled.push(record.run_id);
          expect(processStart(record.pid!)).toBeNull();
        },
      ),
    ).toEqual([]);
    expect(sampled).toEqual([job.run_id]);
  } finally {
    await h.dispose();
  }
});

test("retains an unexpected third run instead of treating a partial discovery as success", async () => {
  const h = nativeFixture();
  try {
    await h.start(1);
    await h.start(2);
    await h.start(3);
    const errors = await cleanupOwnedRuns(h.workspace, h.policy, h.owners, h.groups, true);
    expect(errors.join(" ")).toContain("additional private runs");
    expect(fs.readdirSync(join(h.workspace, "runs"))).toHaveLength(3);
  } finally {
    await h.dispose();
  }
}, 20000);
