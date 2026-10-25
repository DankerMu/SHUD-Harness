import { closeSync, constants, openSync, readFileSync, writeSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { JobHandle, JobOutcome } from "@deepseek-ai/dsh-jobs";
import { RunJobSchema, type RunJob } from "@shud-harness/dsh-shud-core";
import {
  ShudJobRegistry,
  startDetachedShud,
  type ShudExecution,
  type ShudLifecycle,
} from "../index.ts";
import { createHarness, installScriptFixture } from "../test-harness.ts";
import { captureCleanupFailure, cleanupDiagnostic } from "../cleanup-diagnostics.ts";

export async function writeInputTree(
  inputDir: string,
  parameter = "# synthetic input\r\nSTART\t0\r\nEND\t7\r\nOTHER\t17\r\n",
  marker = "original forcing bytes\n",
) {
  const files = {
    "tiny.cfg.para": Buffer.from(parameter),
    "nested/forcing.dat": Buffer.from(marker),
    "binary.dat": Buffer.from([0, 255, 1, 128, 10]),
  };
  await mkdir(join(inputDir, "nested", "empty"), { recursive: true });
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(inputDir, name), bytes);
  return files;
}

export async function submissionFixture(
  parameter?: string,
  execution: "held" | "immediate" = "held",
  sessionController: "available" | "absent" = "absent",
) {
  // Submission/lifecycle fixtures retain pending notifications unless delivery is under test.
  const h = await createHarness(undefined, sessionController);
  try {
    if (execution === "held") {
      // Keep running/output assertions independent of the online settlement cadence, without log noise.
      // The real TCP barrier can exit naturally; existing producer cleanup aborts its owned group.
      const node = process.execPath.replaceAll("'", "'\\''");
      await installScriptFixture(
        h.shudBin,
        `#!/bin/sh\nexec '${node}' -e '
        const fs = require("node:fs");
        const server = require("node:net").createServer(socket => {
          socket.end("released");
          server.close(() => process.exit(0));
        });
        server.listen(0, "127.0.0.1", () => {
          fs.writeFileSync("submission-barrier.json", JSON.stringify({ port: server.address().port }));
        });
      '\n`,
      );
    }
    const inputDir = join(h.root, "input");
    const originals = await writeInputTree(inputDir, parameter);
    const llm = {
      response_model: "explicit-test-model",
      response_model_source: "configured",
    } satisfies RunJob["llm"];
    return {
      ...h,
      inputDir,
      originals,
      request: {
        cwd: h.cwd,
        input_dir: inputDir,
        project: "tiny",
        owner_session: h.ownerId,
        llm,
      },
    };
  } catch (error) {
    await h.dispose();
    throw error;
  }
}

export function actualRegistry(ctx: Context) {
  const registry = ctx.jobs;
  if (!(registry instanceof ShudJobRegistry)) throw new Error("SHUD registry not published");
  return registry;
}

export async function injectedRegistry(ctx: Context) {
  let registry: ShudJobRegistry | undefined;
  await ctx.plugin({
    inject: ["jobs"],
    apply(consumer: Context) {
      registry = actualRegistry(consumer);
    },
  });
  if (!registry) throw new Error("SHUD consumer did not activate");
  return registry;
}

/** Registration resource only: process execution and quiescence have a separate owner. */
export function registrationResource() {
  let resolveDone!: (outcome: JobOutcome) => void;
  const done = new Promise<JobOutcome>((resolve) => {
    resolveDone = resolve;
  });
  let fd: number | undefined;
  const handles: JobHandle[] = [];
  const prepared: RunJob[] = [];
  const persistedAtStart: RunJob[] = [];
  const cancellations: Array<string | undefined> = [];
  function finish(outcome: JobOutcome = { status: "killed", detail: "test cleanup" }) {
    if (fd !== undefined) {
      closeSync(fd);
      fd = undefined;
    }
    resolveDone(outcome);
  }
  return {
    handles,
    prepared,
    persistedAtStart,
    cancellations,
    finish,
    open: (record: RunJob, handle: JobHandle): ShudLifecycle => {
      if (handles.length > 0) throw new Error("test producer was registered more than once");
      prepared.push(RunJobSchema.parse(record));
      persistedAtStart.push(
        RunJobSchema.parse(JSON.parse(readFileSync(join(record.run_dir, "run-job.json"), "utf8"))),
      );
      // Do not create missing logs: those are part of the registry's preparation contract.
      if (readFileSync(join(record.run_dir, "stdout.log")).length !== 0)
        throw new Error("stdout was not empty before registration");
      if (readFileSync(join(record.run_dir, "stderr.log")).length !== 0)
        throw new Error("stderr was not empty before registration");
      fd = openSync(join(record.run_dir, "stdout.log"), constants.O_WRONLY | constants.O_APPEND);
      handles.push(handle);
      return {
        done,
        settle: finish,
        detach(detail) {
          finish({ status: "failed", detail });
        },
        cancel(reason) {
          cancellations.push(reason);
          finish({ status: "killed", detail: reason });
        },
      };
    },
    append: (bytes: string | Buffer) => {
      if (fd === undefined) throw new Error("test producer has no live output descriptor");
      if (typeof bytes === "string") writeSync(fd, bytes);
      else writeSync(fd, bytes);
    },
  };
}

/** Every submitted fixture uses the actual detached component, with the registry's resolved cadence. */
export function submissionProducer() {
  const registration = registrationResource();
  const executions: ShudExecution[] = [];
  const identities = new Set<number>();
  return {
    handles: registration.handles,
    prepared: registration.prepared,
    persistedAtStart: registration.persistedAtStart,
    cancellations: registration.cancellations,
    append: registration.append,
    executions,
    start: (record: RunJob, handle: JobHandle, pumpPollMs: number): ShudExecution => {
      const execution = startDetachedShud(record, registration.open(record, handle), pumpPollMs);
      executions.push(execution);
      void execution.started.then(
        (identity) => identities.add(identity.pid),
        () => undefined,
      );
      return execution;
    },
    async finish() {
      const failures: unknown[] = [];
      for (const execution of executions) {
        try {
          await execution.abort();
        } catch (error) {
          failures.push(captureCleanupFailure(error, identities));
        }
      }
      try {
        registration.finish();
      } catch (error) {
        failures.push(captureCleanupFailure(error, identities));
      }
      if (failures.length)
        throw cleanupDiagnostic("Submission fixture execution cleanup failed", failures);
    },
  };
}
