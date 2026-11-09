import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { assertReplayEvidence, type ReplayEvidence } from "./shud-replay-evidence.ts";
import { makeReplayFixture, refreshReplayRunArtifacts } from "./replay/test-harness.ts";
import { object } from "./shud-restart-evidence.ts";

function expectRejected(snapshot: ReplayEvidence, fragments: string[]) {
  const retained = structuredClone(snapshot);
  let failure: unknown;
  try {
    assertReplayEvidence(snapshot);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  if (!(failure instanceof Error)) throw new Error("Expected a replay evidence rejection");
  const message = failure.message;
  for (const fragment of fragments) expect(message).toContain(fragment);
  expect(message).not.toMatch(/INCONCLUSIVE/iu);
  expect(snapshot).toEqual(retained);
}

test("accepts the complete constructed replay with causal joins across two coders and two workers", () => {
  const { snapshot } = makeReplayFixture();
  const retained = structuredClone(snapshot);
  // Literal outcome oracle: never calculated by the judge, renderer or fixture builder.
  expect(assertReplayEvidence(snapshot)).toEqual({
    status: "PASS",
    task_id: "TASK-20261102T090000-c3d4",
    change_id: "CHG-20261102T090000-a1b2",
    build_ids: { base: "BUILD-20261102T090000-f6a7", candidate: "BUILD-20261102T090000-a7b8" },
    run_ids: { base: "RUN-20261102T090000-d4e5", candidate: "RUN-20261102T090000-e5f6" },
    verification: { vc_id: "VC-20261102T090000-b2c3", status: "passed" },
    report: { report_id: "REPORT-20261102T090000-0001", status: "accepted" },
    approval_count: 2,
  });
  expect(snapshot).toEqual(retained);
});

test("rejects candidate rhs_openmp true without compiler and linker -fopenmp evidence", () => {
  const { snapshot, builds } = makeReplayFixture();
  snapshot.files[builds[1].stdout_path] = "c++ -c src/Model/MD_rhs_core.cpp\nc++ -o shud rhs.o\n";
  expectRejected(snapshot, ["-fopenmp", "BUILD-20261102T090000-a7b8"]);
});

test("rejects a third canonical approval ask and names its tool and call even without a decision", () => {
  const { snapshot } = makeReplayFixture();
  const root = snapshot.root;
  const index = root.events.length - 2;
  const time = root.events[index].time;
  const submit = root.events.findIndex(
    (event) => event.type === "tool/call" && object(event.data).callId === "call-report-submit",
  );
  // Retain a valid pending canonical prefix: advertise/start a new call, then ask.
  // No completed turn is fabricated while that invocation is still unanswered.
  const extraCall = JSON.parse(
    JSON.stringify(root.events.slice(submit - 1, submit + 1)).replaceAll(
      "call-report-submit",
      "call-extra-approval",
    ),
  ) as typeof root.events;
  root.events.splice(index, 2, ...extraCall, {
    type: "approval/asked",
    seq: index + 2,
    time,
    data: {
      id: "ask-extra",
      toolName: "report_submit",
      callId: "call-extra-approval",
      reason: "PI approval required for report REPORT-20261102T090000-0001",
    },
  });
  root.events.forEach((event, seq) => {
    event.seq = seq;
    if (seq >= index) event.time = time + seq - index;
  });
  root.asOfSeq = root.events.length - 1;
  root.flushedThroughSeq = root.asOfSeq;
  expectRejected(snapshot, ["approval", "report_submit", "call-extra-approval"]);
});

test("treats a schema-valid failed VerificationCase as regression despite an accepted report", () => {
  // Vary the same fixture's candidate bytes, artifact sizes, VC, tool result and
  // report facts together: a join mismatch must not mask the failed-VC verdict.
  const { snapshot } = makeReplayFixture("failed");
  expectRejected(snapshot, ["VC-20261102T090000-b2c3", "failed"]);
});

test.each([
  ["task", "source_base_commit", "tasks/TASK-20261102T090000-c3d4/task.json"],
  ["base", "source_commit", "builds/BUILD-20261102T090000-f6a7/build-record.json"],
  ["candidate", "source_commit", "builds/BUILD-20261102T090000-a7b8/build-record.json"],
] as const)(
  "rejects abbreviated and drifted full SHA at the %s record, naming its field and file",
  (_kind, field, path) => {
    for (const commit of ["9a422e5", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]) {
      const { snapshot } = makeReplayFixture();
      snapshot.files[path] = { ...object(snapshot.files[path]), [field]: commit };
      expectRejected(snapshot, [field, path]);
    }
  },
);

test("the run copies carry the prepared cfg plus exactly one DT_YE_IC line", () => {
  const { snapshot, runs } = makeReplayFixture();
  // Literal oracle: the constructed prepared cfg has no DT_YE_IC line, so one LF line is appended.
  for (const { job } of runs)
    expect(snapshot.files[`runs/${job.run_id}/input/keliya/keliya.cfg.para`]).toBe(
      "START\t12053\nEND\t12143\nNUM_OPENMP\t1\nDT_YE_IC\t1440\n",
    );
  expect(
    Buffer.from(
      String(object(snapshot.files["input/keliya/keliya.cfg.para"]).bytes_base64),
      "base64",
    ).toString("latin1"),
  ).toBe("START\t12053\nEND\t12143\nNUM_OPENMP\t1\n");
});

test.each([
  ["one extra changed line", (cfg: string) => cfg.replace("START\t12053", "START\t12054")],
  ["NUM_OPENMP rewritten", (cfg: string) => cfg.replace("NUM_OPENMP\t1", "NUM_OPENMP\t8")],
  ["END rewritten", (cfg: string) => cfg.replace("END\t12143", "END\t30")],
  ["DT_YE_IC absent", (cfg: string) => cfg.replace("DT_YE_IC\t1440\n", "")],
])(
  "rejects a coherent run copy and provenance that differ from the prepared cfg beyond DT_YE_IC: %s",
  (_name, forge) => {
    const fixture = makeReplayFixture();
    const { job, data } = fixture.runs[1];
    const path = `runs/${job.run_id}/input/keliya/keliya.cfg.para`;
    const forged = forge(String(fixture.snapshot.files[path]));
    expect(forged).not.toBe(fixture.snapshot.files[path]);
    fixture.snapshot.files[path] = forged;
    // Keep the existing provenance == run-copy join satisfied so only the new oracle can reject.
    const entry = data.sources.files.find((file) => file.path === "keliya.cfg.para")!;
    entry.sha256 = createHash("sha256").update(forged).digest("hex");
    entry.size_bytes = Buffer.byteLength(forged);
    refreshReplayRunArtifacts(fixture);
    expectRejected(fixture.snapshot, ["keliya.cfg.para", job.run_id, "Run copy"]);
  },
);

test.each([
  ["tampered base64", (bytes: Record<string, unknown>) => ({ ...bytes, bytes_base64: "QUJD" })],
  [
    "missing raw bytes",
    ({ sha256, size_bytes }: Record<string, unknown>) => ({ sha256, size_bytes }),
  ],
])("rejects a prepared cfg receipt without verifiable raw bytes: %s", (_name, tamper) => {
  const { snapshot } = makeReplayFixture();
  const path = "input/keliya/keliya.cfg.para";
  snapshot.files[path] = tamper(object(snapshot.files[path]));
  expectRejected(snapshot, [path]);
});
