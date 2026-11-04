import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import {
  CHANGE_APPROVAL_REASON_PREFIX,
  CHANGE_PATCH_MISMATCH_REASON,
  INVALID_CHANGE_ID_MARKER,
} from "./index.ts";
import {
  CHANGE_ID,
  createPolicyHarness,
  expectAsk,
  snapshotFile,
  writeProposedChange,
} from "./test-harness.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    mkdirSync: vi.fn(actual.mkdirSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    renameSync: vi.fn(actual.renameSync),
  };
});
const native = await vi.importActual<typeof fs>("node:fs");
beforeEach(() => {
  vi.mocked(fs.readFileSync).mockReset().mockImplementation(native.readFileSync);
  vi.mocked(fs.mkdirSync).mockClear();
  vi.mocked(fs.writeFileSync).mockClear();
  vi.mocked(fs.renameSync).mockClear();
});
const levels = [
  { level: "pure_engineering", risk: "low", kind: "cancel" },
  { level: "io_format", risk: "medium", kind: "cancel" },
  { level: "output_semantics", risk: "high", kind: "ask" },
  { level: "numerical_implementation", risk: "high", kind: "ask" },
  { level: "parameter_default", risk: "high", kind: "ask" },
  { level: "physical_equation", risk: "high", kind: "ask" },
  { level: "model_assumption", risk: "high", kind: "ask" },
] as const;
function noWrites() {
  expect(fs.mkdirSync).not.toHaveBeenCalled();
  expect(fs.writeFileSync).not.toHaveBeenCalled();
  expect(fs.renameSync).not.toHaveBeenCalled();
}

for (const preset of ["coder", "unknown", "worker", "reviewer", "coordinator"] as const) {
  test.each(levels)(
    `${preset} change_submit $level obeys role then level`,
    async ({ level, risk, kind }) => {
      const h = await createPolicyHarness({ preset });
      try {
        const fixture = await writeProposedChange(h.cwd, {
          semantic_level: level,
          semantic_floor: level,
          floor_categories: [level],
          risk,
        });
        const paths = [fixture.changePath, fixture.taskPath, fixture.patchPath];
        const before = await Promise.all(paths.map(snapshotFile));
        vi.clearAllMocks();
        const denied = preset !== "coder" && preset !== "unknown";
        const result = await h.decide("change_submit", { change_id: CHANGE_ID });
        expect(result.kind).toBe(denied ? "deny" : kind);
        expect(h.next).toHaveBeenCalledTimes(!denied && kind === "cancel" ? 1 : 0);
        if (denied) {
          expect(fs.readFileSync).not.toHaveBeenCalled();
          expect(h.policyLogs()).toEqual([["deny change_submit role-tool-surface"]]);
        } else if (kind === "cancel") expect(h.policyLogs()).toEqual([]);
        else expectAsk(result);
        expect(h.request).not.toHaveBeenCalled();
        noWrites();
        expect(await Promise.all(paths.map(snapshotFile))).toEqual(before);
      } finally {
        await h.dispose();
      }
    },
  );
}

for (const { level, risk } of levels) {
  for (const status of ["proposed", "approved"] as const) {
    test(`${level} ${status} mismatched patch denies before ask or delegation`, async () => {
      const h = await createPolicyHarness({ preset: "coder" });
      try {
        const fixture = await writeProposedChange(h.cwd, {
          semantic_level: level,
          semantic_floor: level,
          floor_categories: [level],
          risk,
          status,
          approval_ref: status === "approved" ? "prior-call" : null,
          approved_at: status === "approved" ? "2026-11-02T09:01:00Z" : null,
        });
        native.writeFileSync(fixture.patchPath, "abd");
        vi.clearAllMocks();
        expect(await h.decide("change_submit", { change_id: CHANGE_ID })).toEqual({
          kind: "deny",
          reason: CHANGE_PATCH_MISMATCH_REASON,
        });
        expect(h.policyLogs()).toEqual([[`deny change_submit change-patch-mismatch ${CHANGE_ID}`]]);
        expect(h.next).not.toHaveBeenCalled();
        noWrites();
      } finally {
        await h.dispose();
      }
    });
  }
}

