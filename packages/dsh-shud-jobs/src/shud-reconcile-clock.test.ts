import { expect, test } from "vitest";
import { reconcileEntry } from "./shud-reconcile.ts";
import type { ProcessBirthObservation } from "./process-birth.ts";

test("captured Linux newborn is promoted using native birth freshness without changing lstart identity", () => {
  // Captured in shud-issue-310-r3-native-clocks.txt, before-stop sample:
  // HZ=100, startTicks=62807325, uptime=628073.27, begin=end=1792791735052.
  // latestBirth = end - (uptime - (startTicks + 1) / HZ) * 1000 = 1792791735042.
  // The recorded submission is untouched; integer btime plus truncated ticks produced lstart 14s.
  const wrapper: ProcessBirthObservation = {
    pid: 20,
    state: "Ss",
    pid_started_at: "2026-10-23T21:42:14.000Z",
    birthLatestMs: 1792791735042,
  };
  expect(
    reconcileEntry({
      status: "submitted",
      notify: "pending",
      submitted_at: "2026-10-23T21:42:15.029Z",
      exit: undefined,
      wrapper,
    }),
  ).toEqual({
    row: "R3",
    action: "promote",
    identity: { pid: 20, pid_started_at: "2026-10-23T21:42:14.000Z" },
  });
});

test("captured genuinely older Linux process remains R4 under the native birth bound", () => {
  // shud-issue-310-r3-clock-controls.txt CLOCK-OLDER: upper=1792791912338,
  // submittedNow=1792791913000. This control is already rejected by the old classifier.
  const wrapper: ProcessBirthObservation = {
    pid: 20,
    state: "Ss",
    pid_started_at: "2026-10-23T21:45:11.000Z",
    birthLatestMs: 1792791912338,
  };
  expect(
    reconcileEntry({
      status: "submitted",
      notify: "pending",
      submitted_at: "2026-10-23T21:45:13.000Z",
      exit: undefined,
      wrapper,
    }),
  ).toEqual({ row: "R4", action: "settle-lost" });
});

test.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])(
  "invalid comparable birth bound %s cannot silently become lost or promoted",
  (birthLatestMs) => {
    const wrapper: ProcessBirthObservation = {
      pid: 20,
      state: "Ss",
      pid_started_at: "2026-10-23T21:42:14.000Z",
      birthLatestMs,
    };
    expect(() =>
      reconcileEntry({
        status: "submitted",
        notify: "pending",
        submitted_at: "2026-10-23T21:42:15.029Z",
        exit: undefined,
        wrapper,
      }),
    ).toThrow(/birth/iu);
  },
);

test.each([
  { birthLatestMs: 1792791735000, row: "R3" },
  { birthLatestMs: 1792791734999, row: "R4" },
] as const)(
  "comparable birth bound $birthLatestMs selects $row at the submission second",
  ({ birthLatestMs, row }) => {
    const wrapper: ProcessBirthObservation = {
      pid: 20,
      state: "Ss",
      pid_started_at: "2026-10-23T21:42:14.000Z",
      birthLatestMs,
    };
    expect(
      reconcileEntry({
        status: "submitted",
        notify: "pending",
        submitted_at: "2026-10-23T21:42:15.029Z",
        exit: undefined,
        wrapper,
      }).row,
    ).toBe(row);
  },
);
