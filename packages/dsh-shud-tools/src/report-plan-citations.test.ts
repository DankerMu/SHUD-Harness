import * as fs from "node:fs";
import { join } from "node:path";
import { createAnalysisPlan } from "@shud-harness/dsh-shud-records";
import { beforeEach, expect, test, vi } from "vitest";
import { installUnsafe } from "../../dsh-shud-records/src/test-harness.ts";
import { analysisCase } from "../../dsh-shud-records/src/workspace-files-test-harness.ts";
import {
  DRAFT,
  expectReportError,
  fileSnapshot,
  generated,
  reportHarness,
  seedCodeChangeEvidence,
  seedEvidence,
} from "./report-workflow/test-harness.ts";
import { cardSnapshot, getCard, putCard, treeOrAbsent } from "./task-linked/test-harness.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
const native = await vi.importActual<typeof fs>("node:fs");
beforeEach(() => {
  vi.mocked(fs.readFileSync).mockReset().mockImplementation(native.readFileSync);
});

test("missing PLAN citation rejects before reconciliation without changing workspace evidence", async () => {
  const h = await reportHarness();
  try {
    await seedEvidence(h);
    putCard(h, { ...getCard(h), linked_jobs: [] });
    expect(getCard(h)).toMatchObject({ type: "science_assist", linked_jobs: [] });
    const token = "PLAN-20991231T235959-ffff";
    const analyses = join(h.cwd, "analyses");
    const reports = join(h.cwd, "reports");
    expect(await treeOrAbsent(analyses)).toBeNull();
    expect(await treeOrAbsent(reports)).toBeNull();
    const before = await treeOrAbsent(h.root);
    const cardBefore = await cardSnapshot(h);
    const query = vi.spyOn(h.registry, "listRunJobsByTask");
    const collect = vi.spyOn(h.registry, "collectShud");
    try {
      const message = expectReportError(
        await h.invoke("report_generate", { ...DRAFT, summary: token }),
        /report_generate citation unavailable: PLAN-20991231T235959-ffff/u,
      );
      expect(message).toBe(`report_generate citation unavailable: ${token}`);
      expect(query).not.toHaveBeenCalled();
      expect(collect).not.toHaveBeenCalled();
      expect(await treeOrAbsent(h.root)).toEqual(before);
      expect(await cardSnapshot(h)).toEqual(cardBefore);
      expect(await treeOrAbsent(analyses)).toBeNull();
      expect(await treeOrAbsent(reports)).toBeNull();
    } finally {
      query.mockRestore();
      collect.mockRestore();
    }
  } finally {
    await h.dispose();
  }
});

test.each(["science_assist", "code_change"] as const)(
  "%s accepts a valid observation PLAN citation belonging to another task",
  async (type) => {
    const h = await reportHarness();
    try {
      if (type === "science_assist") await seedEvidence(h);
      else await seedCodeChangeEvidence(h);
      const plan = createAnalysisPlan(h.cwd, analysisCase.schema.parse(analysisCase.value));
      expect(plan.task_id).not.toBe(getCard(h).task_id);
      expect(getCard(h)).toMatchObject({ type, linked_analyses: [] });
      const path = join(h.cwd, "analyses", `${plan.analysis_plan_id}.json`);
      const before = await fileSnapshot(path);
      const observations = [`Cites (${plan.analysis_plan_id}).`];
      const report = generated(h, await h.invoke("report_generate", { ...DRAFT, observations }));
      expect(report.observations).toEqual(observations);
      expect(report.analysis_ids).toEqual([]);
      expect(report.sensitivity_summary).toBeNull();
      expect(getCard(h).linked_analyses).toEqual([]);
      expect(await fileSnapshot(path)).toEqual(before);
    } finally {
      await h.dispose();
    }
  },
);

test.each(["observations", "limitations", "pi_questions"] as const)(
  "missing PLAN citation in %s rejects without creating analyses",
  async (field) => {
    const h = await reportHarness();
    try {
      await seedEvidence(h);
      const token = "PLAN-20991231T235959-ffff";
      const before = await treeOrAbsent(h.root);
      const message = expectReportError(
        await h.invoke("report_generate", { ...DRAFT, [field]: [token] }),
        new RegExp(token, "u"),
      );
      expect(message).toBe(`report_generate citation unavailable: ${token}`);
      expect(await treeOrAbsent(h.root)).toEqual(before);
      expect(await treeOrAbsent(join(h.cwd, "analyses"))).toBeNull();
    } finally {
      await h.dispose();
    }
  },
);

