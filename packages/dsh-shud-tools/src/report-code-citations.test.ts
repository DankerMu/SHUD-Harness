import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { installUnsafe } from "../../dsh-shud-records/src/test-harness.ts";
import {
  DRAFT,
  expectReportError,
  generated,
  reportHarness,
  seedCodeChangeEvidence,
  seedEvidence,
} from "./report-workflow/test-harness.ts";
import { getCard, putCard, treeOrAbsent } from "./task-linked/test-harness.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
const native = await vi.importActual<typeof fs>("node:fs");
beforeEach(() => {
  vi.mocked(fs.readFileSync).mockReset().mockImplementation(native.readFileSync);
});

for (const kind of ["change", "verification", "build"] as const) {
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
    "root-fifo",
    "root-missing",
  ] as const)(`${kind} citation rejects %s before reconciliation`, async (fault) => {
    const h = await reportHarness();
    try {
      const { change, verification, runs } = await seedCodeChangeEvidence(h);
      const id =
        kind === "change"
          ? change.change_id
          : kind === "verification"
            ? verification.vc_id
            : runs[0].build.build_id;
      const root = join(
        native.realpathSync.native(h.cwd),
        kind === "change" ? "changes" : kind === "verification" ? "verifications" : "builds",
      );
      const path =
        kind === "build" ? join(root, id, "build-record.json") : join(root, `${id}.json`);
      putCard(h, { ...getCard(h), linked_jobs: [] });
      let readFailures = 0;
      if (fault === "missing") fs.unlinkSync(path);
      else if (fault === "parse") fs.writeFileSync(path, "PRIVATE_CITATION_PAYLOAD");
      else if (fault === "schema")
        fs.writeFileSync(path, JSON.stringify({ created_at: "PRIVATE_CITATION_PAYLOAD" }));
      else if (fault === "identity") {
        const value = JSON.parse(fs.readFileSync(path, "utf8")) as Record<string, unknown>;
        const field =
          kind === "change" ? "change_id" : kind === "verification" ? "vc_id" : "build_id";
        const foreign = `${id.slice(0, -4)}eeee`;
        fs.writeFileSync(
          path,
          JSON.stringify({
            ...value,
            [field]: foreign,
            ...(kind === "change"
              ? { patch_path: `patches/${foreign}.patch` }
              : kind === "build"
                ? {
                    binary_path: `builds/${foreign}/shud`,
                    stdout_path: `builds/${foreign}/make.stdout.log`,
                    stderr_path: `builds/${foreign}/make.stderr.log`,
                  }
                : {}),
          }),
        );
      } else if (fault === "read")
        vi.mocked(fs.readFileSync).mockImplementation((...args) => {
          if (String(args[0]) === path) {
            readFailures++;
            throw Object.assign(new Error("PRIVATE_CITATION_PAYLOAD"), { code: "EACCES" });
          }
          return native.readFileSync(...args);
        });
      else if (fault.startsWith("root-")) {
        const outside = join(h.root, "outside-root");
        fs.renameSync(root, outside);
        if (fault !== "root-missing")
          installUnsafe(
            root,
            fault === "root-file" ? "file" : fault === "root-fifo" ? "fifo" : "symlink",
            outside,
          );
      } else {
        const outside = join(h.root, "outside-fact");
        fs.renameSync(path, outside);
        installUnsafe(path, fault as "directory" | "fifo" | "symlink" | "dangling-link", outside);
      }
      const before = await treeOrAbsent(h.root);
      const query = vi.spyOn(h.registry, "listRunJobsByTask");
      const collect = vi.spyOn(h.registry, "collectShud");
      try {
        const message = expectReportError(
          await h.invoke("report_generate", { ...DRAFT, summary: `Cites (${id}).` }),
          new RegExp(id, "u"),
        );
        expect(message).not.toContain("PRIVATE_");
        expect(readFailures).toBe(fault === "read" ? 1 : 0);
        expect(query).not.toHaveBeenCalled();
        expect(collect).not.toHaveBeenCalled();
        expect(await treeOrAbsent(h.root)).toEqual(before);
      } finally {
        query.mockRestore();
        collect.mockRestore();
      }
    } finally {
      vi.mocked(fs.readFileSync).mockImplementation(native.readFileSync);
      await h.dispose();
    }
  });
}

