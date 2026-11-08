import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  AnalysisPlanSchema,
  BuildRecordSchema,
  ChangeRequestSchema,
  DataProvenanceSchema,
  TaskCardSchema,
  VerificationCaseSchema,
} from "@shud-harness/dsh-shud-core";
import {
  createAnalysisPlan,
  createTaskCard,
  createDataProvenance,
  createEvidenceReport,
  createChangeRequest,
  createVerificationCase,
  publishBuildDirectory,
  readChangePatch,
  readReportMarkdown,
  readWorkspaceRecord,
  rewriteChangeRequest,
  verifyBuildBinary,
  writeChangePatch,
  writeReportMarkdown,
  writeWorkspaceRecord,
} from "./index.ts";
import { installUnsafe, mutableCases, recordCases, reportCase, taskCase } from "./test-harness.ts";
import {
  analysisCase,
  buildCase,
  changeCase,
  verificationCase,
  workspaceFileCases,
} from "./workspace-files-test-harness.ts";
import { makeEvidenceReport } from "./report-render-test-harness.ts";

const cases = [...recordCases, ...workspaceFileCases];
const modes = ["ordinary", "alias", "physical-parent"] as const;
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), "physical-workspace-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function workspace(mode: (typeof modes)[number]) {
  const original = join(root, "workspace");
  fs.mkdirSync(join(original, "child"), { recursive: true });
  const physical = fs.realpathSync.native(original);
  const alias = join(root, "cwd-alias");
  fs.symlinkSync(mode === "physical-parent" ? join(physical, "child") : physical, alias);
  const cwd = mode === "ordinary" ? original : mode === "alias" ? alias : `${alias}/..`;
  expect(fs.realpathSync.native(cwd)).toBe(physical);
  return { cwd, physical };
}
function seed(path: string, value: unknown) {
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, JSON.stringify(value));
}
function snapshot(path: string) {
  const { dev, ino, mtimeNs } = fs.statSync(path, { bigint: true });
  return { bytes: fs.readFileSync(path), dev, ino, mtimeNs };
}
function lexicalNamespace() {
  const entries: {
    path: string;
    dev: bigint;
    ino: bigint;
    mode: bigint;
    mtimeNs: bigint;
    link: string | null;
  }[] = [];
  function visit(directory: string, relative: string): void {
    for (const name of fs.readdirSync(directory).sort()) {
      if (relative === "" && name === "workspace") continue;
      const path = join(directory, name);
      const entry = join(relative, name);
      const stat = fs.lstatSync(path, { bigint: true });
      entries.push({
        path: entry,
        dev: stat.dev,
        ino: stat.ino,
        mode: stat.mode,
        mtimeNs: stat.mtimeNs,
        link: stat.isSymbolicLink() ? fs.readlinkSync(path) : null,
      });
      if (stat.isDirectory()) visit(path, entry);
    }
  }
  visit(root, "");
  return entries;
}
function decoy(fixture: (typeof cases)[number]) {
  switch (fixture.kind) {
    case "task":
      return { ...fixture.value, title: "LEXICAL_SENTINEL" };
    case "stack":
      return {
        ...fixture.value,
        llm: { ...fixture.value.llm, response_model: "LEXICAL_SENTINEL" },
      };
    case "data":
      return { ...fixture.value, basin: "LEXICAL_SENTINEL" };
    case "report":
      return { ...fixture.value, summary: "LEXICAL_SENTINEL" };
    case "change":
    case "verification":
      return { ...fixture.value, description: "LEXICAL_SENTINEL" };
    case "build":
      return { ...fixture.value, compiler: "LEXICAL_SENTINEL" };
    case "analysis":
      return { ...fixture.value, created_by: "LEXICAL_SENTINEL" };
  }
}

