import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type * as NodeChild from "node:child_process";
import type * as NodeFs from "node:fs";
import { linuxBirthBounds, selectBirthLatest, type LinuxBirthSample } from "./process-birth.ts";

const native = vi.hoisted(() => ({
  hz: "100\n",
  hzStatus: 0,
  hzReads: 0,
  statFirst: "",
  statLast: "",
  statReads: 0,
  uptimeFirst: "628073.27 0.00\n",
  uptimeLast: "628073.27 0.00\n",
  uptimeReads: 0,
  statFailureAt: 0,
  statFailureCode: "",
  uptimeFailure: "",
  firstStamp: "Fri Oct 23 21:42:14 2026",
  lastStamp: "Fri Oct 23 21:42:14 2026",
  psReads: 0,
}));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof NodeChild>();
  return {
    ...actual,
    spawnSync(command: string, args: readonly string[], options: NodeChild.SpawnSyncOptions) {
      if (command === "getconf") {
        native.hzReads++;
        return {
          pid: 0,
          output: [],
          stdout: native.hz,
          stderr: "",
          status: native.hzStatus,
          signal: null,
        };
      }
      if (command === "ps" && args[0] === "-p" && args[1] === "20") {
        native.psReads++;
        const stamp = native.psReads === 1 ? native.firstStamp : native.lastStamp;
        return { pid: 0, output: [], stdout: `${stamp} Ss\n`, stderr: "", status: 0, signal: null };
      }
      return actual.spawnSync(command, args, options);
    },
  };
});
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof NodeFs>();
  return {
    ...actual,
    readFileSync(...args: Parameters<typeof actual.readFileSync>) {
      if (args[0] === "/proc/20/stat") {
        native.statReads++;
        if (native.statReads === native.statFailureAt)
          throw Object.assign(new Error("PRIVATE_PROC_PAYLOAD"), { code: native.statFailureCode });
        return native.statReads === 1 ? native.statFirst : native.statLast;
      }
      if (args[0] === "/proc/uptime") {
        native.uptimeReads++;
        if (native.uptimeFailure)
          throw Object.assign(new Error("PRIVATE_PROC_PAYLOAD"), { code: native.uptimeFailure });
        return native.uptimeReads === 1 ? native.uptimeFirst : native.uptimeLast;
      }
      return actual.readFileSync(...args);
    },
  };
});

// Fields follow proc_pid_stat(5): state is field 3, starttime follows itrealvalue at field 22.
function statLine(ticks = "62807325", pid = 20, state = "S"): string {
  return `${pid} (wrapper ) with ( spaces) ${state} 1 20 20 0 -1 4194304 10 0 0 0 0 0 0 0 20 0 1 0 ${ticks} 4096\n`;
}

