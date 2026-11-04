import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { expect, test } from "vitest";
import { fileSnapshot } from "./report-workflow/test-harness.ts";
import { expectToolError, treeOrAbsent } from "./task-linked/test-harness.ts";
import { verificationHarness } from "./verification-run/test-harness.ts";

test("raw verifications denies verification_run before execution or workspace mutation", async () => {
  const h = await verificationHarness({ rawDirs: ["verifications"] });
  try {
    let executions = 0;
    await h.ctx.plugin((services: Context) => {
      services.on("tools/execute", (_event, next) => {
        executions++;
        return next();
      });
    });
    const cardPath = join(h.cwd, "tasks", h.card.task_id, "task.json");
    const verificationPath = join(h.cwd, "verifications");
    expect(await treeOrAbsent(verificationPath)).toBeNull();
    const beforeCard = await fileSnapshot(cardPath);
    const beforeEvidence = await h.evidenceSnapshot();
    const beforeWorkspace = await treeOrAbsent(h.root);

    expectToolError(await h.invoke(), /Raw data is immutable/u);
    expect(executions).toBe(0);
    expect(await treeOrAbsent(verificationPath)).toBeNull();
    expect(await fileSnapshot(cardPath)).toEqual(beforeCard);
    expect(await h.evidenceSnapshot()).toEqual(beforeEvidence);
    expect(await treeOrAbsent(h.root)).toEqual(beforeWorkspace);
  } finally {
    await h.dispose();
  }
});