describe.each(modes)("%s workspace routing", (mode) => {
  test.each(cases)(
    "$kind reads select physical schema-valid identity and preserve both records",
    (fixture) => {
      const { cwd, physical } = workspace(mode);
      const lexical = join(root, fixture.relative);
      const actual = join(physical, fixture.relative);
      seed(lexical, decoy(fixture));
      seed(actual, fixture.value);
      const before = [snapshot(lexical), snapshot(actual)];
      expect(readWorkspaceRecord(root, fixture.kind, fixture.id, { readonly: true })).toMatchObject(
        decoy(fixture),
      );
      expect(
        readWorkspaceRecord(physical, fixture.kind, fixture.id, { readonly: true }),
      ).toMatchObject(fixture.value);
      expect(readWorkspaceRecord(cwd, fixture.kind, fixture.id, { readonly: true })).toMatchObject(
        fixture.value,
      );
      expect(readWorkspaceRecord(cwd, fixture.kind, fixture.id)).toMatchObject(fixture.value);
      expect([snapshot(lexical), snapshot(actual)]).toEqual(before);
    },
  );

  test.each(cases)(
    "$kind missing physical root never reads a populated lexical root",
    (fixture) => {
      const { cwd, physical } = workspace(mode);
      const lexical = join(root, fixture.relative);
      seed(lexical, fixture.value);
      const before = snapshot(lexical);
      expect(() => readWorkspaceRecord(cwd, fixture.kind, fixture.id, { readonly: true })).toThrow(
        /missing/u,
      );
      expect(fs.readdirSync(physical)).toEqual(["child"]);
      expect(snapshot(lexical)).toEqual(before);
      expect(() => readWorkspaceRecord(cwd, fixture.kind, fixture.id)).toThrow(/missing/u);
      expect(fs.existsSync(join(physical, fixture.directory))).toBe(true);
      expect(fs.existsSync(join(physical, fixture.relative))).toBe(false);
      expect(snapshot(lexical)).toEqual(before);
    },
  );

  test("all writer owners publish only physical records, patches, Markdown and build artifacts", async () => {
    const { cwd, physical } = workspace(mode);
    const lexical = cases.map((fixture) => {
      const path = join(root, fixture.relative);
      seed(path, decoy(fixture));
      return { path, before: snapshot(path) };
    });
    const lexicalPatch = join(root, "patches", `${changeCase.id}.patch`);
    seed(lexicalPatch, "LEXICAL_PATCH_SENTINEL");
    const patchBefore = snapshot(lexicalPatch);
    const entries = lexicalNamespace();
    for (const fixture of mutableCases) {
      writeWorkspaceRecord(cwd, fixture.kind, fixture.value);
      expect(
        readWorkspaceRecord(physical, fixture.kind, fixture.id, { readonly: true }),
      ).toMatchObject(fixture.value);
    }
    const task = createTaskCard(cwd, TaskCardSchema.parse(taskCase.value));
    expect(readWorkspaceRecord(physical, "task", task.task_id, { readonly: true })).toEqual(task);
    const data = createDataProvenance(
      cwd,
      DataProvenanceSchema.parse(recordCases.find((entry) => entry.kind === "data")?.value),
    );
    expect(readWorkspaceRecord(physical, "data", data.data_id, { readonly: true })).toEqual(data);
    const report = createEvidenceReport(cwd, makeEvidenceReport());
    expect(readWorkspaceRecord(physical, "report", report.report_id, { readonly: true })).toEqual(
      report,
    );
    await writeReportMarkdown(cwd, report.report_id, "PHYSICAL_MARKDOWN_SENTINEL");
    expect(readReportMarkdown(cwd, report.report_id)).toBe("PHYSICAL_MARKDOWN_SENTINEL");
    expect(fs.readFileSync(join(physical, "reports", `${report.report_id}.md`), "utf8")).toBe(
      "PHYSICAL_MARKDOWN_SENTINEL",
    );
    const change = createChangeRequest(cwd, ChangeRequestSchema.parse(changeCase.value));
    expect(change.change_id).toBe(changeCase.id);
    writeChangePatch(cwd, change.change_id, "abc");
    expect(readChangePatch(cwd, change.change_id, { readonly: true })).toEqual(Buffer.from("abc"));
    expect(fs.readFileSync(join(physical, change.patch_path), "utf8")).toBe("abc");
    rewriteChangeRequest(cwd, { ...change, description: "PHYSICAL_UPDATED_DESCRIPTION" });
    expect(
      readWorkspaceRecord(physical, "change", change.change_id, { readonly: true }).description,
    ).toBe("PHYSICAL_UPDATED_DESCRIPTION");
    const verification = createVerificationCase(
      cwd,
      VerificationCaseSchema.parse(verificationCase.value),
    );
    expect(
      readWorkspaceRecord(physical, "verification", verification.vc_id, { readonly: true }),
    ).toEqual(verification);
    const analysis = createAnalysisPlan(cwd, AnalysisPlanSchema.parse(analysisCase.value));
    expect(
      readWorkspaceRecord(physical, "analysis", analysis.analysis_plan_id, { readonly: true }),
    ).toEqual(analysis);
    const build = await publishBuildDirectory(cwd, async (directory, id) => {
      expect(dirname(directory)).toBe(join(physical, "builds"));
      fs.writeFileSync(join(directory, "shud"), "abc", { mode: 0o755 });
      return Promise.resolve(
        BuildRecordSchema.parse({
          ...buildCase.value,
          build_id: id,
          binary_path: `builds/${id}/shud`,
          stdout_path: `builds/${id}/make.stdout.log`,
          stderr_path: `builds/${id}/make.stderr.log`,
        }),
      );
    });
    expect(readWorkspaceRecord(physical, "build", build.build_id, { readonly: true })).toEqual(
      build,
    );
    expect(verifyBuildBinary(cwd, build)).toBeUndefined();
    expect(fs.readFileSync(join(physical, build.binary_path), "utf8")).toBe("abc");
    for (const { path, before } of lexical) expect(snapshot(path)).toEqual(before);
    expect(snapshot(lexicalPatch)).toEqual(patchBefore);
    expect(lexicalNamespace()).toEqual(entries);
  });
});

