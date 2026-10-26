import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as io from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import type * as NodeFs from "node:fs";
import type * as NodeIo from "node:fs/promises";
import { generateRunIdentifiers } from "@shud-harness/dsh-shud-core";
import { pollFixture, readRecord } from "./poll-shud/test-harness.ts";
import {
  existingResult,
  expectAbsent,
  outputRoot,
  publishExit,
  readLedger,
  seedTerminal,
} from "./collect-shud/test-harness.ts";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof NodeIo>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    open: vi.fn(actual.open),
    readdir: vi.fn(actual.readdir),
    lstat: vi.fn(actual.lstat),
  };
});
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof NodeFs>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
const actualIo = await vi.importActual<typeof NodeIo>("node:fs/promises");
const actualFs = await vi.importActual<typeof NodeFs>("node:fs");
const fault = {
  scanPath: "",
  scanCode: "",
  privateMessage: "",
  vanish: "",
  unreadable: "",
  protected: [] as string[],
  contentReads: [] as string[],
};
beforeEach(() => {
  fault.scanPath = "";
  fault.scanCode = "";
  fault.privateMessage = "";
  fault.vanish = "";
  fault.unreadable = "";
  fault.protected = [];
  fault.contentReads = [];
  vi.mocked(io.readFile)
    .mockReset()
    .mockImplementation(async (...args) => {
      const [path] = args;
      if (typeof path === "string" && fault.protected.includes(path)) {
        fault.contentReads.push(path);
        throw new Error("Collection must not read protected artifact/log contents");
      }
      return actualIo.readFile(...args);
    });
  vi.mocked(io.open)
    .mockReset()
    .mockImplementation(async (...args) => {
      const [path] = args;
      if (path === fault.unreadable)
        throw Object.assign(new Error("private-exit-error-payload"), { code: "EACCES" });
      const handle = await actualIo.open(...args);
      if (typeof path === "string" && fault.protected.includes(path)) {
        vi.spyOn(handle, "readFile").mockImplementation(() => {
          fault.contentReads.push(path);
          return Promise.reject(
            new Error("Collection must not read protected artifact/log contents"),
          );
        });
      }
      return handle;
    });
  vi.mocked(fs.readFileSync)
    .mockReset()
    .mockImplementation((...args) => {
      const [path] = args;
      if (typeof path === "string" && fault.protected.includes(path)) {
        fault.contentReads.push(path);
        throw new Error("Collection must not synchronously read protected artifact/log contents");
      }
      return actualFs.readFileSync(...args);
    });
  vi.mocked(io.readdir)
    .mockReset()
    .mockImplementation(async (...args) => {
      if (args[0] === fault.scanPath)
        throw Object.assign(new Error(fault.privateMessage || "injected output scan failure"), {
          code: fault.scanCode,
        });
      return actualIo.readdir(...args);
    });
  vi.mocked(io.lstat)
    .mockReset()
    .mockImplementation(async (...args) => {
      if (args[0] === fault.vanish) {
        const path = fault.vanish;
        fault.vanish = "";
        await actualIo.rm(path);
      }
      return actualIo.lstat(...args);
    });
});
function disarm() {
  fault.scanPath = "";
  fault.vanish = "";
  fault.unreadable = "";
  fault.protected = [];
}

