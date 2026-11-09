import * as fs from "node:fs";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { CANONICAL_HARNESS_ROLES, isRoleToolIdAllowed } from "@shud-harness/dsh-shud-core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { expectToolError, TASK } from "./task-linked/test-harness.ts";
import {
  analysisHarness,
  PRIVATE,
  seedCard,
  validArgs,
  workspaceSnapshot,
  type AnalysisHarness,
} from "./analysis-create/test-harness.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    lstatSync: vi.fn(actual.lstatSync),
    readFileSync: vi.fn(actual.readFileSync),
    readdirSync: vi.fn(actual.readdirSync),
    openSync: vi.fn(actual.openSync),
    mkdirSync: vi.fn(actual.mkdirSync),
  };
});

let h: AnalysisHarness;
beforeEach(async () => {
  h = await analysisHarness();
  seedCard(h);
});
afterEach(async () => {
  await h.dispose();
});

function expectNoFileSystemAccess() {
  expect(fs.lstatSync).not.toHaveBeenCalled();
  expect(fs.readFileSync).not.toHaveBeenCalled();
  expect(fs.readdirSync).not.toHaveBeenCalled();
  expect(fs.openSync).not.toHaveBeenCalled();
  expect(fs.mkdirSync).not.toHaveBeenCalled();
}

const element = validArgs.parameter_sets[1];
const rejected: Array<[string, unknown, RegExp]> = [
  ["root array", [], /object/iu],
  ["root null", null, /object/iu],
  ...["confirmed_by", "proposed_by", "parameter_set_id", "analysis_plan_id", "input_digests"].map(
    (key): [string, unknown, RegExp] => [
      `plan-owned ${key}`,
      { ...validArgs, [key]: key === "input_digests" ? {} : "pi" },
      new RegExp(`Unknown parameter: ${key}`, "u"),
    ],
  ),
  [
    "element parameter_set_id",
    { ...validArgs, parameter_sets: [{ ...element, parameter_set_id: "PSET-9" }] },
    /parameter_sets\[0\]\.parameter_set_id/u,
  ],
  [
    "element unknown key",
    { ...validArgs, parameter_sets: [{ ...element, name: PRIVATE }] },
    /parameter_sets\[0\]\.name/u,
  ],
  ["element missing baseline", { ...validArgs, parameter_sets: [{ changes: {} }] }, /baseline/u],
  ["threads 0", { ...validArgs, threads: 0 }, /threads/u],
  ["threads 1.5", { ...validArgs, threads: 1.5 }, /threads/u],
  ['threads "1"', { ...validArgs, threads: "1" }, /threads/u],
  ["end_days 0", { ...validArgs, end_days: 0 }, /end_days/u],
  ["end_days 1.5", { ...validArgs, end_days: 1.5 }, /end_days/u],
  ["malformed task_id", { ...validArgs, task_id: "../tasks/x" }, /task_id/u],
  ["empty rationale_basis", { ...validArgs, rationale_basis: "" }, /rationale_basis/u],
  ["empty input_dir", { ...validArgs, input_dir: "" }, /input_dir/u],
  ["traversing project", { ...validArgs, project: "../ccw" }, /project/u],
  ["empty project", { ...validArgs, project: "" }, /project/u],
  ["dot project", { ...validArgs, project: "." }, /project/u],
  [
    "missing parameter_sets",
    Object.fromEntries(Object.entries(validArgs).filter(([key]) => key !== "parameter_sets")),
    /parameter_sets/u,
  ],
];

test.each(rejected)("%s is rejected before any file-system access", async (_label, args, msg) => {
  const before = await workspaceSnapshot(h);
  vi.clearAllMocks();
  expectToolError(await h.invoke(args), msg);
  expectNoFileSystemAccess();
  expect(await workspaceSnapshot(h)).toEqual(before);
});

test.each([undefined, ""])(
  "session cwd %j is a workspace error before file access",
  async (cwd) => {
    Object.assign(h.agent.session.header, { cwd });
    try {
      vi.clearAllMocks();
      expectToolError(await h.invoke(validArgs), /workspace|cwd/iu);
      expectNoFileSystemAccess();
    } finally {
      Object.assign(h.agent.session.header, { cwd: h.cwd });
    }
  },
);

test("a call without an agent is a workspace error before file access", async () => {
  vi.clearAllMocks();
  expectToolError(await h.invoke(validArgs, null), /workspace|cwd/iu);
  expectNoFileSystemAccess();
});

test("registered tools keep the eleven-tool order and append analysis_create", () => {
  const schemas = h.runtime.schemas();
  expect(schemas.map((schema) => schema.name)).toEqual([
    "shud_run",
    "shud_collect",
    "task_create",
    "change_create",
    "change_submit",
    "shud_build",
    "verification_run",
    "report_generate",
    "report_validate",
    "report_submit",
    "report_decide",
    "analysis_create",
  ]);
  const schema = schemas.find((candidate) => candidate.name === "analysis_create");
  expect(schema?.parameters).toMatchObject({
    additionalProperties: false,
    properties: { parameter_sets: { items: { additionalProperties: false } } },
  });
});

test("a valid call whose backend fails delegates exactly once without retry", async () => {
  let executions = 0;
  await h.ctx.plugin((services: Context) => {
    services.on("tools/execute", (_event, next) => {
      executions++;
      return next();
    });
  });
  const analyses = join(h.cwd, "analyses");
  vi.mocked(fs.readdirSync).mockClear();
  vi.mocked(fs.readdirSync).mockImplementation(() => {
    throw Object.assign(new Error(PRIVATE), { code: "EIO" });
  });
  fs.mkdirSync(analyses);
  try {
    const message = expectToolError(await h.invoke(validArgs), /analyses/u);
    expect(message).not.toContain(PRIVATE);
    expect(fs.readdirSync).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync).toHaveBeenCalledWith(analyses);
  } finally {
    vi.mocked(fs.readdirSync).mockRestore();
  }
  expect(executions).toBe(1);
  expect(fs.readdirSync(analyses)).toEqual([]);
  expect(fs.existsSync(join(h.cwd, "tasks", TASK, "task.json"))).toBe(true);
});

test.each(["coordinator", "worker", "coder", "reviewer"] as const)(
  "%s has no analysis_create surface until #665 exposes it",
  (role) => {
    expect(CANONICAL_HARNESS_ROLES).toContain(role);
    expect(isRoleToolIdAllowed(role, "analysis_create")).toBe(false);
  },
);