for (const part of ["change", "patch"] as const) {
  for (const fault of [
    "missing-root",
    "root-file",
    "missing",
    "symlink",
    "directory",
    "fifo",
    "read-error",
    "root-symlink",
  ] as const) {
    for (const low of [false, true]) {
      test(`${low ? "low" : "high"} risk ${part} ${fault} asks readonly without unsafe reads`, async () => {
        const h = await createPolicyHarness({ preset: "coder" });
        try {
          const fixture = await writeProposedChange(
            h.cwd,
            low
              ? {
                  semantic_level: "pure_engineering",
                  semantic_floor: "pure_engineering",
                  floor_categories: ["pure_engineering"],
                  risk: "low",
                }
              : {},
          );
          const path = part === "change" ? fixture.changePath : fixture.patchPath;
          const root = join(h.cwd, part === "change" ? "changes" : "patches");
          const outside = join(h.root, "private-outside");
          if (fault === "missing-root") native.rmSync(root, { recursive: true });
          else if (fault === "root-file") {
            native.rmSync(root, { recursive: true });
            native.writeFileSync(root, "not a directory");
          } else if (fault === "root-symlink") {
            native.renameSync(root, outside);
            native.symlinkSync(outside, root);
          } else if (fault !== "read-error") {
            native.renameSync(path, outside);
            if (fault === "symlink") native.symlinkSync(outside, path);
            if (fault === "directory") native.mkdirSync(path);
            if (fault === "fifo") execFileSync("mkfifo", [path]);
          }
          vi.clearAllMocks();
          let injectedReads = 0;
          if (fault === "read-error")
            vi.mocked(fs.readFileSync).mockImplementation((...args) => {
              if (args[0] === path) {
                injectedReads++;
                throw Object.assign(new Error("PRIVATE_READ_ERROR"), { code: "EACCES" });
              }
              return native.readFileSync(...args);
            });
          const display = expectAsk(await h.decide("change_submit", { change_id: CHANGE_ID }));
          if (fault === "read-error") expect(injectedReads).toBe(1);
          expect(display.reason).toBe(`${CHANGE_APPROVAL_REASON_PREFIX} ${CHANGE_ID}`);
          expect(display.en).toMatch(/cannot read/iu);
          expect(display.zh).toContain("无法读取");
          expect(JSON.stringify(display)).not.toContain("PRIVATE_READ_ERROR");
          const reads = vi.mocked(fs.readFileSync).mock.calls.map(([target]) => String(target));
          if (part === "change") expect(reads).not.toContain(fixture.patchPath);
          if (fault !== "read-error") expect(reads).not.toContain(path);
          expect(reads.some((target) => target.includes("private-outside"))).toBe(false);
          expect(h.next).not.toHaveBeenCalled();
          noWrites();
          if (fault === "missing-root") expect(native.existsSync(root)).toBe(false);
        } finally {
          await h.dispose();
        }
      });
    }
  }
}

test.each(["json", "schema", "foreign-id"])(
  "invalid CR %s asks without patch IO",
  async (fault) => {
    const h = await createPolicyHarness({ preset: "coder" });
    try {
      const fixture = await writeProposedChange(h.cwd);
      native.writeFileSync(
        fixture.changePath,
        fault === "json"
          ? "PRIVATE_INVALID_JSON"
          : JSON.stringify({
              ...fixture.change,
              ...(fault === "schema"
                ? { risk: "PRIVATE_INVALID_RISK" }
                : {
                    change_id: "CHG-20261102T090000-ffff",
                    patch_path: "patches/CHG-20261102T090000-ffff.patch",
                  }),
            }),
      );
      vi.clearAllMocks();
      const display = expectAsk(await h.decide("change_submit", { change_id: CHANGE_ID }));
      expect(display.zh).toContain("无法读取");
      expect(JSON.stringify(display)).not.toContain("PRIVATE_");
      expect(vi.mocked(fs.readFileSync).mock.calls.map(([path]) => path)).toEqual([
        fixture.changePath,
      ]);
      noWrites();
    } finally {
      await h.dispose();
    }
  },
);

