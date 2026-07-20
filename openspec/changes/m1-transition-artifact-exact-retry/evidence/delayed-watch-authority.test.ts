import { expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { CALLBACK_DELAY_MS, type DelayedWatchEvent } from "./delay-watch-preload";

const globals = globalThis as typeof globalThis & {
  __issue108DelayedWatchEvents: DelayedWatchEvent[];
  __issue108DelayedWatchRegistrations: string[];
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
