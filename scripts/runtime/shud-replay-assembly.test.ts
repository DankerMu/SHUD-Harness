import { expect, test } from "vitest";
import {
  makeReplayFixture,
  refreshReplayRunArtifacts,
  type ReplayFixture,
} from "./replay/test-harness.ts";
import type {
  ReplayDiagnosticFailure,
  ReplayModelScenario,
} from "./replay/session/test-harness.ts";
import { data } from "./shud-evidence-events.ts";
import { assertReplayEvidence } from "./shud-replay-evidence.ts";
import { assembleReplayEvidence } from "./shud-replay-snapshot.ts";
import { object } from "./shud-restart-evidence.ts";

const distinctModels = ["fixture-base-response", "fixture-candidate-response"] as const;
const scenarios: {
  name: string;
  models: ReplayModelScenario;
  diagnostics?: ReplayDiagnosticFailure[];
}[] = [
  { name: "an earlier read-only worker", models: { incidentalWorkers: ["readonly"] } },
  { name: "an earlier failed-attempt worker", models: { incidentalWorkers: ["failed-attempt"] } },
  {
    name: "distinct response models for the two run owners",
    models: { responseModels: distinctModels },
  },
  {
    name: "both incidental workers before distinct successful owners",
    models: {
      incidentalWorkers: ["readonly", "failed-attempt"],
      responseModels: distinctModels,
    },
  },
  {
    name: "unrelated later model headers after the bound submissions",
    models: { responseModels: distinctModels, lateHeaderModel: "fixture-later-model" },
  },
  {
    name: "a failed first attempt with another model in the actual owner's session",
    models: { responseModels: distinctModels },
    diagnostics: [
      {
        sessionId: "worker-base",
        name: "shud_run",
        callId: "failed-first-submission",
        arguments: { input_dir: "." },
        eventError: true,
        model: "fixture-failed-first-model",
      },
    ],
  },
  {
    name: "a failed same-build attempt before the actual owner's successful submission",
    models: { responseModels: distinctModels },
    diagnostics: [
      {
        sessionId: "worker-base",
        name: "shud_run",
        callId: "failed-same-build-submission",
        arguments: {
          task_id: "TASK-20261102T090000-c3d4",
          build_id: "BUILD-20261102T090000-f6a7",
          input_dir: "/fixture/replay workspace/input/keliya",
          threads: 1,
        },
        eventError: true,
        model: "fixture-failed-same-build-model",
      },
    ],
  },
];

function assemblyInput(fixture: ReplayFixture) {
  const { snapshot } = fixture;
  // Deliberately exclude the fixture's prefilled actualStack. The CLI assembly
  // seam must derive producer model provenance from these records and logs.
  return {
    workspace: snapshot.workspace,
    home: snapshot.home,
    rootId: "replay-root",
    configPath: snapshot.delegationBindings[0].configPath,
    logs: { root: snapshot.root, children: snapshot.children },
    files: snapshot.files,
    before: snapshot.preservation.before,
    after: snapshot.preservation.after,
    configuration: {
      base_url: "https://example.invalid",
      request_alias: "fixture-model",
      delegations: snapshot.delegationBindings.map(({ provider, agentPreset, toolName }) => ({
        provider,
        agentPreset,
        toolName,
      })),
    },
  };
}

test.each(scenarios)("assembles complete replay evidence with $name", ({ models, diagnostics }) => {
  const fixture = makeReplayFixture("passed", diagnostics ?? [], {}, models);
  const input = assemblyInput(fixture);
  const retained = structuredClone(input);
  const assembled = assembleReplayEvidence(input);
  expect(assembled.actualStack.llm).toMatchObject({
    base_url: "https://example.invalid",
    request_alias: "fixture-model",
  });
  expect(assembled.files).toEqual(input.files);
  expect(assembled.children).toEqual(input.logs.children);
  expect(assertReplayEvidence(assembled).status).toBe("PASS");
  expect(input).toEqual(retained);
});

test.each([
  "read-only owner",
  "failed-attempt owner",
  "other successful owner",
  "StackLock model",
  "RunRecord model",
  "submission request model",
])("rejects mismatched %s through snapshot assembly and judging", (mismatch) => {
  const ownerMismatch = mismatch.endsWith("owner");
  const fixture = makeReplayFixture(
    "passed",
    [],
    {},
    {
      incidentalWorkers:
        mismatch === "read-only owner"
          ? ["readonly"]
          : mismatch === "failed-attempt owner"
            ? ["failed-attempt"]
            : [],
      ...(ownerMismatch ? {} : { responseModels: distinctModels }),
    },
  );
  const base = fixture.runs[0];
  if (mismatch === "read-only owner") base.job.owner_session = "worker-readonly";
  if (mismatch === "failed-attempt owner") base.job.owner_session = "worker-failed-attempt";
  if (mismatch === "other successful owner")
    base.job.owner_session = fixture.runs[1].job.owner_session;
  if (mismatch === "StackLock model") base.stack.llm.response_model = "foreign-model";
  if (mismatch === "RunRecord model") {
    // Keep the existing job/record/report joins coherent, isolating the
    // mismatch with the successful producer's observed request model.
    base.job.llm.response_model = "foreign-model";
    base.record.llm.response_model = "foreign-model";
    fixture.report.llm_response_models = ["foreign-model", "fixture-candidate-response"];
  }
  if (mismatch === "submission request model") {
    const owner = fixture.snapshot.children.find((log) => log.header.id === "worker-base")!;
    for (const event of owner.events) {
      if (event.type === "request/header")
        object(object(data(event).header).config).model = "foreign-model";
      if (event.type === "assistant/message")
        object(object(data(event).message).source).model = "foreign-model";
    }
  }
  refreshReplayRunArtifacts(fixture);
  const input = assemblyInput(fixture);
  const retained = structuredClone(input);
  expect(() => assertReplayEvidence(assembleReplayEvidence(input))).toThrow();
  expect(input).toEqual(retained);
});
