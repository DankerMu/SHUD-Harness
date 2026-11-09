import * as fs from "node:fs";
import type { Context } from "@deepseek-ai/cordis";
import type { ApprovalService } from "@deepseek-ai/dsh-user-approval";
import * as rawGuard from "@shud-harness/dsh-shud-raw-guard";
import { afterEach, beforeEach, expect, test } from "vitest";
import { RAW_READ_PROVENANCE_REASON } from "../../dsh-shud-raw-guard/src/decide.ts";
import { expectToolError, TASK, treeOrAbsent } from "./task-linked/test-harness.ts";
import {
  aliasedInput,
  analysesDir,
  analysisHarness,
  planNames,
  readCard,
  readPlan,
  seedCard,
  seedOrphan,
  successValue,
  validArgs,
  workspaceSnapshot,
  type AnalysisHarness,
} from "./analysis-create/test-harness.ts";

type Outcome = "allowed-once" | "rejected";
let h: AnalysisHarness;
beforeEach(async () => {
  h = await analysisHarness();
});
afterEach(async () => {
  await h.dispose();
});

async function admission(outcome: Outcome) {
  const approvals: Array<Parameters<ApprovalService["request"]>[0]> = [];
  let executions = 0;
  await h.ctx.plugin((services: Context) => {
    services.provide("approval", {
      request(request: Parameters<ApprovalService["request"]>[0]) {
        approvals.push(request);
        return Promise.resolve(outcome);
      },
    });
    services.on("tools/execute", (_event, next) => {
      executions++;
      return next();
    });
  });
  return {
    approvals,
    get executions() {
      return executions;
    },
  };
}

const ORPHAN = "PLAN-20261108T093000-5c1e";
for (const exists of [false, true]) {
  test.each(["analyses", `tasks/${TASK}/task.json`])(
    `raw %s denies before execute and approval with existing target=${exists}`,
    async (raw) => {
      if (raw === "analyses" ? exists : true) seedCard(h);
      if (raw === "analyses" && exists) seedOrphan(h, ORPHAN, { task_id: TASK });
      if (raw !== "analyses" && !exists) fs.rmSync(`${h.cwd}/tasks`, { recursive: true });
      expect(fs.existsSync(raw === "analyses" ? analysesDir(h) : `${h.cwd}/${raw}`)).toBe(exists);
      await h.apply(rawGuard, { rawDirs: [raw] });
      const seen = await admission("allowed-once");
      const before = await workspaceSnapshot(h);
      expectToolError(await h.invoke(validArgs), /immutable/iu);
      expect(seen.executions).toBe(0);
      expect(seen.approvals).toEqual([]);
      expect(await workspaceSnapshot(h)).toEqual(before);
    },
  );
}

test.each<Outcome>(["rejected", "allowed-once"])(
  "raw input/ccw asks with the provenance reason; %s decides execution",
  async (outcome) => {
    seedCard(h);
    await h.apply(rawGuard, { rawDirs: ["input/ccw"] });
    const seen = await admission(outcome);
    const before = await workspaceSnapshot(h);
    const result = await h.invoke(validArgs);
    expect(seen.approvals).toHaveLength(1);
    expect(seen.approvals[0]).toMatchObject({
      toolName: "analysis_create",
      agent: h.agent,
      reason: RAW_READ_PROVENANCE_REASON,
    });
    if (outcome === "rejected") {
      expectToolError(result, /reject/iu);
      expect(seen.executions).toBe(0);
      expect(await workspaceSnapshot(h)).toEqual(before);
    } else {
      const value = successValue(result);
      expect(seen.executions).toBe(1);
      expect(planNames(h)).toEqual([`${value.analysis_plan_id}.json`]);
      expect(readCard(h).linked_analyses).toEqual([value.analysis_plan_id]);
      expect((await workspaceSnapshot(h)).input).toEqual(before.input);
    }
  },
);

// raw-guard judges `link/../rawin` physically (deep/rawin); the tool must read that same directory.
const aliased = { ...validArgs, input_dir: "link/../rawin", project: "ccw" };

test("raw textual collapse target is neither asked nor read for link/..", async () => {
  seedCard(h);
  const physical = aliasedInput(h, "rawin");
  await h.apply(rawGuard, { rawDirs: ["rawin"] });
  const seen = await admission("allowed-once");
  const value = successValue(await h.invoke(aliased));
  expect(seen.approvals).toEqual([]);
  expect(seen.executions).toBe(1);
  expect(readPlan(h, value.analysis_plan_id).input_dir).toBe(physical);
});

test.each<Outcome>(["rejected", "allowed-once"])(
  "raw physical link/.. target asks; %s decides what is read",
  async (outcome) => {
    seedCard(h);
    const physical = aliasedInput(h, "rawin");
    await h.apply(rawGuard, { rawDirs: ["deep/rawin"] });
    const seen = await admission(outcome);
    const before = { ...(await workspaceSnapshot(h)), deep: await treeOrAbsent(physical) };
    const result = await h.invoke(aliased);
    expect(seen.approvals).toHaveLength(1);
    expect(seen.approvals[0]).toMatchObject({ reason: RAW_READ_PROVENANCE_REASON });
    if (outcome === "rejected") {
      expectToolError(result, /reject/iu);
      expect(seen.executions).toBe(0);
      expect({ ...(await workspaceSnapshot(h)), deep: await treeOrAbsent(physical) }).toEqual(
        before,
      );
    } else {
      const value = successValue(result);
      expect(seen.executions).toBe(1);
      expect(readPlan(h, value.analysis_plan_id).input_dir).toBe(physical);
    }
  },
);