test.each(cases)(
  "$kind readonly missing cwd stays absent; legacy creation remains recursive",
  (fixture) => {
    const missing = join(root, "missing", "workspace");
    expect(() =>
      readWorkspaceRecord(missing, fixture.kind, fixture.id, { readonly: true }),
    ).toThrow(/missing/u);
    expect(fs.readdirSync(root)).toEqual([]);
    expect(() => readWorkspaceRecord(missing, fixture.kind, fixture.id)).toThrow(/missing/u);
    expect(fs.existsSync(join(missing, fixture.directory))).toBe(true);
    expect(fs.existsSync(join(missing, fixture.relative))).toBe(false);
  },
);

test("writers retain recursive creation when cwd itself is missing", async () => {
  const missing = join(root, "missing", "workspace");
  const task = createTaskCard(missing, TaskCardSchema.parse(taskCase.value));
  const report = createEvidenceReport(join(missing, "nested"), makeEvidenceReport());
  await writeReportMarkdown(join(missing, "markdown"), report.report_id, "created recursively");
  writeWorkspaceRecord(join(missing, "mutable"), "report", reportCase.value);
  expect(readWorkspaceRecord(missing, "task", task.task_id, { readonly: true })).toEqual(task);
  expect(
    readWorkspaceRecord(join(missing, "nested"), "report", report.report_id, { readonly: true }),
  ).toEqual(report);
  expect(readReportMarkdown(join(missing, "markdown"), report.report_id)).toBe(
    "created recursively",
  );
  expect(
    readWorkspaceRecord(join(missing, "mutable"), "report", reportCase.id, { readonly: true }),
  ).toMatchObject(reportCase.value);
});

