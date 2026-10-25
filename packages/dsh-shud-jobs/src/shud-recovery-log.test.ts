import { Context } from "@deepseek-ai/cordis";
import { expect, test } from "vitest";
import { captureRecoveryStderr } from "./reconcile-shud/test-harness.ts";
import { createRecoveryReporter } from "./shud-recovery-log.ts";

test("recovery stderr is isolated by facade and stops with its owning plugin", async () => {
  const ctx = new Context();
  const stderr = captureRecoveryStderr();
  async function mountReporter() {
    let report: ((message: string) => void) | undefined;
    const fiber = ctx.plugin((child: Context) => {
      report = createRecoveryReporter(child);
    });
    await fiber;
    if (!report) throw new Error("Recovery reporter plugin did not initialize");
    return { fiber, report };
  }
  try {
    const first = await mountReporter();
    const sibling = await mountReporter();
    first.report("R7 first-run diagnostic");
    sibling.report("R7 sibling-run diagnostic");
    expect(stderr.lines("first-run")).toHaveLength(1);
    expect(stderr.lines("sibling-run")).toHaveLength(1);

    const sameName = first.fiber.ctx.logger("shud-recovery");
    sameName.level = 2;
    sameName.warn("PRIVATE_SAME_FIBER_OTHER_FACADE_343");
    const unrelated = first.fiber.ctx.logger("unrelated-plugin");
    unrelated.level = 2;
    unrelated.warn("PRIVATE_UNRELATED_WARNING_343");
    unrelated.error(new Error("PRIVATE_UNRELATED_ERROR_343"));
    expect(stderr.text()).not.toContain("PRIVATE_");

    await first.fiber.dispose();
    const before = stderr.text();
    first.report("R7 disposed-run diagnostic");
    expect(stderr.text()).toBe(before);
    sibling.report("R7 surviving-run diagnostic");
    expect(stderr.lines("surviving-run")).toHaveLength(1);

    const replacement = await mountReporter();
    replacement.report("R7 replacement-run diagnostic");
    expect(stderr.lines("replacement-run")).toHaveLength(1);
    first.report("R7 stale-run diagnostic");
    expect(stderr.lines("stale-run")).toEqual([]);
    await replacement.fiber.dispose();
    replacement.report("R7 disposed-replacement diagnostic");
    expect(stderr.lines("disposed-replacement")).toEqual([]);
    await sibling.fiber.dispose();
    sibling.report("R7 disposed-sibling diagnostic");
    expect(stderr.lines("disposed-sibling")).toEqual([]);
  } finally {
    stderr.restore();
    await ctx.fiber.dispose();
  }
});
