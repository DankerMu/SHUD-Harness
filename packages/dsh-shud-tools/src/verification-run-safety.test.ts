import * as fs from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { installUnsafe } from "../../dsh-shud-records/src/test-harness.ts";
import {
  fixturePaths,
  PRIVATE,
  putFixture,
  rejectedUnchanged,
  SIDES,
} from "./verification-run/matrix/test-harness.ts";
import { COMPARED_PATH, verificationHarness } from "./verification-run/test-harness.ts";

for (const side of SIDES) {
  for (const kind of ["job", "run", "build", "data"] as const) {
    test.each([
      "missing",
      "corrupt",
      "schema",
      "wrong-id",
      "symlink",
      "directory",
      "fifo",
    ] as const)(`${side} ${kind} %s evidence cannot publish a verification`, async (fault) => {
      const h = await verificationHarness();
      try {
        const path = fixturePaths(h, side)[kind];
        if (fault === "corrupt") fs.writeFileSync(path, PRIVATE);
        else if (fault === "schema") putFixture(path, {});
        else if (fault === "wrong-id") {
          const value: Record<string, unknown> = { ...h[side][kind] };
          const field =
            kind === "job"
              ? "job_id"
              : kind === "run"
                ? "run_id"
                : kind === "build"
                  ? "build_id"
                  : "data_id";
          const prefix =
            kind === "job" ? "JOB" : kind === "run" ? "RUN" : kind === "build" ? "BUILD" : "DATA";
          const replacement = `${prefix}-20261022T031500-ffff`;
          value[field] = replacement;
          // Bind dependent build paths so this remains an identity fault, not a path-schema fault.
          if (kind === "build") {
            value.binary_path = `builds/${replacement}/shud`;
            value.stdout_path = `builds/${replacement}/make.stdout.log`;
            value.stderr_path = `builds/${replacement}/make.stderr.log`;
          }
          putFixture(path, value);
        } else {
          const outside = join(h.root, "retained-record.json");
          fs.renameSync(path, outside);
          if (fault !== "missing") installUnsafe(path, fault, outside);
        }
        await rejectedUnchanged(h);
      } finally {
        await h.dispose();
      }
    });
  }

  test.each(["missing", "symlink", "dangling-link", "directory", "fifo"] as const)(
    `${side} final rivqdown %s is an error rather than a failed verdict`,
    async (fault) => {
      const h = await verificationHarness();
      try {
        const path = join(h[side].job.run_dir, COMPARED_PATH);
        const outside = join(h.root, "retained-output.dat");
        fs.renameSync(path, outside);
        if (fault !== "missing") installUnsafe(path, fault, outside);
        const message = await rejectedUnchanged(h);
        expect(message).toContain(COMPARED_PATH);
      } finally {
        await h.dispose();
      }
    },
  );

  for (const ancestor of ["output", "output/tiny.out"]) {
    test.each(["missing", "symlink", "file", "fifo"] as const)(
      `${side} ${ancestor} %s cannot redirect the comparator`,
      async (kind) => {
        const h = await verificationHarness();
        try {
          const path = join(h[side].job.run_dir, ancestor);
          const outside = join(h.root, "retained-output-directory");
          fs.renameSync(path, outside);
          if (kind !== "missing") installUnsafe(path, kind, outside);
          const message = await rejectedUnchanged(h);
          expect(message).toContain(ancestor);
        } finally {
          await h.dispose();
        }
      },
    );
  }
}

for (const kind of ["task", "change"] as const) {
  test.each(["missing", "corrupt", "schema", "wrong-id", "symlink", "directory", "fifo"] as const)(
    `${kind} %s cannot authorize verification`,
    async (fault) => {
      const h = await verificationHarness();
      try {
        const path = fixturePaths(h, "candidate")[kind];
        if (fault === "corrupt") fs.writeFileSync(path, PRIVATE);
        else if (fault === "schema") putFixture(path, {});
        else if (fault === "wrong-id") {
          const value: Record<string, unknown> = { ...(kind === "task" ? h.card : h.change) };
          if (kind === "task") value.task_id = "TASK-20261102T090000-ffff";
          else {
            value.change_id = "CHG-20261102T090000-ffff";
            value.patch_path = "patches/CHG-20261102T090000-ffff.patch";
          }
          putFixture(path, value);
        } else {
          const outside = join(h.root, "retained-authorization.json");
          fs.renameSync(path, outside);
          if (fault !== "missing") installUnsafe(path, fault, outside);
        }
        await rejectedUnchanged(h);
      } finally {
        await h.dispose();
      }
    },
  );
}

test.each(["symlink", "file", "fifo"] as const)(
  "unsafe %s verification root leaves card and evidence unchanged",
  async (kind) => {
    const h = await verificationHarness();
    try {
      const outside = join(h.root, "outside-verifications");
      fs.mkdirSync(outside);
      fs.writeFileSync(join(outside, "sentinel"), PRIVATE);
      installUnsafe(join(h.cwd, "verifications"), kind, outside);
      await rejectedUnchanged(h);
    } finally {
      await h.dispose();
    }
  },
);