for (const fixture of cases) {
  test.each(["symlink", "dangling-link", "file", "fifo"] as const)(
    `${fixture.kind} rejects a %s physical managed root before lexical fallback`,
    (kind) => {
      const { cwd, physical } = workspace("physical-parent");
      const foreign = join(root, "foreign");
      const target = join(foreign, fixture.relative);
      seed(target, fixture.value);
      seed(join(root, fixture.relative), decoy(fixture));
      const before = snapshot(target);
      installUnsafe(join(physical, fixture.directory), kind, join(foreign, fixture.directory));
      expect(() => readWorkspaceRecord(cwd, fixture.kind, fixture.id, { readonly: true })).toThrow(
        /directory/u,
      );
      expect(snapshot(target)).toEqual(before);
    },
  );
  test.each(["symlink", "dangling-link", "directory", "fifo"] as const)(
    `${fixture.kind} rejects a %s physical target without reading foreign bytes`,
    (kind) => {
      const { cwd, physical } = workspace("physical-parent");
      const foreign = join(root, "foreign.json");
      seed(foreign, fixture.value);
      const before = snapshot(foreign);
      const target = join(physical, fixture.relative);
      fs.mkdirSync(dirname(target), { recursive: true });
      installUnsafe(target, kind, foreign);
      expect(() => readWorkspaceRecord(cwd, fixture.kind, fixture.id, { readonly: true })).toThrow(
        /target/u,
      );
      expect(snapshot(foreign)).toEqual(before);
    },
  );
}

test("binary, patch and Markdown readonly absence cannot select populated lexical roots", () => {
  const { cwd, physical } = workspace("physical-parent");
  const build = BuildRecordSchema.parse(buildCase.value);
  const change = ChangeRequestSchema.parse(changeCase.value);
  const report = makeEvidenceReport();
  const paths = [
    join(root, build.binary_path),
    join(root, change.patch_path),
    join(root, "reports", `${report.report_id}.md`),
  ];
  for (const path of paths) {
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.writeFileSync(path, "abc", { mode: 0o755 });
  }
  const before = paths.map(snapshot);
  expect(() => verifyBuildBinary(cwd, build)).toThrow(/missing/u);
  expect(() => readChangePatch(cwd, change.change_id, { readonly: true })).toThrow(/missing/u);
  expect(readReportMarkdown(cwd, report.report_id)).toBeUndefined();
  expect(fs.readdirSync(physical)).toEqual(["child"]);
  expect(paths.map(snapshot)).toEqual(before);
  const missing = join(root, "missing-cwd");
  expect(() => verifyBuildBinary(missing, build)).toThrow(/missing/u);
  expect(() => readChangePatch(missing, change.change_id, { readonly: true })).toThrow(/missing/u);
  expect(readReportMarkdown(missing, report.report_id)).toBeUndefined();
  expect(fs.existsSync(missing)).toBe(false);
});

test("flat and exclusive creators and the build producer create missing cwd recursively", async () => {
  const dataCwd = join(root, "absent-data", "workspace");
  const data = createDataProvenance(
    dataCwd,
    DataProvenanceSchema.parse(recordCases.find((entry) => entry.kind === "data")?.value),
  );
  expect(readWorkspaceRecord(dataCwd, "data", data.data_id, { readonly: true })).toEqual(data);
  const changeCwd = join(root, "absent-change", "workspace");
  const change = createChangeRequest(changeCwd, ChangeRequestSchema.parse(changeCase.value));
  writeChangePatch(changeCwd, change.change_id, "abc");
  expect(readChangePatch(changeCwd, change.change_id, { readonly: true })).toEqual(
    Buffer.from("abc"),
  );
  const vcCwd = join(root, "absent-verification", "workspace");
  const vc = createVerificationCase(vcCwd, VerificationCaseSchema.parse(verificationCase.value));
  expect(readWorkspaceRecord(vcCwd, "verification", vc.vc_id, { readonly: true })).toEqual(vc);
  const analysisCwd = join(root, "absent-analysis", "workspace");
  const analysis = createAnalysisPlan(analysisCwd, AnalysisPlanSchema.parse(analysisCase.value));
  expect(
    readWorkspaceRecord(analysisCwd, "analysis", analysis.analysis_plan_id, { readonly: true }),
  ).toEqual(analysis);
  const buildCwd = join(root, "absent-build", "workspace");
  const physicalBuilds = join(fs.realpathSync.native(root), "absent-build", "workspace", "builds");
  const build = await publishBuildDirectory(buildCwd, async (directory, id) => {
    expect(dirname(directory)).toBe(physicalBuilds);
    fs.writeFileSync(join(directory, "shud"), "abc", { mode: 0o755 });
    return Promise.resolve(
      BuildRecordSchema.parse({
        ...buildCase.value,
        build_id: id,
        binary_path: `builds/${id}/shud`,
        stdout_path: `builds/${id}/make.stdout.log`,
        stderr_path: `builds/${id}/make.stderr.log`,
      }),
    );
  });
  expect(verifyBuildBinary(buildCwd, build)).toBeUndefined();
  expect(readWorkspaceRecord(buildCwd, "build", build.build_id, { readonly: true })).toEqual(build);
});

