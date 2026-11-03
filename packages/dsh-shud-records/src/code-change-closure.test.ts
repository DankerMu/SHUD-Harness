import { inspect } from "node:util";
import { describe, expect, test, vi } from "vitest";
import { ChangeRequestSchema, VerificationCaseSchema } from "@shud-harness/dsh-shud-core";
import { codeChangeClosure, evaluateClosure, type ClosureResult } from "./index.ts";
import {
  approvedChange,
  closureEvidence,
  evidenceLoaders,
  freezeEvidence,
  OTHER_CHANGE,
  OTHER_TASK,
  OTHER_VERIFICATION,
  PRIVATE_PAYLOAD,
  terminalVerification,
} from "./code-change-closure-test-harness.ts";

const SUCCESS = {
  ok: true,
  failures: [],
  metric_fact: true,
  automatic_limitation: "本里程碑无指标 artifact，不能据此作指标或模型改进结论。",
};

function denied(result: ClosureResult, facts: Record<string, unknown>): void {
  expect(result.ok).toBe(false);
  expect(result.failures).toEqual(expect.arrayContaining([expect.objectContaining(facts)]));
  expect(inspect(result, { depth: null })).not.toContain(PRIVATE_PAYLOAD);
}

function readFailure(result: ClosureResult, facts: Record<string, unknown>): void {
  denied(result, { ...facts, reason: expect.stringMatching(/read|schema|identity/u) });
  expect(result.failures).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ clause: 3 })]),
  );
}

describe("code_change closure public contract", () => {
  test.each(["passed", "failed"] as const)(
    "%s verification is reportable closure evidence",
    (status) => {
      const input = closureEvidence();
      if (status === "failed") {
        input.verification = terminalVerification({
          status,
          failure_reason: "Archived output bytes differ.",
          observed: { ...input.verification.observed, candidate_sha256: "0".repeat(64) },
          compatibility_verdict: "incompatible",
        });
      }
      const { loaders, reads } = evidenceLoaders(input);
      const before = structuredClone(input);
      freezeEvidence(input);
      const direct = codeChangeClosure(input.card, loaders);
      expect(direct).toStrictEqual(SUCCESS);
      expect(direct).not.toBeInstanceOf(Promise);
      expect(reads).toEqual({
        changes: [input.change.change_id],
        patches: [input.change.change_id],
        verifications: [input.verification.vc_id],
        tasks: [input.card.task_id],
      });
      expect(
        evaluateClosure(input.card, input.runJobs, input.records, input.draft, loaders),
      ).toStrictEqual(SUCCESS);
      expect(reads.tasks).toEqual([input.card.task_id]);
      expect(input).toStrictEqual(before);
    },
  );

  test("missing object loaders fail closed instead of falling back to science closure", () => {
    const input = closureEvidence();
    const result = evaluateClosure(input.card, input.runJobs, input.records, input.draft);
    denied(result, { reason: expect.stringMatching(/loader/u) });
    expect(result.failures).not.toContainEqual({ reason: "unsupported_task_type" });
  });

  test("science closure ignores the fifth argument and retains its literal result", () => {
    const input = closureEvidence();
    input.card.type = "science_assist";
    const { loaders, reads } = evidenceLoaders(input);
    expect(
      evaluateClosure(input.card, input.runJobs, input.records, input.draft, loaders),
    ).toStrictEqual(SUCCESS);
    expect(reads).toEqual({ changes: [], patches: [], verifications: [], tasks: [] });
  });

  test.each(["engineering", "ops"] as const)("%s remains unsupported", (type) => {
    const input = closureEvidence();
    input.card.type = type;
    const { loaders } = evidenceLoaders(input);
    expect(
      evaluateClosure(input.card, input.runJobs, input.records, input.draft, loaders),
    ).toStrictEqual({
      ...SUCCESS,
      ok: false,
      failures: [{ reason: "unsupported_task_type" }],
    });
  });

  test.each(["science_assist", "engineering", "ops"] as const)(
    "direct predicate rejects %s",
    (type) => {
      const input = closureEvidence();
      input.card.type = type;
      denied(codeChangeClosure(input.card, evidenceLoaders(input).loaders), {
        reason: "unsupported_task_type",
      });
    },
  );

  test("a throwing task snapshot is normalized without its private cause", () => {
    const input = closureEvidence();
    const { loaders } = evidenceLoaders(input);
    const readJobs = vi.fn(() => {
      throw new Error(PRIVATE_PAYLOAD, { cause: { payload: PRIVATE_PAYLOAD } });
    });
    loaders.listRunJobsByTask = readJobs;
    const result = codeChangeClosure(input.card, loaders);
    denied(result, { reason: expect.stringMatching(/read|load|query/u) });
    expect(readJobs).toHaveBeenCalledExactlyOnceWith(input.card.task_id);
    expect(inspect(result, { depth: null })).not.toContain("cause");
  });

  test("an empty task snapshot cannot borrow the supplied RunRecords", () => {
    const input = closureEvidence();
    input.runJobs = [];
    denied(codeChangeClosure(input.card, evidenceLoaders(input).loaders), {
      clause: 5,
      reason: "missing_job",
      job_id: input.card.linked_jobs[0],
    });
  });
});

