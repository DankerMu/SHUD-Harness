import { expect, test } from "vitest";
import { assertReplayEvidence } from "./shud-replay-evidence.ts";
import {
  makeReplayFixture,
  refreshReplayRunArtifacts,
  type ReplayFixture,
} from "./replay/test-harness.ts";
import { calls, data, resultFor, validateLog } from "./shud-evidence-events.ts";
import { object } from "./shud-restart-evidence.ts";

const negatives: {
  name: string;
  mutate(this: void, fixture: ReplayFixture): void;
  diagnostic: string;
}[] = [
  {
    name: "non-code-change task",
    mutate: ({ task }) => {
      task.type = "engineering";
      task.source_base_commit = null;
    },
    diagnostic: "TaskCard",
  },
  {
    name: "missing required changed file",
    mutate: ({ change }) => {
      change.files_changed = ["Makefile"];
    },
    diagnostic: "ChangeRequest",
  },
  {
    name: "outside five-file allowance",
    mutate: ({ change }) => {
      change.files_changed.push("z-outside.cpp");
    },
    diagnostic: "ChangeRequest",
  },
  {
    name: "wrong change approval reference",
    mutate: ({ change, snapshot, report }) => {
      change.approval_ref = "foreign-call";
      const path = `reports/${report.report_id}.md`;
      snapshot.files[path] = String(snapshot.files[path]).replaceAll(
        "call-change-submit",
        "foreign-call",
      );
    },
    diagnostic: "Approval reference",
  },
  {
    name: "candidate patch drift",
    mutate: ({ builds }) => {
      builds[1].patch_sha256 = "1".repeat(64);
    },
    diagnostic: "candidate build",
  },
  {
    name: "run thread drift",
    mutate: ({ runs }) => {
      runs[0].job.threads = 2;
    },
    diagnostic: "RunJob",
  },
  {
    name: "wrong project",
    mutate: ({ runs }) => {
      runs[0].job.project = "ccw";
    },
    diagnostic: "RunJob",
  },
  {
    name: "unbound native argv",
    mutate: ({ runs }) => {
      runs[0].job.command[0] = "/foreign/shud";
    },
    diagnostic: "RunJob",
  },
  {
    name: "run-record build mismatch",
    mutate: ({ runs, builds }) => {
      runs[0].record.build_id = builds[1].build_id;
    },
    diagnostic: "RunRecord",
  },
  {
    name: "31 external references",
    mutate: ({ runs }) => {
      runs[1].data.sources.external_files.pop();
    },
    diagnostic: "provenance",
  },
  {
    name: "run-local provenance root instead of the original input directory",
    mutate: ({ runs }) => {
      runs[0].data.sources.input_root = `${runs[0].job.run_dir}/input`;
    },
    diagnostic: "Stack/provenance",
  },
  {
    name: "wrong VC run",
    mutate: ({ verification }) => {
      verification.base_run_id = verification.candidate_run_id;
    },
    diagnostic: "VC artifact",
  },
  {
    name: "missing VC despite all model claims",
    mutate: ({ snapshot, verification }) => {
      delete snapshot.files[`verifications/${verification.vc_id}.json`];
    },
    diagnostic: "VerificationCase",
  },
  {
    name: "missing task verification link",
    mutate: ({ task }) => {
      task.linked_verifications = [];
    },
    diagnostic: "Task/report",
  },
  {
    name: "duplicate StackLock build identity",
    mutate: ({ runs }) => {
      runs[1].stack.build_id = runs[0].stack.build_id;
    },
    diagnostic: "Stack/provenance",
  },
  {
    name: "missing governance sentence",
    mutate: ({ snapshot, report }) => {
      const path = `reports/${report.report_id}.md`;
      snapshot.files[path] = String(snapshot.files[path]).replace("校准结果不等于结构验证", "");
    },
    diagnostic: "Markdown invariants",
  },
  {
    name: "missing CR fact table",
    mutate: ({ snapshot, report, change }) => {
      const path = `reports/${report.report_id}.md`;
      snapshot.files[path] = String(snapshot.files[path]).replace(
        `### ChangeRequest ${change.change_id}`,
        "### Removed evidence",
      );
    },
    diagnostic: "Markdown facts",
  },
  {
    name: "foreign job owner",
    mutate: ({ runs }) => {
      runs[0].job.owner_session = "foreign-session";
    },
    diagnostic: "Worker run args",
  },
  {
    name: "foreign child parent",
    mutate: ({ snapshot }) => {
      snapshot.children[0].header.parentSession = "foreign-root";
    },
    diagnostic: "Child ownership",
  },
  {
    name: "wrong child role",
    mutate: ({ snapshot }) => {
      snapshot.children[0].header.agentPreset = "worker";
    },
    diagnostic: "approval",
  },
  {
    name: "unflushed child",
    mutate: ({ snapshot }) => {
      snapshot.children[1].flushedThroughSeq = -1;
    },
    diagnostic: "CANONICAL_LOG",
  },
  {
    name: "missing delegation tool header",
    mutate: ({ snapshot }) => {
      const header = snapshot.root.events.find((event) => event.type === "request/header")!;
      object(data(header).header).tools = [{ name: "subagent" }];
    },
    diagnostic: "delegation tools",
  },
  {
    name: "failed base producer",
    mutate: ({ snapshot }) => {
      const result = snapshot.children[0].events.find((event) => event.type === "tool/result")!;
      object(data(result).message).isError = true;
    },
    diagnostic: "TOOL_RESULT",
  },
  {
    name: "wrong tool result call join",
    mutate: ({ snapshot }) => {
      const result = snapshot.children[0].events.find((event) => event.type === "tool/result")!;
      object(data(result).message).toolCallId = "foreign-call";
    },
    diagnostic: "TOOL_RESULT",
  },
  {
    name: "candidate precedes successful base collect",
    mutate: ({ snapshot }) => {
      const candidate = snapshot.children.find((child) => child.header.id === "coder-candidate")!;
      candidate.events.forEach((event) => {
        event.time -= 10_000;
      });
    },
    diagnostic: "Cross-session order",
  },
  {
    name: "rejected engineering approval",
    mutate: ({ snapshot }) => {
      const decision = snapshot.children[0].events.find(
        (event) => event.type === "approval/decided",
      )!;
      data(decision).outcome = "rejected";
    },
    diagnostic: "allowed-once",
  },
  {
    name: "prepared input changed after preparation",
    mutate: ({ snapshot }) => {
      snapshot.files["input/keliya/keliya.cfg.para"] = "hello";
      snapshot.preservation.after.preparedInputSha256!["keliya.cfg.para"] =
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    },
    diagnostic: "prepared input/keliya",
  },
  {
    name: "missing prepared-copy receipts",
    mutate: ({ snapshot }) => {
      snapshot.preservation.before.preparedInputSha256 = null;
      snapshot.preservation.after.preparedInputSha256 = null;
    },
    diagnostic: "Missing prepared input preservation receipt",
  },
  {
    name: "private clone drift",
    mutate: ({ snapshot }) => {
      snapshot.preservation.after.clone!.head = "a".repeat(40);
    },
    diagnostic: "clone",
  },
  {
    name: "root revision mutation",
    mutate: ({ snapshot }) => {
      snapshot.preservation.after.repositories.SHUD.head = "a".repeat(40);
    },
    diagnostic: "Preservation",
  },
  {
    name: "new root git file",
    mutate: ({ snapshot }) => {
      snapshot.preservation.after.shudGit.inventory.push("worktrees/foreign/gitdir");
    },
    diagnostic: "Preservation",
  },
  {
    name: "raw mutation",
    mutate: ({ snapshot }) => {
      snapshot.preservation.after.raw.md5["retained.bin"] = "a".repeat(32);
    },
    diagnostic: "Preservation",
  },
  {
    name: "unreferenced forcing mutation",
    mutate: ({ snapshot }) => {
      snapshot.preservation.after.forcingSha256[
        "/fixture/basin/forcing.trimmed/unreferenced-34.csv"
      ] = "a".repeat(64);
    },
    diagnostic: "Preservation",
  },
];

