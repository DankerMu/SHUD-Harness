import * as fs from "node:fs";
import * as io from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import {
  FORBIDDEN_REPORT_PHRASES,
  VerificationCaseSchema,
  VerificationIdSchema,
} from "@shud-harness/dsh-shud-core";
import { readWorkspaceRecord } from "@shud-harness/dsh-shud-records";
import { expect, test, vi } from "vitest";
import { resultValue } from "./report-workflow/test-harness.ts";
import {
  fixturePaths,
  PRIVATE,
  rejectedUnchanged,
  verificationArgs,
} from "./verification-run/matrix/test-harness.ts";
import {
  COMPARED_PATH,
  OUTPUT_SHA256,
  verificationHarness,
} from "./verification-run/test-harness.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    lstatSync: vi.fn(actual.lstatSync),
    readFileSync: vi.fn(actual.readFileSync),
    openSync: vi.fn(actual.openSync),
    mkdirSync: vi.fn(actual.mkdirSync),
    realpathSync: Object.assign(vi.fn(actual.realpathSync), {
      native: vi.fn(actual.realpathSync.native),
    }),
  };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof io>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
function noToolIO() {
  for (const operation of [
    fs.lstatSync,
    fs.readFileSync,
    fs.openSync,
    fs.mkdirSync,
    fs.realpathSync.native,
    io.readFile,
  ]) {
    expect(operation).not.toHaveBeenCalled();
  }
}

const invalid = [
  ["task_id", "TASK-invalid"],
  ["task_id", "../task"],
  ["task_id", null],
  ["base_run_id", "RUN-invalid"],
  ["base_run_id", 7],
  ["candidate_run_id", "RUN-invalid"],
  ["candidate_run_id", null],
  ["reviewer_notes", []],
  ["reviewer_notes", [""]],
  ["reviewer_notes", ["valid", ""]],
  ["reviewer_notes", "not an array"],
  ["reviewer_notes", [1]],
  ["compatibility_verdict", "accepted"],
  ["compatibility_verdict", null],
  ["unknown_option", true],
] as const;
test.each(invalid)("invalid %s=%j is rejected before evidence IO", async (field, value) => {
  const h = await verificationHarness();
  try {
    vi.clearAllMocks();
    await rejectedUnchanged(h, { ...verificationArgs(h), [field]: value });
    noToolIO();
  } finally {
    await h.dispose();
  }
});
test.each([
  "task_id",
  "base_run_id",
  "candidate_run_id",
  "reviewer_notes",
  "compatibility_verdict",
])("missing required %s is rejected before evidence IO", async (field) => {
  const h = await verificationHarness();
  try {
    const args: Record<string, unknown> = verificationArgs(h);
    delete args[field];
    vi.clearAllMocks();
    await rejectedUnchanged(h, args);
    noToolIO();
  } finally {
    await h.dispose();
  }
});
test.each([undefined, null, [], "not an object", 42])(
  "non-object arguments %j fail before IO",
  async (args) => {
    const h = await verificationHarness();
    try {
      // Undefined is an omitted-call case rather than the harness's valid default.
      const value = args === undefined ? {} : args;
      vi.clearAllMocks();
      await rejectedUnchanged(h, value);
      noToolIO();
    } finally {
      await h.dispose();
    }
  },
);

test.each([undefined, ""])(
  "session cwd %j is rejected before tool IO or registry queries",
  async (cwd) => {
    const h = await verificationHarness();
    const list = vi.spyOn(h.registry, "listRunJobsByTask");
    const collect = vi.spyOn(h.registry, "collectShud");
    try {
      Object.assign(h.agent.session.header, { cwd });
      vi.clearAllMocks();
      await rejectedUnchanged(h, verificationArgs(h), /cwd|workspace/iu);
      expect(list).not.toHaveBeenCalled();
      expect(collect).not.toHaveBeenCalled();
      noToolIO();
    } finally {
      Object.assign(h.agent.session.header, { cwd: h.cwd });
      list.mockRestore();
      collect.mockRestore();
      await h.dispose();
    }
  },
);

test.each(FORBIDDEN_REPORT_PHRASES)(
  "forbidden reviewer phrase %s is rejected at its note index",
  async (phrase) => {
    const h = await verificationHarness();
    try {
      const args = {
        ...verificationArgs(h),
        reviewer_notes: ["Engineering evidence only.", `${PRIVATE}: ${phrase}`],
      };
      vi.clearAllMocks();
      const message = await rejectedUnchanged(h, args, /reviewer_notes\[1\]/u);
      expect(message).not.toContain(phrase);
      noToolIO();
    } finally {
      await h.dispose();
    }
  },
);

for (const equal of [true, false]) {
  test.each(["compatible", "incompatible", "unknown"] as const)(
    `compatibility %s and verbatim notes do not override equal=${equal}`,
    async (compatibility) => {
      const h = await verificationHarness();
      try {
        if (!equal) await io.writeFile(join(h.candidate.job.run_dir, COMPARED_PATH), "");
        const notes = [
          "  Preserve leading and trailing whitespace.  ",
          "\nEngineering-only note.\n",
          " ",
        ];
        const value = resultValue(
          await h.invoke({
            ...verificationArgs(h),
            compatibility_verdict: compatibility,
            reviewer_notes: notes,
          }),
        );
        const id = VerificationIdSchema.parse(value.vc_id);
        const record = VerificationCaseSchema.parse(
          readWorkspaceRecord(h.cwd, "verification", id, { readonly: true }),
        );
        expect(record.reviewer_notes).toEqual(notes);
        expect(record.compatibility_verdict).toBe(compatibility);
        expect(record.status).toBe(equal ? "passed" : "failed");
        expect(value.status).toBe(equal ? "passed" : "failed");
        expect(record.observed.base_sha256).toBe(OUTPUT_SHA256);
        expect(record.observed.candidate_sha256).toBe(
          equal
            ? OUTPUT_SHA256
            : "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        );
      } finally {
        await h.dispose();
      }
    },
  );
}

test.each(["coder", "worker", "coordinator"])(
  "current %s role is denied by actual policy before execution",
  async (preset) => {
    const h = await verificationHarness({ policy: true });
    try {
      // The header disagrees deliberately; policy must consume the current projection.
      Object.assign(h.agent.session.header, { agentPreset: "reviewer" });
      h.current.preset = preset;
      let executions = 0;
      await h.ctx.plugin((ctx: Context) => {
        ctx.on("tools/execute", (_event, next) => {
          executions++;
          return next();
        });
      });
      await rejectedUnchanged(h);
      expect(executions).toBe(0);
    } finally {
      await h.dispose();
    }
  },
);

test.each([
  ["reviewer", "reviewer"],
  ["custom-reviewer-540", "custom-reviewer-540"],
  [undefined, "unknown"],
  [null, "unknown"],
  ["", "unknown"],
])("current projection %j owns reviewed_by=%s through actual policy", async (preset, expected) => {
  const h = await verificationHarness({ policy: true });
  try {
    h.current.preset = preset;
    const value = resultValue(await h.invoke());
    const record = readWorkspaceRecord(
      h.cwd,
      "verification",
      VerificationIdSchema.parse(value.vc_id),
      { readonly: true },
    );
    expect(record.reviewed_by).toBe(expected);
    expect(fs.existsSync(fixturePaths(h, "base").task)).toBe(true);
  } finally {
    await h.dispose();
  }
});