test.each([
  "missing",
  "parse",
  "schema",
  "identity",
  "read",
  "directory",
  "fifo",
  "symlink",
  "dangling-link",
  "root-file",
  "root-symlink",
  "root-dangling-link",
  "root-fifo",
  "root-missing",
] as const)("PLAN citation rejects %s without changing evidence", async (fault) => {
  const h = await reportHarness();
  try {
    await seedEvidence(h);
    const plan = createAnalysisPlan(h.cwd, analysisCase.schema.parse(analysisCase.value));
    const token = plan.analysis_plan_id;
    const root = join(native.realpathSync.native(h.cwd), "analyses");
    const path = join(root, `${token}.json`);
    let readFailures = 0;
    if (fault === "missing") fs.unlinkSync(path);
    else if (fault === "parse") fs.writeFileSync(path, "PRIVATE_PLAN_CITATION_PAYLOAD");
    else if (fault === "schema")
      fs.writeFileSync(path, JSON.stringify({ created_at: "PRIVATE_PLAN_CITATION_PAYLOAD" }));
    else if (fault === "identity")
      fs.writeFileSync(
        path,
        JSON.stringify({ ...plan, analysis_plan_id: "PLAN-20991231T235959-ffff" }),
      );
    else if (fault === "read")
      vi.mocked(fs.readFileSync).mockImplementation((...args) => {
        if (String(args[0]) === path) {
          readFailures++;
          throw Object.assign(new Error(`PRIVATE_PLAN_CITATION_PAYLOAD ${path}`), {
            code: "EACCES",
          });
        }
        return native.readFileSync(...args);
      });
    else if (fault.startsWith("root-")) {
      const outside = join(h.root, "outside-analysis-root");
      fs.renameSync(root, outside);
      if (fault !== "root-missing")
        installUnsafe(
          root,
          fault === "root-file"
            ? "file"
            : fault === "root-fifo"
              ? "fifo"
              : fault === "root-dangling-link"
                ? "dangling-link"
                : "symlink",
          outside,
        );
    } else {
      const outside = join(h.root, "outside-analysis");
      fs.renameSync(path, outside);
      installUnsafe(path, fault as "directory" | "fifo" | "symlink" | "dangling-link", outside);
    }
    const before = await treeOrAbsent(h.root);
    const cardBefore = await cardSnapshot(h);
    const query = vi.spyOn(h.registry, "listRunJobsByTask");
    const collect = vi.spyOn(h.registry, "collectShud");
    try {
      const message = expectReportError(
        await h.invoke("report_generate", { ...DRAFT, summary: `Cites (${token}).` }),
        new RegExp(token, "u"),
      );
      expect(message).toBe(`report_generate citation unavailable: ${token}`);
      expect(readFailures).toBe(fault === "read" ? 1 : 0);
      expect(query).not.toHaveBeenCalled();
      expect(collect).not.toHaveBeenCalled();
      expect(await treeOrAbsent(h.root)).toEqual(before);
      expect(await cardSnapshot(h)).toEqual(cardBefore);
    } finally {
      query.mockRestore();
      collect.mockRestore();
    }
  } finally {
    vi.mocked(fs.readFileSync).mockImplementation(native.readFileSync);
    await h.dispose();
  }
});

test.each([
  "PLAN-0001",
  "PLAN-20261108T093000-5C1E",
  "XPLAN-20261108T093000-5c1e",
  "PLAN-20261108T093000-5c1e_x",
  "PLAN-20261108T093000-5c1ex",
  "DEC-20261108T093000-5c1e",
])("non-citation %s stays literal without reading or creating analyses", async (text) => {
  const h = await reportHarness();
  try {
    await seedEvidence(h);
    const analyses = join(native.realpathSync.native(h.cwd), "analyses");
    expect(await treeOrAbsent(analyses)).toBeNull();
    vi.mocked(fs.readFileSync).mockClear();
    const report = generated(h, await h.invoke("report_generate", { ...DRAFT, summary: text }));
    expect(report.summary).toBe(text);
    expect(
      vi
        .mocked(fs.readFileSync)
        .mock.calls.filter(([target]) => String(target).startsWith(`${analyses}/`)),
    ).toHaveLength(0);
    expect(await treeOrAbsent(analyses)).toBeNull();
  } finally {
    await h.dispose();
  }
});

test.each(["parse", "missing"] as const)(
  "duplicate PLAN citations read once per preflight and observe %s on the next invocation",
  async (fault) => {
    const h = await reportHarness();
    try {
      await seedEvidence(h);
      const plan = createAnalysisPlan(h.cwd, analysisCase.schema.parse(analysisCase.value));
      const token = plan.analysis_plan_id;
      const path = join(native.realpathSync.native(h.cwd), "analyses", `${token}.json`);
      const authored = {
        ...DRAFT,
        summary: `${token}, ${token}`,
        observations: [token, token],
        limitations: [token],
        pi_questions: [token],
      };
      const query = vi.spyOn(h.registry, "listRunJobsByTask");
      const collect = vi.spyOn(h.registry, "collectShud");
      vi.mocked(fs.readFileSync).mockClear();
      try {
        expect(generated(h, await h.invoke("report_generate", authored)).summary).toBe(
          authored.summary,
        );
        expect(query).toHaveBeenCalledTimes(1);
        const firstQuery = query.mock.invocationCallOrder[0];
        const reads = vi
          .mocked(fs.readFileSync)
          .mock.calls.flatMap(([target], index) =>
            String(target) === path
              ? [vi.mocked(fs.readFileSync).mock.invocationCallOrder[index]]
              : [],
          );
        expect(reads).toHaveLength(1);
        expect(reads[0]).toBeLessThan(firstQuery);

        if (fault === "missing") fs.unlinkSync(path);
        else fs.writeFileSync(path, "PRIVATE_PLAN_CHANGED_BETWEEN_INVOCATIONS");
        const before = await treeOrAbsent(h.root);
        const cardBefore = await cardSnapshot(h);
        query.mockClear();
        collect.mockClear();
        vi.mocked(fs.readFileSync).mockClear();
        const message = expectReportError(
          await h.invoke("report_generate", authored),
          new RegExp(token, "u"),
        );
        expect(message).toBe(`report_generate citation unavailable: ${token}`);
        expect(query).not.toHaveBeenCalled();
        expect(collect).not.toHaveBeenCalled();
        expect(
          vi.mocked(fs.readFileSync).mock.calls.filter(([target]) => String(target) === path),
        ).toHaveLength(fault === "parse" ? 1 : 0);
        expect(await treeOrAbsent(h.root)).toEqual(before);
        expect(await cardSnapshot(h)).toEqual(cardBefore);
      } finally {
        query.mockRestore();
        collect.mockRestore();
      }
    } finally {
      await h.dispose();
    }
  },
);