test.each(negatives)("rejects $name from the consumer snapshot", ({ mutate, diagnostic }) => {
  const fixture = makeReplayFixture();
  mutate(fixture);
  const retained = structuredClone(fixture.snapshot);
  expect(() => assertReplayEvidence(fixture.snapshot)).toThrow(diagnostic);
  expect(fixture.snapshot).toEqual(retained);
});

test("rejects flattened copied input artifacts instead of the project directory", () => {
  const { runs, snapshot } = makeReplayFixture();
  const run = runs[0];
  const prefix = `runs/${run.job.run_id}/input`;
  for (const file of run.data.sources.files) {
    const copied = `${prefix}/keliya/${file.path}`;
    snapshot.files[`${prefix}/${file.path}`] = snapshot.files[copied];
    delete snapshot.files[copied];
  }
  const retained = structuredClone(snapshot);
  expect(() => assertReplayEvidence(snapshot)).toThrow();
  expect(snapshot).toEqual(retained);
});

test("rejects a RunRecord output root belonging to another project", () => {
  const fixture = makeReplayFixture();
  const { runs, snapshot } = fixture;
  runs[0].record.artifacts.shud_output = `${runs[0].job.run_dir}/output/foreign.out`;
  refreshReplayRunArtifacts(fixture);
  const retained = structuredClone(snapshot);
  expect(() => assertReplayEvidence(snapshot)).toThrow();
  expect(snapshot).toEqual(retained);
});

