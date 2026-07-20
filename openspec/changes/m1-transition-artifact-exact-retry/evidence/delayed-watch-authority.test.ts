import { expect, test } from "bun:test";
import fsDefault, {
  promises as fsNamedPromises,
  unwatchFile,
  watch as fsNamedWatch,
  watchFile as fsNamedWatchFile
} from "node:fs";
import * as fsNamespace from "node:fs";
import { createRequire } from "node:module";
import fsPromisesDefault, {
  watch as fsPromisesNamedWatch
} from "node:fs/promises";
import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import * as fsPromisesNamespace from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  CALLBACK_DELAY_MS,
  type DelayedWatchEvent,
  type DelayedWatchRegistration
} from "./delay-watch-preload";

const globals = globalThis as typeof globalThis & {
  __issue108DelayedWatchEvents: DelayedWatchEvent[];
  __issue108DelayedWatchRegistrations: DelayedWatchRegistration[];
};
const store = await import(
  "../../../../packages/core/src/domain/services/workspace-record-store.ts"
);
const require = createRequire(import.meta.url);
const fsCommonJs = require("node:fs") as typeof import("node:fs");
const fsPromisesCommonJs = require("node:fs/promises") as typeof import("node:fs/promises");

test("private exact settlement never registers or waits for delayed filesystem watchers", async () => {
  const tempRoot = await realpath(
    await mkdtemp(join(tmpdir(), "issue-108-private-settlement-watch-"))
  );
  try {
    const workspaceRoot = join(tempRoot, "workspace");
    const schema = z.object({ id: z.string() });
    globals.__issue108DelayedWatchEvents.length = 0;
    globals.__issue108DelayedWatchRegistrations.length = 0;

    for (const successor of ["missing", "replacement_b"] as const) {
      const directorySegments = ["records", successor] as const;
      const evidenceRef = `issue-108.private-watch.${successor}`;
      const record = { id: `generation-a-${successor}` };
      const path = store.workspaceRecordPath(
        workspaceRoot,
        [...directorySegments, "record.json"],
        evidenceRef
      );
      const created = await store.createJsonRecordIfAbsentWithCleanupPermit(
        workspaceRoot,
        directorySegments,
        "record.json",
        record,
        evidenceRef,
        schema
      );
      if (created.status !== "created") throw new Error("fixture admission failed");
      const replacementBytes = Buffer.from(`{"id":"generation-b-${successor}"}\n`);
      let isolatedPath = "";
      const startedAt = Date.now();

      const outcome = await store.runWithWorkspaceRecordCompensationTestHooks(
        {
          afterOwnedPathIsolation: async (input) => {
            if (input.site !== "conditional_delete") return;
            isolatedPath = input.isolatedPath;
            if (successor === "replacement_b") {
              await writeFile(path, replacementBytes, { flag: "wx", mode: 0o600 });
            }
            throw new Error("force private settlement");
          },
          beforeExactFailureSettlement: async () => {
            const displaced = `${workspaceRoot}.aba`;
            await rename(workspaceRoot, displaced);
            await rename(displaced, workspaceRoot);
          }
        },
        () =>
          store.conditionalDeleteJsonRecordWithCleanupPermitAndExactFailureSettlement(
            created.cleanupPermit,
            path,
            evidenceRef,
            schema,
            { kind: "record", expected: record, matches: () => true }
          )
      );

      expect(outcome).toEqual({ status: "recovered", settlement: "deleted" });
      expect(Date.now() - startedAt).toBeLessThan(CALLBACK_DELAY_MS);
      await expect(lstat(isolatedPath)).rejects.toMatchObject({ code: "ENOENT" });
      if (successor === "missing") {
        await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(await readFile(path)).toEqual(replacementBytes);
      }
    }

    expect(globals.__issue108DelayedWatchRegistrations).toEqual([]);
    expect(globals.__issue108DelayedWatchEvents).toEqual([]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("delayed watcher preload negative control observes every supported access path", async () => {
  const tempRoot = await realpath(
    await mkdtemp(join(tmpdir(), "issue-108-private-settlement-watch-control-"))
  );
  const callbackWatchers: ReturnType<typeof fsNamedWatch>[] = [];
  const watchFileRegistrations: Array<{
    path: string;
    listener: () => void;
  }> = [];
  try {
    globals.__issue108DelayedWatchEvents.length = 0;
    globals.__issue108DelayedWatchRegistrations.length = 0;

    const callbackWatchAccesses = [
      ["node-fs-named-watch", fsNamedWatch],
      ["node-fs-default-watch", fsDefault.watch],
      ["node-fs-namespace-watch", fsNamespace.watch],
      ["node-fs-commonjs-watch", fsCommonJs.watch]
    ] as const;
    const watchFileAccesses = [
      ["node-fs-named-watch-file", fsNamedWatchFile],
      ["node-fs-default-watch-file", fsDefault.watchFile],
      ["node-fs-namespace-watch-file", fsNamespace.watchFile],
      ["node-fs-commonjs-watch-file", fsCommonJs.watchFile]
    ] as const;
    const promisesWatchAccesses = [
      ["node-fs-named-promises-watch", fsNamedPromises.watch],
      ["node-fs-default-promises-watch", fsDefault.promises.watch],
      ["node-fs-namespace-promises-watch", fsNamespace.promises.watch],
      ["node-fs-commonjs-promises-watch", fsCommonJs.promises.watch],
      ["node-fs-promises-named-watch", fsPromisesNamedWatch],
      ["node-fs-promises-default-watch", fsPromisesDefault.watch],
      ["node-fs-promises-namespace-watch", fsPromisesNamespace.watch],
      ["node-fs-promises-commonjs-watch", fsPromisesCommonJs.watch]
    ] as const;
    const expectedRegistrations: DelayedWatchRegistration[] = [];

    for (const [name, watch] of callbackWatchAccesses) {
      const path = join(tempRoot, `${name}.json`);
      await writeFile(path, "{}\n", { flag: "wx", mode: 0o600 });
      const watcher = watch(path, () => {});
      callbackWatchers.push(watcher);
      watcher.close();
      expectedRegistrations.push({ family: "node:fs.watch", path });
    }

    for (const [name, watch] of watchFileAccesses) {
      const path = join(tempRoot, `${name}.json`);
      const listener = (): void => {};
      await writeFile(path, "{}\n", { flag: "wx", mode: 0o600 });
      watchFileRegistrations.push({ path, listener });
      watch(path, { persistent: false, interval: 10 }, listener);
      unwatchFile(path, listener);
      expectedRegistrations.push({ family: "node:fs.watchFile", path });
    }

    for (const [name, watch] of promisesWatchAccesses) {
      const path = join(tempRoot, `${name}.json`);
      const abortController = new AbortController();
      await writeFile(path, "{}\n", { flag: "wx", mode: 0o600 });
      const watcher = watch(path, { signal: abortController.signal });
      const iterator = watcher[Symbol.asyncIterator]();
      abortController.abort();
      try {
        await iterator.next();
      } catch (error) {
        if (!(error instanceof Error) || error.name !== "AbortError") throw error;
      }
      expectedRegistrations.push({ family: "node:fs/promises.watch", path });
    }

    expect(globals.__issue108DelayedWatchRegistrations).toHaveLength(
      expectedRegistrations.length
    );
    for (const expected of expectedRegistrations) {
      expect(globals.__issue108DelayedWatchRegistrations).toContainEqual(expected);
    }
  } finally {
    for (const watcher of callbackWatchers) watcher.close();
    for (const { path, listener } of watchFileRegistrations) {
      unwatchFile(path, listener);
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});