test("collection reads artifact metadata only and excludes environment, log and artifact contents", async () => {
  const h = await pollFixture();
  const secret = "not-a-secret";
  vi.stubEnv("SHUD_COLLECT_PRIVATE_TOKEN", secret);
  try {
    const job = await seedTerminal(h, {}, async (record) => {
      const artifact = join(outputRoot(record), "opaque.dat");
      await io.writeFile(artifact, Buffer.from([0, 255, 10, 20]));
      await io.writeFile(join(record.run_dir, "stdout.log"), `Authorization: Bearer ${secret}\n`);
      await io.writeFile(join(record.run_dir, "stderr.log"), secret);
      fault.protected = [
        artifact,
        join(record.run_dir, "stdout.log"),
        join(record.run_dir, "stderr.log"),
      ];
    });
    const result = await h.registry.collectShud(job.run_id);
    expect(result.artifacts.files).toEqual([{ path: "opaque.dat", size_bytes: 4 }]);
    expect(result.llm).toEqual(h.request.llm);
    expect(fault.contentReads).toEqual([]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("SHUD_COLLECT_PRIVATE_TOKEN");
    expect(h.errors.join("\n")).not.toContain(secret);
  } finally {
    disarm();
    vi.unstubAllEnvs();
    await h.close();
  }
});

test.each(["EACCES", "EIO", "ENOTDIR", "ENOENT"])(
  "existing output scan %s is an explicit failure rather than an empty-output fallback",
  async (code) => {
    const h = await pollFixture();
    const secret = "PRIVATE_OUTPUT_EXCEPTION_308";
    try {
      const job = await seedTerminal(h, {}, async (record) => {
        await io.writeFile(join(outputRoot(record), "real.dat"), "real bytes");
        fault.scanPath = outputRoot(record);
        fault.scanCode = code;
        fault.privateMessage = secret;
      });
      await h.registry.pollOnce();
      const ledger = await readLedger(job.run_dir);
      expect(ledger.attempts).toBe(1);
      expect(ledger.last_error).toContain(code);
      expect(ledger.last_error).toMatch(/output|scan|artifact/iu);
      expect(ledger.last_error).not.toContain(secret);
      expect(h.errors.join("\n")).not.toContain(secret);
      expect(h.errors.length).toBeGreaterThan(0);
      expect(await readRecord(job.run_dir)).toEqual(job);
      await expectAbsent(join(job.run_dir, "run-record.json"));
      expect(await actualIo.readFile(join(outputRoot(job), "real.dat"), "utf8")).toBe("real bytes");
    } finally {
      disarm();
      await h.close();
    }
  },
);

test("an artifact disappearing after directory enumeration fails rather than being omitted from a successful manifest", async () => {
  const h = await pollFixture();
  try {
    const job = await seedTerminal(h, {}, async (record) => {
      const target = join(outputRoot(record), "vanishing.dat");
      await io.writeFile(target, "known artifact");
      fault.vanish = target;
    });
    await h.registry.pollOnce();
    expect((await readLedger(job.run_dir)).last_error).toContain("ENOENT");
    await expectAbsent(join(job.run_dir, "run-record.json"));
    expect((await readRecord(job.run_dir)).status).toBe("succeeded");
  } finally {
    disarm();
    await h.close();
  }
});

test.each([
  { status: "cancelled", exitCode: 13 },
  { status: "cancelled", exitCode: null },
  { status: "succeeded", exitCode: 0 },
] as const)(
  "unreadable evidence with $status and cached exit $exitCode sets failed but retains all metadata and uses safe diagnostics",
  async ({ status, exitCode }) => {
    const h = await pollFixture();
    try {
      const job = await seedTerminal(
        h,
        { status, exit_code: exitCode, cancel_requested_at: "2026-10-22T03:15:01.000Z" },
        async (record) => {
          await publishExit(record, `${exitCode ?? 13}\n`);
          fault.unreadable = join(record.run_dir, "exit_code");
        },
      );
      await h.registry.pollOnce();
      expect(await readRecord(job.run_dir)).toEqual({ ...job, status: "failed" });
      const ledger = await readLedger(job.run_dir);
      expect(ledger.last_error).toContain("EACCES");
      expect(ledger.last_error).toMatch(/exit/iu);
      expect(ledger.last_error).not.toContain("private-exit-error-payload");
      expect(h.errors.join("\n")).not.toContain("private-exit-error-payload");
      expect(h.errors.length).toBeGreaterThan(0);
      expect(await actualIo.readFile(fault.unreadable, "utf8")).toBe(`${exitCode ?? 13}\n`);
      await expectAbsent(join(job.run_dir, "run-record.json"));
    } finally {
      disarm();
      await h.close();
    }
  },
);

test.each(["missing-model", "invalid-command", "negative-duration"] as const)(
  "terminal %s failure is journaled without fabricated metadata or an invalid state rewrite",
  async (kind) => {
    const h = await pollFixture();
    let original = "";
    try {
      const job = await seedTerminal(
        h,
        kind === "negative-duration" ? { finished_at: "2026-10-22T03:14:59.000Z" } : {},
        async (record) => {
          const payload =
            kind === "missing-model"
              ? { ...record, llm: { response_model_source: "configured" } }
              : kind === "invalid-command"
                ? { ...record, command: "PRIVATE_INVALID_COMMAND_308" }
                : record;
          original = JSON.stringify(payload);
          await io.writeFile(join(record.run_dir, "run-job.json"), original);
        },
      );
      await h.registry.pollOnce();
      const ledger = await readLedger(job.run_dir);
      expect(ledger.attempts).toBe(1);
      expect(ledger.last_error).toMatch(
        kind === "missing-model"
          ? /llm|response_model/iu
          : kind === "invalid-command"
            ? /command/iu
            : /wall_seconds|duration|resources/iu,
      );
      expect(ledger.last_error).not.toContain("PRIVATE_INVALID_COMMAND_308");
      expect(h.errors.join("\n")).not.toContain("PRIVATE_INVALID_COMMAND_308");
      if (kind === "negative-duration") expect(await readRecord(job.run_dir)).toEqual(job);
      else expect(await io.readFile(join(job.run_dir, "run-job.json"), "utf8")).toBe(original);
      await expectAbsent(join(job.run_dir, "run-record.json"));
    } finally {
      await h.close();
    }
  },
);

test.each(["corrupt", "wrong-run", "wrong-job"] as const)(
  "an existing %s RunRecord is never overwritten or deleted",
  async (kind) => {
    const h = await pollFixture();
    let original = "";
    let mtime = 0n;
    try {
      const job = await seedTerminal(h, {}, async (record) => {
        const ids = generateRunIdentifiers();
        original =
          kind === "corrupt"
            ? "{not-a-record"
            : JSON.stringify({
                ...existingResult(record),
                ...(kind === "wrong-run" ? { run_id: ids.run_id } : { job_id: ids.job_id }),
              });
        const path = join(record.run_dir, "run-record.json");
        await io.writeFile(path, original);
        mtime = (await io.stat(path, { bigint: true })).mtimeNs;
      });
      await h.registry.pollOnce();
      expect((await readLedger(job.run_dir)).attempts).toBe(1);
      expect(await io.readFile(join(job.run_dir, "run-record.json"), "utf8")).toBe(original);
      expect((await io.stat(join(job.run_dir, "run-record.json"), { bigint: true })).mtimeNs).toBe(
        mtime,
      );
      expect((await readRecord(job.run_dir)).status).toBe("succeeded");
      expect(h.errors.length).toBeGreaterThan(0);
    } finally {
      await h.close();
    }
  },
);

const metadataNames = {
  "run-job": "run-job.json",
  "exit-code": "exit_code",
  "run-record": "run-record.json",
  ledger: "collect-error.json",
} as const;
test.each([
  "run-dir",
  "output-ancestor",
  "output-root",
  "output-directory",
  "output-file",
  "run-job",
  "exit-code",
  "run-record",
  "ledger",
] as const)(
  "collection rejects a %s symlink without following or rewriting foreign evidence",
  async (kind) => {
    const h = await pollFixture();
    const foreign = join(h.root, "foreign-evidence");
    let link = "";
    try {
      await io.mkdir(foreign);
      await io.writeFile(join(foreign, "sentinel"), "foreign bytes remain untouched");
      const job = await seedTerminal(h, {}, async (record) => {
        if (kind === "run-dir") {
          const moved = join(foreign, "moved-run");
          await io.rename(record.run_dir, moved);
          link = record.run_dir;
          await io.symlink(moved, link);
          fault.protected = [join(record.run_dir, "run-job.json"), join(moved, "run-job.json")];
        } else if (kind === "output-ancestor" || kind === "output-root") {
          link = kind === "output-ancestor" ? join(record.run_dir, "output") : outputRoot(record);
          await io.rm(link, { recursive: true });
          await io.symlink(foreign, link);
        } else if (kind === "output-directory" || kind === "output-file") {
          link = join(outputRoot(record), "linked-entry");
          await io.symlink(kind === "output-file" ? join(foreign, "sentinel") : foreign, link);
        } else {
          link = join(record.run_dir, metadataNames[kind]);
          const target = join(foreign, metadataNames[kind]);
          const bytes =
            kind === "run-job"
              ? JSON.stringify(record)
              : kind === "run-record"
                ? JSON.stringify(existingResult(record))
                : kind === "ledger"
                  ? JSON.stringify({
                      attempts: 0,
                      last_error: "prior failure",
                      at: "2026-10-22T03:15:03.000Z",
                    })
                  : "0\n";
          await io.writeFile(target, bytes);
          await io.rm(link, { force: true });
          await io.symlink(target, link);
          fault.protected = [link, target];
        }
      });
      const api = h.registry;
      await expect(api.collectShud(job.run_id)).rejects.toThrow();
      expect((await io.lstat(link)).isSymbolicLink()).toBe(true);
      expect(await actualIo.readFile(join(foreign, "sentinel"), "utf8")).toBe(
        "foreign bytes remain untouched",
      );
      expect(fault.contentReads).toEqual([]);
      if (kind !== "run-record") await expectAbsent(join(job.run_dir, "run-record.json"));
      if (kind === "run-dir") await expectAbsent(join(job.run_dir, "collect-error.json"));
    } finally {
      disarm();
      await h.close();
    }
  },
);

test.each(["fifo", "output-is-file", "exit-is-directory"] as const)(
  "nonregular %s evidence is not collected as an empty or zero-byte success",
  async (kind) => {
    const h = await pollFixture();
    try {
      const job = await seedTerminal(h, {}, async (record) => {
        if (kind === "fifo") execFileSync("mkfifo", [join(outputRoot(record), "pipe.dat")]);
        else if (kind === "output-is-file") {
          await io.rm(outputRoot(record), { recursive: true });
          await io.writeFile(outputRoot(record), "not a directory");
        } else {
          await io.rm(join(record.run_dir, "exit_code"));
          await io.mkdir(join(record.run_dir, "exit_code"));
        }
      });
      await h.registry.pollOnce();
      expect((await readLedger(job.run_dir)).attempts).toBe(1);
      expect((await readRecord(job.run_dir)).status).toBe(
        kind === "exit-is-directory" ? "failed" : "succeeded",
      );
      await expectAbsent(join(job.run_dir, "run-record.json"));
    } finally {
      await h.close();
    }
  },
);

test.each(["../outside", "nested/project", ".", ".."])(
  "unsafe persisted project %j cannot route collection outside the fixture output tree",
  async (project) => {
    const h = await pollFixture();
    try {
      const job = await seedTerminal(h, { project });
      const api = h.registry;
      await expect(api.collectShud(job.run_id)).rejects.toThrow();
      await expectAbsent(join(job.run_dir, "run-record.json"));
      expect((await readRecord(job.run_dir)).project).toBe(project);
    } finally {
      await h.close();
    }
  },
);

test.each(["invalid-json", "run-id", "job-id", "run-dir"] as const)(
  "terminal %s routing failure cannot write a result or retry journal into either identity",
  async (kind) => {
    const h = await pollFixture();
    const foreign = join(h.root, "foreign-route");
    let original = "";
    let mtime = 0n;
    try {
      await io.mkdir(foreign);
      await io.writeFile(join(foreign, "sentinel"), "foreign route bytes");
      const job = await seedTerminal(h, {}, async (record) => {
        const ids = generateRunIdentifiers();
        const changed =
          kind === "run-id"
            ? { ...record, run_id: ids.run_id }
            : kind === "job-id"
              ? { ...record, job_id: ids.job_id }
              : { ...record, run_dir: foreign };
        original = kind === "invalid-json" ? "{invalid-routing-json" : JSON.stringify(changed);
        const path = join(record.run_dir, "run-job.json");
        await io.writeFile(path, original);
        mtime = (await io.stat(path, { bigint: true })).mtimeNs;
      });
      const api = h.registry;
      await expect(api.collectShud(job.run_id)).rejects.toThrow();
      await h.registry.pollOnce();
      expect(await io.readFile(join(job.run_dir, "run-job.json"), "utf8")).toBe(original);
      expect((await io.stat(join(job.run_dir, "run-job.json"), { bigint: true })).mtimeNs).toBe(
        mtime,
      );
      await expectAbsent(join(job.run_dir, "run-record.json"));
      await expectAbsent(join(job.run_dir, "collect-error.json"));
      expect(await io.readdir(foreign)).toEqual(["sentinel"]);
      expect(await io.readFile(join(foreign, "sentinel"), "utf8")).toBe("foreign route bytes");
      expect(h.errors.length).toBeGreaterThan(0);
    } finally {
      await h.close();
    }
  },
);