test("rejects artifact paths that repeat the project output directory", () => {
  const fixture = makeReplayFixture();
  const { runs, snapshot } = fixture;
  // Both old run-relative lookups must reach their bytes, so the other run
  // cannot mask acceptance of the wrong base with an unrelated missing file.
  for (const run of runs)
    run.record.artifacts.files[0].path = "output/keliya.out/keliya.rivqdown.dat";
  refreshReplayRunArtifacts(fixture);
  const retained = structuredClone(snapshot);
  expect(() => assertReplayEvidence(snapshot)).toThrow();
  expect(snapshot).toEqual(retained);
});

test("accepts raw absent both before and after, without fabricating a raw root", () => {
  const { snapshot } = makeReplayFixture();
  snapshot.preservation.before.raw = { exists: false, md5: {} };
  snapshot.preservation.after.raw = { exists: false, md5: {} };
  expect(assertReplayEvidence(snapshot).status).toBe("PASS");
});

test("rejects base-worker dispatch before the change coder returns despite ordered producer calls", () => {
  const { snapshot } = makeReplayFixture();
  const root = snapshot.root;
  const coder = snapshot.children.find((child) => child.header.id === "coder-base")!;
  const noticeIndex = root.events.findIndex(
    (event) =>
      event.type === "user/message" && object(data(event).source).senderSessionId === "coder-base",
  );
  const [notice] = root.events.splice(noticeIndex, 1);
  const workerIndex = root.events.findIndex(
    (event) =>
      event.type === "user/message" && object(data(event).source).senderSessionId === "worker-base",
  );
  notice.time = root.events[workerIndex].time - 1;
  coder.events[coder.events.length - 2].time = notice.time - 2;
  coder.events[coder.events.length - 1].time = notice.time - 1;
  root.events.splice(workerIndex, 0, notice);
  root.events.forEach((event, seq) => {
    event.seq = seq;
  });
  // D13:856 forbids dispatching the base worker alongside the change coder.
  const retained = structuredClone(snapshot);
  expect(() => assertReplayEvidence(snapshot)).toThrow();
  expect(snapshot).toEqual(retained);
});

