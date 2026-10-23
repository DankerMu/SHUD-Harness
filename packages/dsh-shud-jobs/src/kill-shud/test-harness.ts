import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vitest";
import { RunJobSchema } from "@shud-harness/dsh-shud-core";
import { readInvocation } from "../detached-shud/test-harness.ts";
import { type pollFixture, waitForEvidence } from "../poll-shud/test-harness.ts";

export async function readyRun(h: Awaited<ReturnType<typeof pollFixture>>) {
  const { producer, pending } = h.start();
  const record = await pending;
  if (record.pid === null || record.dsh_job_id === null) {
    throw new Error("Real submission has no execution or registration identity");
  }
  waitForEvidence(record.run_dir, "invocation.json");
  const invocation = await readInvocation(record.run_dir);
  if (!invocation) throw new Error("Actual fake SHUD did not publish an invocation");
  return { producer, record, id: producer.registration.handles[0].id, pid: record.pid, invocation };
}

export function readDurable(runDir: string) {
  return RunJobSchema.parse(JSON.parse(readFileSync(join(runDir, "run-job.json"), "utf8")));
}

export function observeSignals() {
  const events: Array<{ pid: number; signal: string | number }> = [];
  const native = process.kill.bind(process);
  const spy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (signal !== 0) events.push({ pid, signal: signal ?? "SIGTERM" });
    return native(pid, signal);
  });
  return { events, restore: () => spy.mockRestore() };
}

/** Release the real TCP-held solver and wait for its exit file without letting the host poll. */
export function releaseBeforePoll(runDir: string): void {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `
    const fs = require('node:fs');
    const net = require('node:net');
    const directory = process.argv[1];
    const receipt = JSON.parse(fs.readFileSync(directory + '/invocation.json', 'utf8'));
    if (!Number.isInteger(receipt.port)) throw new Error('Expected a held solver port');
    const deadline = setTimeout(() => { throw new Error('Solver release timed out'); }, 5000);
    const socket = net.createConnection(receipt.port, '127.0.0.1');
    socket.on('error', error => { throw error; });
    socket.on('connect', () => socket.write('release'));
    socket.on('data', () => {});
    socket.on('end', () => {
      const evidence = setInterval(() => {
        if (!fs.existsSync(directory + '/exit_code')) return;
        clearInterval(evidence);
        clearTimeout(deadline);
      }, 5);
    });
  `,
      runDir,
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  if (result.error || result.status !== 0) {
    throw new Error(`Natural-exit barrier failed: ${result.stderr}`, { cause: result.error });
  }
}