describe("clauses zero and one", () => {
  test.each([
    ["observations", "missing_observations"],
    ["limitations", "missing_limitations"],
    ["pi_questions", "missing_pi_questions"],
  ] as const)("empty authored %s blocks without automatic augmentation", (field, reason) => {
    const input = closureEvidence();
    input.draft[field] = [];
    freezeEvidence(input);
    denied(codeChangeClosure(input.card, evidenceLoaders(input).loaders), { clause: 0, reason });
    expect(input.draft[field]).toEqual([]);
  });

  test("empty linked_jobs fails clause zero even with otherwise complete evidence", () => {
    const input = closureEvidence();
    input.card.linked_jobs = [];
    denied(codeChangeClosure(input.card, evidenceLoaders(input).loaders), {
      clause: 0,
      reason: "no_linked_jobs",
    });
  });

  test("authored text is counted, not classified as a scientific or model verdict", () => {
    const input = closureEvidence();
    input.draft = { observations: [""], limitations: [""], pi_questions: ["The model says done."] };
    expect(codeChangeClosure(input.card, evidenceLoaders(input).loaders)).toStrictEqual(SUCCESS);
  });

  test.each(["empty", "proposed"] as const)("%s change links cannot satisfy clause one", (kind) => {
    const input = closureEvidence();
    if (kind === "empty") input.card.linked_changes = [];
    else
      input.change = ChangeRequestSchema.parse({
        ...input.change,
        status: "proposed",
        approval_ref: null,
        approved_at: null,
      });
    const { loaders, reads } = evidenceLoaders(input);
    denied(codeChangeClosure(input.card, loaders), { clause: 1 });
    expect(reads.patches).toEqual([]);
    expect(reads.changes).toEqual(input.card.linked_changes);
  });

  test.each(["missing", "digest", "string", "array", "null"] as const)(
    "%s approved patch fails with its change id",
    (kind) => {
      const input = closureEvidence();
      const { loaders, patches } = evidenceLoaders(input);
      if (kind === "missing") patches.clear();
      else if (kind === "digest")
        patches.set(input.change.change_id, new Uint8Array([0x61, 0x62, 0x64]));
      else
        loaders.readPatch = () =>
          ({ string: "abc", array: [97, 98, 99], null: null })[kind] as unknown as Uint8Array;
      denied(codeChangeClosure(input.card, loaders), {
        clause: 1,
        change_id: input.change.change_id,
      });
    },
  );

  test("hashes the exact Uint8Array view, not the backing buffer or decoded text", () => {
    const input = closureEvidence();
    const backing = new Uint8Array([0xff, 0x61, 0x62, 0x63, 0xfe]);
    input.patch = backing.subarray(1, 4);
    expect(codeChangeClosure(input.card, evidenceLoaders(input).loaders)).toStrictEqual(SUCCESS);
    expect([...backing]).toEqual([0xff, 0x61, 0x62, 0x63, 0xfe]);
  });

  test.each(["missing", "digest"] as const)(
    "a good pair cannot hide a sibling approved patch's %s failure",
    (kind) => {
      const input = closureEvidence();
      const { loaders, changes, patches } = evidenceLoaders(input);
      input.card.linked_changes.push(OTHER_CHANGE);
      changes.set(
        OTHER_CHANGE,
        approvedChange({ change_id: OTHER_CHANGE, patch_path: `patches/${OTHER_CHANGE}.patch` }),
      );
      if (kind === "digest") patches.set(OTHER_CHANGE, new Uint8Array([0]));
      denied(codeChangeClosure(input.card, loaders), { clause: 1, change_id: OTHER_CHANGE });
    },
  );
});

