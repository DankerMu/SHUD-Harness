import * as fs from "node:fs";
import * as io from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { produceDetachedShud } from "@shud-harness/dsh-shud-jobs";
import { createToolHarness } from "./test-harness.ts";
import {
  TASK,
  OTHER_TASK,
  cardPath,
  cardSnapshot,
  expectToolError,
  getCard,
  plannedCard,
  putCard,
  returnedRun,
  seedLiveRun,
  submissionSnapshot,
  treeOrAbsent,
} from "./task-linked/test-harness.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    lstatSync: vi.fn(actual.lstatSync),
    mkdirSync: vi.fn(actual.mkdirSync),
    readFileSync: vi.fn(actual.readFileSync),
    openSync: vi.fn(actual.openSync),
    renameSync: vi.fn(actual.renameSync),
  };
});
const nativeFs = await vi.importActual<typeof fs>("node:fs");
beforeEach(() => vi.clearAllMocks());

function taskFileCalls() {
  const calls: unknown[][] = [];
  for (const operation of [
    fs.lstatSync,
    fs.mkdirSync,
    fs.readFileSync,
    fs.openSync,
    fs.renameSync,
  ]) {
    for (const args of vi.mocked(operation).mock.calls) {
      if (args.some((arg) => typeof arg === "string" && /\/tasks(?:\/|$)/u.test(arg)))
        calls.push([...args]);
    }
  }
  return calls;
}

test("planned and second running task submissions preserve metadata and sorted links", async () => {
  const h = await createToolHarness({ pumpPollMs: 60_000 });
  try {
    const original = putCard(h);
    const schema = h.runtime.schemas(h.agent).find((tool) => tool.name === "shud_run");
    expect(schema?.parameters).toMatchObject({ type: "object", additionalProperties: false });
    expect(Object.keys(schema?.parameters?.properties ?? {}).sort()).toEqual([
      "end_days",
      "input_dir",
      "label",
      "project",
      "task_id",
    ]);
    const first = await returnedRun(
      h,
      await h.call({ input_dir: h.inputDir, task_id: TASK, end_days: 30 }),
    );
    const second = await returnedRun(
      h,
      await h.call({ input_dir: h.inputDir, task_id: TASK, label: "second" }),
    );
    expect(first.task_id).toBe(TASK);
    expect(second.task_id).toBe(TASK);
    const card = getCard(h);
    expect(card.updated_at).toBeTypeOf("string");
    expect(card).toEqual({
      ...original,
      status: "running",
      runtime_phase: "submitted_job",
      linked_jobs: [first.job_id, second.job_id].sort(),
      stack_id: second.stack_id,
      data_id: second.data_id,
      updated_at: card.updated_at,
    });
    expect(Date.parse(getCard(h).updated_at)).toBeGreaterThan(Date.parse(original.updated_at));
    expect(await io.readdir(join(h.cwd, "tasks", TASK))).toEqual(["task.json"]);
    for (const record of [first, second]) {
      expect(record.stack_id).toMatch(/^STACK-/u);
      expect(record.data_id).toMatch(/^DATA-/u);
    }
  } finally {
    await h.dispose();
  }
}, 20_000);

test.each([undefined, "corrupt", "unsafe"])(
  "unlinked run bypasses task query and all task IO with %s task tree",
  async (tree) => {
    const h = await createToolHarness({ pumpPollMs: 60_000 });
    const query = vi.spyOn(h.registry, "listRunJobsByTask");
    const submit = vi.spyOn(h.registry, "submitShud");
    try {
      if (tree === "corrupt") {
        putCard(h);
        await io.writeFile(cardPath(h), "PRIVATE_BROKEN_CARD");
      }
      if (tree === "unsafe") await io.symlink(h.inputDir, join(h.cwd, "tasks"));
      const before = await treeOrAbsent(join(h.cwd, "tasks"));
      vi.clearAllMocks();
      const result = await h.call({ input_dir: h.inputDir, end_days: 30, label: "legacy 30d" });
      const record = await returnedRun(h, result);
      expect(query).not.toHaveBeenCalled();
      expect(taskFileCalls()).toEqual([]);
      expect(submit).toHaveBeenCalledExactlyOnceWith(
        {
          cwd: h.cwd,
          input_dir: h.inputDir,
          project: "tiny",
          end_days: 30,
          label: "legacy 30d",
          owner_session: h.ownerId,
          llm: { response_model: "configured-test-model", response_model_source: "configured" },
        },
        produceDetachedShud,
      );
      expect(record).toMatchObject({
        task_id: null,
        owner_session: h.ownerId,
        project: "tiny",
        end_days: 30,
        label: "legacy 30d",
        llm: { response_model: "configured-test-model", response_model_source: "configured" },
      });
      expect(result.content).toEqual([
        {
          type: "text",
          text:
            `SHUD running: job_id=${record.job_id}, run_id=${record.run_id}, ` +
            `dsh_job_id=${record.dsh_job_id}, run_dir=${record.run_dir}.\n` +
            `Use job_output and job_kill with dsh_job_id ${record.dsh_job_id}, not job_id or run_id. ` +
            "After a host restart the dsh_job_id changes; find the current id through job_list " +
            `(the label contains run_id ${record.run_id}) or shud_collect.`,
        },
      ]);
      expect(await treeOrAbsent(join(h.cwd, "tasks"))).toEqual(before);
    } finally {
      query.mockRestore();
      submit.mockRestore();
      await h.dispose();
    }
  },
  15_000,
);