test.each(["missing", "file", "symlink", "fifo"] as const)(
  "build citation rejects %s intermediate build directory",
  async (fault) => {
    const h = await reportHarness();
    try {
      const { runs } = await seedCodeChangeEvidence(h);
      const build = runs[0].build;
      const directory = dirname(join(h.cwd, "builds", build.build_id, "build-record.json"));
      const outside = join(h.root, "outside-build");
      fs.renameSync(directory, outside);
      if (fault !== "missing") installUnsafe(directory, fault, outside);
      const before = await treeOrAbsent(h.root);
      expectReportError(
        await h.invoke("report_generate", { ...DRAFT, summary: build.build_id }),
        new RegExp(build.build_id, "u"),
      );
      expect(await treeOrAbsent(h.root)).toEqual(before);
    } finally {
      await h.dispose();
    }
  },
);

test("all three governance citation kinds resolve once during preflight across authored fields", async () => {
  const h = await reportHarness();
  try {
    const { change, verification, runs } = await seedCodeChangeEvidence(h);
    const physical = native.realpathSync.native(h.cwd);
    const paths = [
      join(physical, "changes", `${change.change_id}.json`),
      join(physical, "verifications", `${verification.vc_id}.json`),
      join(physical, "builds", runs[0].build.build_id, "build-record.json"),
    ];
    const text = [change.change_id, verification.vc_id, runs[0].build.build_id].join(", ");
    const query = vi.spyOn(h.registry, "listRunJobsByTask");
    vi.mocked(fs.readFileSync).mockClear();
    try {
      const report = generated(
        h,
        await h.invoke("report_generate", {
          ...DRAFT,
          summary: text,
          observations: [text, text],
          limitations: [text],
          pi_questions: [text],
        }),
      );
      expect(report.summary).toBe(text);
      const firstQuery = query.mock.invocationCallOrder[0];
      for (const path of paths) {
        const reads = vi
          .mocked(fs.readFileSync)
          .mock.calls.filter(
            ([target], index) =>
              String(target) === path &&
              vi.mocked(fs.readFileSync).mock.invocationCallOrder[index] < firstQuery,
          );
        expect(reads).toHaveLength(1);
      }
    } finally {
      query.mockRestore();
    }
  } finally {
    await h.dispose();
  }
});

for (const prefix of ["CHG", "VC", "BUILD"] as const) {
  test.each(["observations", "limitations", "pi_questions"] as const)(
    `${prefix} citation in %s is checked`,
    async (field) => {
      const h = await reportHarness();
      try {
        await seedEvidence(h);
        const token = `${prefix}-20991231T235959-ffff`;
        const before = await treeOrAbsent(h.cwd);
        expectReportError(
          await h.invoke("report_generate", { ...DRAFT, [field]: [token] }),
          new RegExp(token, "u"),
        );
        expect(await treeOrAbsent(h.cwd)).toEqual(before);
      } finally {
        await h.dispose();
      }
    },
  );
  test.each(["leading", "trailing", "short", "uppercase"] as const)(
    `${prefix} %s non-citation stays literal`,
    async (variant) => {
      const h = await reportHarness();
      try {
        await seedEvidence(h);
        const token = `${prefix}-20991231T235959-ffff`;
        const text =
          variant === "leading"
            ? `x${token}`
            : variant === "trailing"
              ? `${token}x`
              : variant === "short"
                ? `${prefix}-0001`
                : token.toUpperCase();
        expect(
          generated(h, await h.invoke("report_generate", { ...DRAFT, summary: text })).summary,
        ).toBe(text);
      } finally {
        await h.dispose();
      }
    },
  );
}
