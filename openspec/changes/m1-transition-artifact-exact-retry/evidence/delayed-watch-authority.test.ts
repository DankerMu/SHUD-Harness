import { expect, test } from "bun:test";
import { unwatchFile, watch as watchCallback, watchFile } from "node:fs";
import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  watch as watchPromise,
  writeFile
} from "node:fs/promises";
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

test("delayed watcher preload negative control observes every watcher family", async () => {
  const tempRoot = await realpath(
    await mkdtemp(join(tmpdir(), "issue-108-private-settlement-watch-control-"))
  );
  const path = join(tempRoot, "control.json");
  const watchFileListener = (): void => {};
  try {
    await writeFile(path, "{}\n", { flag: "wx", mode: 0o600 });
    globals.__issue108DelayedWatchEvents.length = 0;
    globals.__issue108DelayedWatchRegistrations.length = 0;

    const callbackWatcher = watchCallback(path, () => {});
    callbackWatcher.close();
    const abortController = new AbortController();
    watchPromise(path, { signal: abortController.signal });
    abortController.abort();
    watchFile(path, { persistent: false, interval: 10 }, watchFileListener);
    unwatchFile(path, watchFileListener);

    expect(globals.__issue108DelayedWatchRegistrations).toEqual([
      { family: "node:fs.watch", path },
      { family: "node:fs/promises.watch", path },
      { family: "node:fs.watchFile", path }
    ]);
  } finally {
    unwatchFile(path, watchFileListener);
    await rm(tempRoot, { recursive: true, force: true });
  }
});