for (const operation of [
  "mutable",
  "task",
  "data",
  "report",
  "change",
  "verification",
  "analysis",
  "patch",
  "markdown",
  "build",
] as const) {
  test.each(["symlink", "dangling-link", "file", "fifo"] as const)(
    `${operation} writer rejects a %s physical root without changing foreign or lexical bytes`,
    async (kind) => {
      const { cwd, physical } = workspace("physical-parent");
      const directory = {
        mutable: "reports",
        task: "tasks",
        data: "provenance",
        report: "reports",
        change: "changes",
        verification: "verifications",
        analysis: "analyses",
        patch: "patches",
        markdown: "reports",
        build: "builds",
      }[operation];
      const foreign = join(root, "foreign");
      const sentinel = join(foreign, "sentinel");
      const lexical = join(root, directory, "sentinel");
      seed(sentinel, "FOREIGN_SENTINEL");
      seed(lexical, "LEXICAL_SENTINEL");
      const before = [snapshot(sentinel), snapshot(lexical)];
      const change = ChangeRequestSchema.parse(changeCase.value);
      if (operation === "patch") seed(join(physical, changeCase.relative), change);
      installUnsafe(join(physical, directory), kind, foreign);
      let producerCalled = false;
      const act = async () => {
        switch (operation) {
          case "mutable":
            return writeWorkspaceRecord(cwd, "report", reportCase.value);
          case "task":
            return createTaskCard(cwd, TaskCardSchema.parse(taskCase.value));
          case "data":
            return createDataProvenance(
              cwd,
              DataProvenanceSchema.parse(recordCases.find((entry) => entry.kind === "data")?.value),
            );
          case "report":
            return createEvidenceReport(cwd, makeEvidenceReport());
          case "change":
            return createChangeRequest(cwd, change);
          case "verification":
            return createVerificationCase(
              cwd,
              VerificationCaseSchema.parse(verificationCase.value),
            );
          case "analysis":
            return createAnalysisPlan(cwd, AnalysisPlanSchema.parse(analysisCase.value));
          case "patch":
            return writeChangePatch(cwd, change.change_id, "abc");
          case "markdown":
            return writeReportMarkdown(cwd, makeEvidenceReport().report_id, "must not publish");
          case "build":
            return publishBuildDirectory(cwd, async () => {
              producerCalled = true;
              return Promise.reject(new Error("Unexpected producer invocation"));
            });
        }
      };
      await expect(act()).rejects.toThrow(/directory/u);
      expect(producerCalled).toBe(false);
      expect([snapshot(sentinel), snapshot(lexical)]).toEqual(before);
      expect(fs.readdirSync(foreign)).toEqual(["sentinel"]);
      expect(fs.readdirSync(join(root, directory))).toEqual(["sentinel"]);
    },
  );
}

test.each(mutableCases)(
  "$kind mutable publication creates a missing cwd recursively",
  (fixture) => {
    const missing = join(root, "missing", "workspace");
    writeWorkspaceRecord(missing, fixture.kind, fixture.value);
    expect(
      readWorkspaceRecord(missing, fixture.kind, fixture.id, { readonly: true }),
    ).toMatchObject(fixture.value);
    expect(fs.readFileSync(join(missing, fixture.relative), "utf8")).toContain(fixture.id);
  },
);

test("legacy patch reads create a missing cwd and patches root but never the patch", () => {
  const missing = join(root, "missing", "workspace");
  const change = ChangeRequestSchema.parse(changeCase.value);
  expect(() => readChangePatch(missing, change.change_id)).toThrow(/missing/u);
  expect(fs.readdirSync(missing)).toEqual(["patches"]);
  expect(fs.readdirSync(join(missing, "patches"))).toEqual([]);
});
