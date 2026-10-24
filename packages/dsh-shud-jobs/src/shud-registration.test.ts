import { expect, test } from "vitest";
import type { JobOutcome } from "@deepseek-ai/dsh-jobs";
import { createShudCompletion } from "./shud-registration.ts";

test.each(["settle", "detach", "cancel"] as const)(
  "registration completion keeps its first %s outcome on the same done promise",
  async (first) => {
    const lifecycle = createShudCompletion();
    const done = lifecycle.done;
    const terminal: JobOutcome = { status: "completed", detail: "durable success" };
    if (first === "settle") await lifecycle.settle(terminal);
    if (first === "detach") lifecycle.detach("host exiting");
    if (first === "cancel") lifecycle.cancel("submission rollback");
    await lifecycle.settle({ status: "killed", detail: "late settlement" });
    lifecycle.detach("late detach");
    lifecycle.cancel("late rollback");
    expect(lifecycle.done).toBe(done);
    await expect(done).resolves.toEqual(
      first === "settle"
        ? terminal
        : {
            status: "failed",
            detail: first === "detach" ? "host exiting" : "submission rollback",
          },
    );
  },
);

test("rollback cancellation without a reason still completes the registration", async () => {
  const lifecycle = createShudCompletion();
  lifecycle.cancel();
  await expect(lifecycle.done).resolves.toMatchObject({ status: "failed" });
});