// Observer imports below intentionally reload the module boundary to isolate its CLK_TCK cache.
beforeEach(() => {
  vi.resetModules();
  native.hz = "100\n";
  native.hzStatus = 0;
  native.hzReads = 0;
  native.statFirst = statLine();
  native.statLast = statLine();
  native.statReads = 0;
  native.uptimeFirst = "628073.27 0.00\n";
  native.uptimeLast = "628073.27 0.00\n";
  native.uptimeReads = 0;
  native.statFailureAt = 0;
  native.statFailureCode = "";
  native.uptimeFailure = "";
  native.firstStamp = "Fri Oct 23 21:42:14 2026";
  native.lastStamp = native.firstStamp;
  native.psReads = 0;
  vi.spyOn(Date, "now").mockReturnValue(1792791735052);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const captured: LinuxBirthSample = {
  startTicks: 62807325,
  clockTicksPerSecond: 100,
  uptimeBeforeCentiseconds: 62807327,
  uptimeAfterCentiseconds: 62807327,
  wallBeforeMs: 1792791735052,
  wallAfterMs: 1792791735052,
};

test("captured tick/centisecond arithmetic preserves the realtime birth bound and millisecond clock edge", () => {
  // The native-age prototype gives 5042; Date.now's upper millisecond edge adds one, not a grace period.
  expect(linuxBirthBounds(captured)).toEqual({
    latestAtBeginMs: 1792791735042,
    latestAtEndMs: 1792791735043,
  });
});

test.each([
  { hz: 250, uptime: 5, begin: 994, end: 995 },
  { hz: 300, uptime: 4, begin: 996, end: 998 },
])(
  "native HZ=$hz converts tick quantization to conservative integer milliseconds",
  ({ hz, uptime, begin, end }) => {
    expect(
      linuxBirthBounds({
        startTicks: 10,
        clockTicksPerSecond: hz,
        uptimeBeforeCentiseconds: uptime,
        uptimeAfterCentiseconds: uptime,
        wallBeforeMs: 1000,
        wallAfterMs: 1000,
      }),
    ).toEqual({ latestAtBeginMs: begin, latestAtEndMs: end });
  },
);

test("native uptime reread skew widens only the measured latest-birth comparison range", () => {
  expect(
    linuxBirthBounds({
      ...captured,
      uptimeAfterCentiseconds: 62807328,
      wallAfterMs: 1792791735053,
    }),
  ).toEqual({ latestAtBeginMs: 1792791735032, latestAtEndMs: 1792791735044 });
});

test.each([
  { clockTicksPerSecond: 0 },
  { clockTicksPerSecond: -1 },
  { clockTicksPerSecond: 1.5 },
  { startTicks: Number.NaN },
  { startTicks: Number.MAX_SAFE_INTEGER },
  { startTicks: 62807329 },
  { uptimeBeforeCentiseconds: Number.POSITIVE_INFINITY },
  { uptimeAfterCentiseconds: 62807326 },
  { wallAfterMs: 1792791735051 },
  { wallAfterMs: 1792791737052 },
])("invalid or excessively ambiguous native sample %j fails closed", (changes) => {
  expect(() => linuxBirthBounds({ ...captured, ...changes })).toThrow(/birth/iu);
});

test("measurement skew crossing the submission second is uncertain, not lost or promoted", () => {
  expect(() => selectBirthLatest({ latestAtBeginMs: 4999, latestAtEndMs: 5000 }, 5000)).toThrow(
    /uncertain/iu,
  );
  expect(selectBirthLatest({ latestAtBeginMs: 4990, latestAtEndMs: 4999 }, 5000)).toBe(4999);
  expect(selectBirthLatest({ latestAtBeginMs: 5000, latestAtEndMs: 5005 }, 5000)).toBe(5005);
});

test.each([
  { latestAtBeginMs: Number.NaN, latestAtEndMs: 5000 },
  { latestAtBeginMs: 5000, latestAtEndMs: Number.POSITIVE_INFINITY },
  { latestAtBeginMs: 5001, latestAtEndMs: 5000 },
])("invalid comparison bounds %j fail closed", (bounds) => {
  expect(() => selectBirthLatest(bounds, 5000)).toThrow(/birth/iu);
});

test("Linux reader parses parenthesized command names, preserves lstart, and caches only CLK_TCK", async () => {
  const { linuxProcessBirth } = await import("./process-birth.ts");
  expect(linuxProcessBirth(20, 1792791735000)).toEqual({
    pid: 20,
    pid_started_at: "2026-10-23T21:42:14.000Z",
    state: "Ss",
    birthLatestMs: 1792791735043,
  });
  linuxProcessBirth(20, 1792791735000);
  expect(native.hzReads).toBe(1);
  expect(native.psReads).toBe(4);
  expect(native.statReads).toBe(4);
  expect(native.uptimeReads).toBe(4);
});

test.each(["0\n", "-1\n", "1.5\n", "9007199254740992\n", "PRIVATE_PROC_PAYLOAD"])(
  "invalid CLK_TCK %j is not cached or replaced by a default",
  async (hz) => {
    native.hz = hz;
    const { linuxProcessBirth } = await import("./process-birth.ts");
    expect(() => linuxProcessBirth(20, 1792791735000)).toThrow(/clock ticks/iu);
    native.hz = "100\n";
    expect(linuxProcessBirth(20, 1792791735000)?.pid).toBe(20);
    expect(native.hzReads).toBe(2);
  },
);

test("failed CLK_TCK command is not treated as usable native evidence", async () => {
  native.hzStatus = 1;
  const { linuxProcessBirth } = await import("./process-birth.ts");
  expect(() => linuxProcessBirth(20, 1792791735000)).toThrow(/clock ticks/iu);
});

test.each([
  "20 (PRIVATE_PROC_PAYLOAD",
  statLine("9007199254740992"),
  statLine("-1"),
  statLine("12.5"),
  statLine("62807325", 21),
  statLine("62807325", 20, "?"),
])("malformed proc state %j is not classified as a dead or adoptable process", async (text) => {
  native.statFirst = text;
  const { linuxProcessBirth } = await import("./process-birth.ts");
  let failure: unknown;
  try {
    linuxProcessBirth(20, 1792791735000);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).toMatch(/birth/iu);
  expect(String(failure)).not.toContain("PRIVATE_PROC_PAYLOAD");
});

test.each(["628073.2 0.00", "NaN 0.00", "-1.00 0.00", "900719925474099.00 0.00", "628073.27 junk"])(
  "invalid uptime %j cannot become a comparable birth clock",
  async (text) => {
    native.uptimeFirst = text;
    const { linuxProcessBirth } = await import("./process-birth.ts");
    expect(() => linuxProcessBirth(20, 1792791735000)).toThrow(/uptime/iu);
  },
);

test.each([1, 2])(
  "proc ENOENT at observation %s returns absence for the caller's exit reread",
  async (at) => {
    native.statFailureAt = at;
    native.statFailureCode = "ENOENT";
    const { linuxProcessBirth } = await import("./process-birth.ts");
    expect(linuxProcessBirth(20, 1792791735000)).toBeNull();
  },
);

test.each(["EACCES", "EIO"])(
  "proc %s remains an error without exposing raw native content",
  async (code) => {
    native.statFailureAt = 1;
    native.statFailureCode = code;
    const { linuxProcessBirth } = await import("./process-birth.ts");
    let failure: unknown;
    try {
      linuxProcessBirth(20, 1792791735000);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain("PRIVATE_PROC_PAYLOAD");
  },
);

test("missing uptime is unavailable clock evidence, not evidence of process death", async () => {
  native.uptimeFailure = "ENOENT";
  const { linuxProcessBirth } = await import("./process-birth.ts");
  expect(() => linuxProcessBirth(20, 1792791735000)).toThrow(/uptime/iu);
});

test.each(["start-ticks", "lstart"] as const)(
  "changed %s identity across the probe refuses adoption",
  async (kind) => {
    if (kind === "start-ticks") native.statLast = statLine("62807326");
    else native.lastStamp = "Fri Oct 23 21:42:16 2026";
    const { linuxProcessBirth } = await import("./process-birth.ts");
    expect(() => linuxProcessBirth(20, 1792791735000)).toThrow(/identity changed/iu);
  },
);

test("a clock bracket crossing the decision boundary fails the actual Linux observer", async () => {
  const { linuxProcessBirth } = await import("./process-birth.ts");
  vi.mocked(Date.now).mockReturnValueOnce(1792791735009).mockReturnValueOnce(1792791735010);
  expect(() => linuxProcessBirth(20, 1792791735000)).toThrow(/uncertain/iu);
});

test("a backward clock fails the actual Linux observer without substituting lstart", async () => {
  const { linuxProcessBirth } = await import("./process-birth.ts");
  vi.mocked(Date.now).mockReturnValueOnce(1792791735052).mockReturnValueOnce(1792791735051);
  expect(() => linuxProcessBirth(20, 1792791735000)).toThrow(/clock sample/iu);
});

test.each(["Z", "X", "x"])("native %s death during the probe returns absence", async (state) => {
  native.statLast = statLine("62807325", 20, state);
  const { linuxProcessBirth } = await import("./process-birth.ts");
  expect(linuxProcessBirth(20, 1792791735000)).toBeNull();
});