describe("clause two is existential, linked-file validity is global", () => {
  test.each(["not_run", "running", "inconclusive", "waived_by_pi"] as const)(
    "a lone %s verification cannot witness closure",
    (status) => {
      const input = closureEvidence();
      input.verification = terminalVerification({ status });
      denied(codeChangeClosure(input.card, evidenceLoaders(input).loaders), {
        clause: 2,
        vc_id: input.verification.vc_id,
      });
    },
  );

  test.each([
    "not_run",
    "running",
    "inconclusive",
    "waived_by_pi",
    "unlinked_change",
    "proposed_change",
  ] as const)("a valid witness survives a valid %s alternative in either link order", (kind) => {
    for (const reverse of [false, true]) {
      const input = closureEvidence();
      const { loaders, changes, verifications, reads } = evidenceLoaders(input);
      const alternative = terminalVerification({
        vc_id: OTHER_VERIFICATION,
        ...(kind === "unlinked_change" || kind === "proposed_change"
          ? { change_id: OTHER_CHANGE }
          : { status: kind }),
      });
      input.card.linked_verifications.push(OTHER_VERIFICATION);
      verifications.set(OTHER_VERIFICATION, alternative);
      if (kind === "proposed_change") {
        input.card.linked_changes.push(OTHER_CHANGE);
        changes.set(
          OTHER_CHANGE,
          ChangeRequestSchema.parse({
            ...input.change,
            change_id: OTHER_CHANGE,
            patch_path: `patches/${OTHER_CHANGE}.patch`,
            status: "proposed",
            approval_ref: null,
            approved_at: null,
          }),
        );
      }
      if (reverse) input.card.linked_verifications.reverse();
      expect(codeChangeClosure(input.card, loaders)).toStrictEqual(SUCCESS);
      expect(reads.patches).toEqual([input.change.change_id]);
      expect(reads.verifications).toEqual(input.card.linked_verifications);
    }
  });

  test.each(["empty", "unlinked_change", "proposed_change"] as const)(
    "%s cannot supply a qualifying verification",
    (kind) => {
      const input = closureEvidence();
      if (kind === "empty") input.card.linked_verifications = [];
      else input.verification.change_id = OTHER_CHANGE;
      const { loaders, changes } = evidenceLoaders(input);
      if (kind === "proposed_change") {
        input.card.linked_changes.push(OTHER_CHANGE);
        changes.set(
          OTHER_CHANGE,
          ChangeRequestSchema.parse({
            ...input.change,
            change_id: OTHER_CHANGE,
            patch_path: `patches/${OTHER_CHANGE}.patch`,
            status: "proposed",
            approval_ref: null,
            approved_at: null,
          }),
        );
      }
      denied(codeChangeClosure(input.card, loaders), {
        clause: 2,
        ...(kind === "empty" ? {} : { vc_id: input.verification.vc_id }),
      });
    },
  );

  test("unlinked qualifying files are never requested or discovered", () => {
    const input = closureEvidence();
    input.card.linked_verifications = [];
    const { loaders, reads } = evidenceLoaders(input);
    denied(codeChangeClosure(input.card, loaders), { clause: 2 });
    expect(reads.verifications).toEqual([]);
  });

  test("each distinct linked object and required patch is read exactly once without mutating links", () => {
    const input = closureEvidence();
    input.card.linked_changes.push(input.change.change_id);
    input.card.linked_verifications.push(input.verification.vc_id);
    input.card.linked_jobs.push(input.card.linked_jobs[0]);
    const { loaders, reads } = evidenceLoaders(input);
    const before = structuredClone(input);
    freezeEvidence(input);
    expect(codeChangeClosure(input.card, loaders)).toStrictEqual(SUCCESS);
    expect(reads).toEqual({
      changes: [input.change.change_id],
      patches: [input.change.change_id],
      verifications: [input.verification.vc_id],
      tasks: [input.card.task_id],
    });
    expect(input).toStrictEqual(before);
  });

  test.each(["change", "verification"] as const)(
    "foreign linked %s ownership is an id-qualified failure",
    (kind) => {
      const input = closureEvidence();
      input[kind].task_id = OTHER_TASK;
      denied(codeChangeClosure(input.card, evidenceLoaders(input).loaders), {
        reason: expect.stringMatching(/foreign|identity|task_mismatch/u),
        ...(kind === "change"
          ? { change_id: input.change.change_id }
          : { vc_id: input.verification.vc_id }),
      });
    },
  );

  test.each(["change", "verification"] as const)(
    "%s embedded identity cannot substitute for the requested linked id",
    (kind) => {
      const input = closureEvidence();
      const { loaders, changes, verifications } = evidenceLoaders(input);
      if (kind === "change")
        changes.set(
          input.change.change_id,
          approvedChange({ change_id: OTHER_CHANGE, patch_path: `patches/${OTHER_CHANGE}.patch` }),
        );
      else
        verifications.set(
          input.verification.vc_id,
          terminalVerification({ vc_id: OTHER_VERIFICATION }),
        );
      readFailure(
        codeChangeClosure(input.card, loaders),
        kind === "change"
          ? { change_id: input.change.change_id }
          : { vc_id: input.verification.vc_id },
      );
    },
  );

  test.each(["change", "verification"] as const)(
    "all linked %s files are checked even after a qualifying pair",
    (kind) => {
      for (const failure of ["missing", "schema", "foreign", "identity"] as const) {
        const input = closureEvidence();
        const { loaders, changes, verifications } = evidenceLoaders(input);
        const id = kind === "change" ? OTHER_CHANGE : OTHER_VERIFICATION;
        const facts = kind === "change" ? { change_id: id } : { vc_id: id };
        if (kind === "change") {
          input.card.linked_changes.push(OTHER_CHANGE);
          if (failure !== "missing")
            changes.set(OTHER_CHANGE, {
              ...input.change,
              change_id: failure === "identity" ? input.change.change_id : OTHER_CHANGE,
              patch_path: `patches/${failure === "identity" ? input.change.change_id : OTHER_CHANGE}.patch`,
              status: "proposed",
              approval_ref: null,
              approved_at: null,
              ...(failure === "schema" ? { semantic_level: PRIVATE_PAYLOAD } : {}),
              ...(failure === "foreign" ? { task_id: OTHER_TASK } : {}),
            });
        } else {
          input.card.linked_verifications.push(OTHER_VERIFICATION);
          if (failure !== "missing")
            verifications.set(OTHER_VERIFICATION, {
              ...input.verification,
              vc_id: failure === "identity" ? input.verification.vc_id : OTHER_VERIFICATION,
              status: "not_run",
              ...(failure === "schema" ? { reviewer_notes: [] } : {}),
              ...(failure === "foreign" ? { task_id: OTHER_TASK } : {}),
            });
        }
        denied(codeChangeClosure(input.card, loaders), {
          ...facts,
          reason: expect.stringMatching(/read|schema|identity|foreign|task_mismatch/u),
        });
      }
    },
  );

  test.each([
    { reviewer_notes: [] },
    { reviewed_by: "" },
    { status: "passed", failure_reason: "invalid" },
  ])("schema-invalid reviewer evidence is a read failure, not clause three: %j", (invalid) => {
    const input = closureEvidence();
    const { loaders, verifications } = evidenceLoaders(input);
    const raw = { ...input.verification, ...invalid };
    expect(VerificationCaseSchema.safeParse(raw).success).toBe(false);
    verifications.set(input.verification.vc_id, raw);
    readFailure(codeChangeClosure(input.card, loaders), { vc_id: input.verification.vc_id });
  });

  test("missing semantic_level is a schema read failure, not an invented clause four predicate", () => {
    const input = closureEvidence();
    const { loaders, changes } = evidenceLoaders(input);
    changes.set(input.change.change_id, { ...input.change, semantic_level: undefined });
    readFailure(codeChangeClosure(input.card, loaders), { change_id: input.change.change_id });
  });

  test.each(["readChange", "readVerification", "readPatch"] as const)(
    "%s exceptions omit raw payload, stack and cause",
    (reader) => {
      const input = closureEvidence();
      const { loaders } = evidenceLoaders(input);
      loaders[reader] = () => {
        throw new Error(PRIVATE_PAYLOAD, { cause: { payload: PRIVATE_PAYLOAD } });
      };
      const result = codeChangeClosure(input.card, loaders);
      denied(
        result,
        reader === "readVerification"
          ? { vc_id: input.verification.vc_id }
          : { change_id: input.change.change_id },
      );
      expect(inspect(result, { depth: null })).not.toContain("cause");
      expect(inspect(result, { depth: null })).not.toContain("Error:");
    },
  );

  test("a verification can witness a later approved change, with all required patches read", () => {
    const input = closureEvidence();
    input.card.linked_changes.push(OTHER_CHANGE);
    input.verification.change_id = OTHER_CHANGE;
    const { loaders, changes, patches, reads } = evidenceLoaders(input);
    changes.set(
      OTHER_CHANGE,
      approvedChange({
        change_id: OTHER_CHANGE,
        patch_path: `patches/${OTHER_CHANGE}.patch`,
      }),
    );
    patches.set(OTHER_CHANGE, input.patch);
    expect(codeChangeClosure(input.card, loaders)).toStrictEqual(SUCCESS);
    expect(reads.changes).toEqual(input.card.linked_changes);
    expect(reads.patches).toEqual(input.card.linked_changes);
  });

  test.each(["change", "verification"] as const)(
    "invalid %s reader payloads cannot leak or substitute for linked evidence",
    (kind) => {
      for (const raw of [null, undefined, [], PRIVATE_PAYLOAD, 529]) {
        const input = closureEvidence();
        const { loaders, changes, verifications } = evidenceLoaders(input);
        if (kind === "change") changes.set(input.change.change_id, raw);
        else verifications.set(input.verification.vc_id, raw);
        readFailure(
          codeChangeClosure(input.card, loaders),
          kind === "change"
            ? { change_id: input.change.change_id }
            : { vc_id: input.verification.vc_id },
        );
      }
    },
  );

  test("an invalid embedded id is omitted from diagnostics in favor of its requested id", () => {
    const input = closureEvidence();
    const { loaders, verifications } = evidenceLoaders(input);
    verifications.set(input.verification.vc_id, {
      ...input.verification,
      vc_id: PRIVATE_PAYLOAD,
    });
    readFailure(codeChangeClosure(input.card, loaders), { vc_id: input.verification.vc_id });
  });
});