test.each([
  undefined,
  null,
  [],
  7,
  false,
  "private-root",
  {},
  { change_id: "../PRIVATE_PATH" },
  { change_id: 7 },
])("malformed change arguments %j ask with controlled marker and no IO", async (input) => {
  const h = await createPolicyHarness({ preset: "coder" });
  try {
    vi.clearAllMocks();
    const display = expectAsk(await h.decide("change_submit", input));
    expect(display.reason).toBe(`${CHANGE_APPROVAL_REASON_PREFIX} ${INVALID_CHANGE_ID_MARKER}`);
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(h.policyLogs()).toEqual([["ask change_submit change-approval"]]);
    expect(h.next).not.toHaveBeenCalled();
    noWrites();
  } finally {
    await h.dispose();
  }
});

test("array root with its own valid change_id cannot read or delegate low-risk CR", async () => {
  const h = await createPolicyHarness({ preset: "coder" });
  try {
    await writeProposedChange(h.cwd, {
      semantic_level: "pure_engineering",
      semantic_floor: "pure_engineering",
      floor_categories: ["pure_engineering"],
      risk: "low",
    });
    const input = Object.assign([], { change_id: CHANGE_ID });
    vi.clearAllMocks();
    // Public waterfall also covers roots rejected by native ToolRuntime normalization.
    const display = expectAsk(await h.decide("change_submit", input));
    expect(display.reason).toBe(`${CHANGE_APPROVAL_REASON_PREFIX} ${INVALID_CHANGE_ID_MARKER}`);
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(h.next).not.toHaveBeenCalled();
    noWrites();
  } finally {
    await h.dispose();
  }
});

test.each(["coder", undefined])(
  "approved high-risk still asks for current preset %j",
  async (preset) => {
    const h = await createPolicyHarness({ preset });
    try {
      const fixture = await writeProposedChange(h.cwd, {
        status: "approved",
        approval_ref: "prior-call",
        approved_at: "2026-11-02T09:01:00Z",
      });
      const before = await snapshotFile(fixture.changePath);
      expectAsk(await h.decide("change_submit", { change_id: CHANGE_ID }));
      expect(h.next).not.toHaveBeenCalled();
      expect(await snapshotFile(fixture.changePath)).toEqual(before);
    } finally {
      await h.dispose();
    }
  },
);

test("approval display contains every fact while audit contains only validated id and level", async () => {
  const h = await createPolicyHarness({ preset: "coder" });
  try {
    const files = Array.from(
      { length: 40 },
      (_, index) => `src/Model/private-${String(index).padStart(2, "0")}.cpp`,
    );
    const fixture = await writeProposedChange(h.cwd, {
      files_changed: files,
      floor_categories: ["output_semantics", "numerical_implementation"],
      description: "PRIVATE_DESCRIPTION\nPRIVATE_SECOND_LINE",
    });
    const display = expectAsk(
      await h.decide("change_submit", { change_id: CHANGE_ID, private: "RAW_PAYLOAD" }),
    );
    for (const text of [display.en, display.zh]) {
      for (const fact of [
        CHANGE_ID,
        "numerical_implementation",
        "output_semantics",
        "high",
        ...files,
        fixture.change.patch_path,
        fixture.change.description!,
      ]) {
        expect(text).toContain(fact);
      }
    }
    expect(display.reason).toBe(`${CHANGE_APPROVAL_REASON_PREFIX} ${CHANGE_ID}`);
    expect(h.policyLogs()).toEqual([
      [`ask change_submit change-approval ${CHANGE_ID} numerical_implementation`],
    ]);
    await h.decide("change_submit", { change_id: "../PRIVATE_INVALID" });
    native.writeFileSync(fixture.patchPath, "PRIVATE_PATCH");
    await h.decide("change_submit", { change_id: CHANGE_ID });
    await h.policyFiber.dispose();
    const audit = JSON.stringify(h.policyLogs());
    for (const forbidden of [
      "PRIVATE_",
      "private-",
      "RAW_PAYLOAD",
      "patches/",
      fixture.change.patch_sha256,
    ])
      expect(audit).not.toContain(forbidden);
    expect(h.policyLogs()).toContainEqual(["deny=1 ask=2"]);
  } finally {
    await h.dispose();
  }
});

