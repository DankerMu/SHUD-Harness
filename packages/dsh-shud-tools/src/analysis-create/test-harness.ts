import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolCallId } from "@deepseek-ai/dsh-llm";
import type { ToolExecutionResult } from "@deepseek-ai/dsh-tools";
import {
  AnalysisPlanSchema,
  TaskCardSchema,
  type AnalysisPlan,
  type TaskCard,
} from "@shud-harness/dsh-shud-core";
import { expect } from "vitest";
import { createToolHarness } from "../test-harness.ts";
import { cardPath, plannedCard, putCard, TASK, treeOrAbsent } from "../task-linked/test-harness.ts";

export const PRIVATE = "PRIVATE_ANALYSIS_CREATE_664";
const CCW = fileURLToPath(new URL("../../../../SHUD/input/ccw/", import.meta.url));
const CCW_FILES = ["ccw.cfg.para", "ccw.cfg.calib", "ccw.para.geol", "ccw.para.lc"];
export const DIGEST_FILES = ["ccw.cfg.calib", "ccw.para.geol", "ccw.para.lc"];
const acceptanceSets = [
  { baseline: true, changes: {} },
  { baseline: false, changes: { GEOL_KSATH: 0.5 } },
  { baseline: false, changes: { GEOL_KSATH: 2 } },
  { baseline: false, changes: { LC_ROUGH: 2 } },
];
export const validArgs = {
  task_id: TASK,
  input_dir: "input/ccw",
  end_days: 90,
  parameter_sets: acceptanceSets,
  rationale_basis: "One-at-a-time multipliers bracket the calibrated baseline.",
};

export type AnalysisHarness = Awaited<ReturnType<typeof analysisHarness>>;

/** Real ToolRuntime + registered shud-tools, a coordinator projection and an input/ccw copy. */
export async function analysisHarness() {
  const h = await createToolHarness({ pumpPollMs: 60_000 });
  try {
    const presets = new Map<object, string>([[h.agent.session, "coordinator"]]);
    const callingContext = h.agent.ctx;
    await callingContext.plugin((services: Context) => {
      services.provide("sessionProjections", {
        stateOf(session: object, key: string) {
          return key === "agentPreset" ? presets.get(session) : undefined;
        },
      });
    });
    await callingContext.plugin({
      inject: ["sessionProjections"],
      apply(consumer: Context) {
        Object.assign(h.agent, { ctx: consumer });
      },
    });
    const input = join(h.cwd, "input", "ccw");
    fs.mkdirSync(input, { recursive: true });
    for (const file of CCW_FILES) fs.copyFileSync(join(CCW, file), join(input, file));
    return {
      ...h,
      input,
      presets,
      invoke(args: unknown, agent: Agent | null = h.agent): Promise<ToolExecutionResult> {
        return h.runtime.execute({
          callId: "analysis-create-consumer-tracer" as ToolCallId,
          name: "analysis_create",
          arguments: args,
          ...(agent === null ? {} : { agent }),
          signal: new AbortController().signal,
        });
      },
    };
  } catch (error) {
    await h.dispose();
    throw error;
  }
}

export function sensitivityCard(overrides: Partial<TaskCard> = {}) {
  return plannedCard({
    type: "sensitivity",
    linked_reports: [],
    linked_analyses: [],
    ...overrides,
  });
}

export function seedCard(h: Pick<AnalysisHarness, "cwd">, overrides: Partial<TaskCard> = {}) {
  return putCard(h, sensitivityCard(overrides));
}

export function readCard(h: Pick<AnalysisHarness, "cwd">, id = TASK) {
  return TaskCardSchema.parse(JSON.parse(fs.readFileSync(cardPath(h, id), "utf8")));
}

export function sha256(path: string) {
  return createHash("sha256").update(fs.readFileSync(path)).digest("hex");
}

export function analysesDir(h: Pick<AnalysisHarness, "cwd">) {
  return join(h.cwd, "analyses");
}

export function planNames(h: Pick<AnalysisHarness, "cwd">) {
  const root = analysesDir(h);
  return fs.existsSync(root) ? fs.readdirSync(root).sort() : null;
}

export function readPlan(h: Pick<AnalysisHarness, "cwd">, id: string): AnalysisPlan {
  return AnalysisPlanSchema.parse(
    JSON.parse(fs.readFileSync(join(analysesDir(h), `${id}.json`), "utf8")),
  );
}

export function fileSnapshot(path: string) {
  return { bytes: fs.readFileSync(path), mtime: fs.statSync(path, { bigint: true }).mtimeNs };
}

/** Write a schema-valid plan for this card directly, as a prior write-back failure would leave. */
export function seedOrphan(
  h: Pick<AnalysisHarness, "cwd" | "input">,
  id: string,
  overrides: Partial<AnalysisPlan> = {},
) {
  const plan = AnalysisPlanSchema.parse({
    analysis_plan_id: id,
    task_id: TASK,
    mode: "sensitivity",
    strategy: "one_at_a_time",
    input_dir: fs.realpathSync.native(h.input),
    project: "ccw",
    end_days: validArgs.end_days,
    threads: 1,
    parameter_sets: acceptanceSets.map((set, index) => ({
      parameter_set_id: `PSET-${index + 1}`,
      label: null,
      ...set,
    })),
    parameter_space_rationale: {
      proposed_by: "agent",
      basis: validArgs.rationale_basis,
      confirmed_by: null,
    },
    input_digests: Object.fromEntries(
      DIGEST_FILES.map((file) => [file, sha256(join(h.input, file))]),
    ),
    created_by: "coordinator",
    created_at: "2026-11-08T09:30:00.000Z",
    ...overrides,
  });
  fs.mkdirSync(analysesDir(h), { recursive: true });
  const path = join(analysesDir(h), `${id}.json`);
  fs.writeFileSync(path, `${JSON.stringify(plan)}\n`);
  return { plan, path };
}

/**
 * `link -> deep/inner` plus input copies at `<cwd>/<name>` and `<cwd>/deep/<name>`: a textual
 * collapse of `link/../<name>` names the first, physical traversal the second. Returns the
 * physical realpath, the directory the host and raw-guard resolve.
 */
export function aliasedInput(h: Pick<AnalysisHarness, "cwd" | "input">, name: string) {
  const physical = join(h.cwd, "deep", name);
  for (const dir of [join(h.cwd, name), physical]) fs.cpSync(h.input, dir, { recursive: true });
  fs.mkdirSync(join(h.cwd, "deep", "inner"));
  fs.symlinkSync(join(h.cwd, "deep", "inner"), join(h.cwd, "link"));
  return fs.realpathSync.native(physical);
}

/** Bytes and listings of every workspace surface the tool must leave untouched on rejection. */
export async function workspaceSnapshot(h: Pick<AnalysisHarness, "cwd" | "input">) {
  return {
    analyses: await treeOrAbsent(analysesDir(h)),
    tasks: await treeOrAbsent(join(h.cwd, "tasks")),
    input: await treeOrAbsent(h.input),
    outputs: await Promise.all(
      ["runs", "stacks", "provenance", "reports"].map((name) => treeOrAbsent(join(h.cwd, name))),
    ),
  };
}

export function successValue(result: ToolExecutionResult) {
  expect(result.isError, JSON.stringify(result)).toBe(false);
  if (result.isError) throw new Error(result.error.message);
  const value = result.value as {
    analysis_plan_id: string;
    parameter_sets: Array<{
      parameter_set_id: string;
      label: string | null;
      baseline: boolean;
      changes: Record<string, number>;
    }>;
  };
  return value;
}