test.each([
  "TASK-0001",
  "../reports/x",
  "TASK-20261027T080005-ABCD",
  "RUN-20261027T080005-abcd",
  "",
  null,
  7,
  {},
  [],
])("invalid task id %j rejects before query or task filesystem access", async (task_id) => {
  const h = await createToolHarness({ pumpPollMs: 60_000 });
  const query = vi.spyOn(h.registry, "listRunJobsByTask");
  const submit = vi.spyOn(h.registry, "submitShud");
  try {
    const before = await submissionSnapshot(h);
    vi.clearAllMocks();
    expectToolError(await h.call({ input_dir: h.inputDir, task_id }), /task_id/iu);
    expect(query).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(taskFileCalls()).toEqual([]);
    expect(await submissionSnapshot(h)).toEqual(before);
  } finally {
    query.mockRestore();
    submit.mockRestore();
    await h.dispose();
  }
});

test.each([
  "missing",
  "json",
  "schema",
  "identity",
  "tasks-link",
  "directory-link",
  "target-link",
  "target-directory",
])("invalid task workspace %s rejects without run or foreign rewrite", async (kind) => {
  const h = await createToolHarness({ pumpPollMs: 60_000 });
  const submit = vi.spyOn(h.registry, "submitShud");
  try {
    const foreign = join(h.root, "foreign");
    await io.mkdir(foreign);
    await io.writeFile(
      join(foreign, "task.json"),
      JSON.stringify(plannedCard({ task_id: OTHER_TASK })),
    );
    if (kind !== "missing") putCard(h);
    if (kind === "json") await io.writeFile(cardPath(h), "PRIVATE_BROKEN_CARD");
    if (kind === "schema") await io.writeFile(cardPath(h), JSON.stringify({ task_id: TASK }));
    if (kind === "identity")
      await io.writeFile(cardPath(h), JSON.stringify(plannedCard({ task_id: OTHER_TASK })));
    if (kind === "tasks-link") {
      await io.rm(join(h.cwd, "tasks"), { recursive: true });
      await io.symlink(foreign, join(h.cwd, "tasks"));
    }
    if (kind === "directory-link") {
      await io.rm(join(h.cwd, "tasks", TASK), { recursive: true });
      await io.symlink(foreign, join(h.cwd, "tasks", TASK));
    }
    if (kind === "target-link" || kind === "target-directory") {
      await io.unlink(cardPath(h));
      if (kind === "target-link") await io.symlink(join(foreign, "task.json"), cardPath(h));
      else await io.mkdir(cardPath(h));
    }
    const before = await treeOrAbsent(join(h.cwd, "tasks"));
    const foreignBefore = await treeOrAbsent(foreign);
    const submissionBefore = await submissionSnapshot(h);
    expectToolError(
      await h.call({ input_dir: h.inputDir, task_id: TASK }),
      /task|workspace|identity/iu,
    );
    expect(submit).not.toHaveBeenCalled();
    expect(await submissionSnapshot(h)).toEqual(submissionBefore);
    expect(await treeOrAbsent(foreign)).toEqual(foreignBefore);
    if (kind === "missing") {
      // The canonical reader creates managed directories, never a missing card object.
      expect(nativeFs.existsSync(cardPath(h))).toBe(false);
    } else expect(await treeOrAbsent(join(h.cwd, "tasks"))).toEqual(before);
  } finally {
    submit.mockRestore();
    await h.dispose();
  }
});

test.each([
  "created",
  "parked",
  "reporting",
  "awaiting_pi",
  "done",
  "cancelled",
  "blocked",
] as const)(
  "non-runnable %s rejects before repairing a real missing live-job link",
  async (status) => {
    const h = await createToolHarness({ pumpPollMs: 60_000 });
    try {
      await seedLiveRun(h);
      putCard(h, plannedCard({ status }));
      const before = await cardSnapshot(h);
      const submissionsBefore = await submissionSnapshot(h);
      const submit = vi.spyOn(h.registry, "submitShud");
      try {
        expectToolError(
          await h.call({ input_dir: h.inputDir, task_id: TASK }),
          new RegExp(status, "u"),
        );
        expect(submit).not.toHaveBeenCalled();
        expect(await cardSnapshot(h)).toEqual(before);
        expect(await submissionSnapshot(h)).toEqual(submissionsBefore);
      } finally {
        submit.mockRestore();
      }
    } finally {
      await h.dispose();
    }
  },
  15_000,
);

test("closed task-linked schema still rejects unknown parameters without IO", async () => {
  const h = await createToolHarness();
  const query = vi.spyOn(h.registry, "listRunJobsByTask");
  try {
    vi.clearAllMocks();
    expectToolError(
      await h.call({ input_dir: h.inputDir, task_id: TASK, threads: 4 }),
      /threads/iu,
    );
    expect(query).not.toHaveBeenCalled();
    expect(taskFileCalls()).toEqual([]);
  } finally {
    query.mockRestore();
    await h.dispose();
  }
});