test("missing session cwd asks without creating workspace roots", async () => {
  const h = await createPolicyHarness({ preset: "coder" });
  try {
    h.session.header.cwd = undefined;
    vi.clearAllMocks();
    expectAsk(await h.decide("change_submit", { change_id: CHANGE_ID }));
    expect(fs.readFileSync).not.toHaveBeenCalled();
    noWrites();
    expect(native.readdirSync(h.cwd)).toEqual([]);
  } finally {
    await h.dispose();
  }
});

test("throwing change identity accessor asks without leaking exception or touching records", async () => {
  const h = await createPolicyHarness({ preset: "coder" });
  try {
    const input = Object.defineProperty({}, "change_id", {
      get() {
        throw new Error("PRIVATE_ARGUMENT_ACCESSOR");
      },
    });
    vi.clearAllMocks();
    const display = expectAsk(await h.decide("change_submit", input));
    expect(display.reason).toBe(`${CHANGE_APPROVAL_REASON_PREFIX} ${INVALID_CHANGE_ID_MARKER}`);
    expect(JSON.stringify(display)).not.toContain("PRIVATE_ARGUMENT_ACCESSOR");
    expect(fs.readFileSync).not.toHaveBeenCalled();
    noWrites();
  } finally {
    await h.dispose();
  }
});

test.each(["data/raw", "changes"])(
  "raw-before-policy handles throwing change identity against raw %s",
  async (raw) => {
    const h = await createPolicyHarness({ preset: "coder", rawDirs: [raw] });
    try {
      // Exercise the public waterfall, not native argument materialization, which rejects getters.
      const input = Object.defineProperty({}, "change_id", {
        get() {
          throw new Error("PRIVATE_CHANGE_ID_ACCESSOR");
        },
      });
      vi.clearAllMocks();
      const decision = await h.decide("change_submit", input);
      if (raw === "changes") {
        expect(decision.kind).toBe("deny");
        expect(h.policyLogs()).toEqual([]);
        expect(
          h.logs.filter((row) => row.name === "shud-raw-guard").map((row) => row.args),
        ).toEqual([["deny change_submit raw-immutable"]]);
      } else {
        const display = expectAsk(decision);
        expect(display.reason).toBe(`${CHANGE_APPROVAL_REASON_PREFIX} ${INVALID_CHANGE_ID_MARKER}`);
        expect(h.policyLogs()).toEqual([["ask change_submit change-approval"]]);
        expect(h.logs.filter((row) => row.name === "shud-raw-guard")).toEqual([]);
      }
      expect(JSON.stringify(decision)).not.toContain("PRIVATE_CHANGE_ID_ACCESSOR");
      expect(JSON.stringify(h.logs)).not.toContain("PRIVATE_CHANGE_ID_ACCESSOR");
      expect(h.next).not.toHaveBeenCalled();
      expect(h.request).not.toHaveBeenCalled();
      expect(fs.readFileSync).not.toHaveBeenCalled();
      noWrites();
      expect(native.readdirSync(h.cwd)).toEqual([]);
    } finally {
      await h.dispose();
    }
  },
);