const serialBoundaries = [
  {
    name: "approved change to base worker",
    previous: "coder-base",
    producer: "change_submit",
    next: "worker-base",
    consumer: "shud_run",
  },
  {
    name: "base collection to candidate coder",
    previous: "worker-base",
    producer: "shud_collect",
    next: "coder-candidate",
    consumer: "shud_build",
  },
  {
    name: "candidate collection to reviewer",
    previous: "worker-candidate",
    producer: "shud_collect",
    next: "reviewer",
    consumer: "verification_run",
  },
];

test.each(
  serialBoundaries.flatMap((boundary) =>
    (["before producer", "before settlement"] as const).map((ordering) => ({
      ...boundary,
      ordering,
    })),
  ),
)("rejects $name dispatch $ordering despite correctly delayed consumer work", (boundary) => {
  const { snapshot } = makeReplayFixture();
  const root = snapshot.root;
  const previous = snapshot.children.find((log) => log.header.id === boundary.previous)!;
  const next = snapshot.children.find((log) => log.header.id === boundary.next)!;
  const producer = calls(previous, boundary.producer)[0];
  const produced = resultFor(previous, producer, "TOOL_RESULT");
  const consumer = calls(next, boundary.consumer)[0];
  const dispatch = root.events.find(
    (event) => event.type === "tool/call" && data(event).callId === `dispatch-${boundary.next}`,
  )!;
  const notice = root.events.find(
    (event) =>
      event.type === "user/message" &&
      object(data(event).source).senderSessionId === boundary.previous,
  )!;
  // Move the entire advertised invocation, catalog and bound result, not just
  // its timestamp. The child is created early but delays its producer work.
  const block = root.events.splice(dispatch.seq - 1, 4);
  expect(block.map((event) => event.type)).toEqual([
    "assistant/message",
    "tool/call",
    "subagent/catalog",
    "tool/result",
  ]);
  const start = boundary.ordering === "before producer" ? producer.time - 8 : produced.time + 1;
  for (const [index, offset] of [0, 1, 3, 4].entries()) block[index].time = start + offset;
  next.header.createdAt = start + 2;
  data(block[2]).childCreatedAt = next.header.createdAt;
  if (boundary.ordering === "before settlement") {
    previous.events.at(-1)!.time = block[3].time + 1;
    notice.time = previous.events.at(-1)!.time + 1;
  }
  root.events.splice(root.events.indexOf(notice), 0, ...block);
  root.events.forEach((event, seq) => {
    event.seq = seq;
  });
  root.asOfSeq = root.events.length - 1;
  root.flushedThroughSeq = root.asOfSeq;
  for (const log of [root, ...snapshot.children]) {
    validateLog(log, snapshot.home);
    expect(
      log.events.every((event, index) => index === 0 || log.events[index - 1].time <= event.time),
    ).toBe(true);
  }
  expect(consumer.time).toBeGreaterThan(produced.time);
  expect(dispatch.seq).toBeLessThan(notice.seq);
  expect(next.events[0].time).toBeGreaterThan(Number(next.header.createdAt));
  if (boundary.ordering === "before producer") expect(dispatch.time).toBeLessThan(producer.time);
  else expect(dispatch.time).toBeGreaterThan(produced.time);
  const retained = structuredClone(snapshot);
  expect(() => assertReplayEvidence(snapshot)).toThrow();
  expect(snapshot).toEqual(retained);
});

test("accepts ordered base build and approved change production within the same coder session", () => {
  const { snapshot } = makeReplayFixture();
  const coder = snapshot.children.find((log) => log.header.id === "coder-base")!;
  const build = calls(coder, "shud_build")[0];
  const create = calls(coder, "change_create")[0];
  const submit = calls(coder, "change_submit")[0];
  expect(resultFor(coder, build, "TOOL_RESULT").seq).toBeLessThan(create.seq);
  expect(resultFor(coder, create, "TOOL_RESULT").seq).toBeLessThan(submit.seq);
  const retained = structuredClone(snapshot);
  expect(assertReplayEvidence(snapshot).status).toBe("PASS");
  expect(snapshot).toEqual(retained);
});
