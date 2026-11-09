import { dirname, join } from "node:path";
import {
  BuildRecordSchema,
  ChangeRequestSchema,
  VerificationCaseSchema,
  type BuildRecord,
  type ChangeRequest,
  type VerificationCase,
  type EvidenceReport,
  type ChangeId,
  type VerificationId,
} from "@shud-harness/dsh-shud-core";
import { buildCase, changeCase, verificationCase } from "./workspace-files-test-harness.ts";
import {
  makeValidationWorkspace,
  realFs,
  type ValidationWorkspace,
} from "./report-validation-test-harness.ts";

// Literal expected wording from the issue/spec, not the renderer or constant under test.
export const CODE_CHANGE_WORDING =
  "验证判定见 §3 VerificationCase 表。bitwise 一致只证明候选在 N=1 下与 serial baseline 输出一致，不构成并行正确性、性能或模型改进结论。";

export interface CodeChangeWorkspace extends ValidationWorkspace {
  report: EvidenceReport;
  changes: ChangeRequest[];
  verifications: VerificationCase[];
  builds: BuildRecord[];
  facts: (
    | { kind: "change"; id: ChangeId; path: string; value: ChangeRequest }
    | { kind: "verification"; id: VerificationId; path: string; value: VerificationCase }
    | { kind: "build"; id: BuildRecord["build_id"]; path: string; value: BuildRecord }
  )[];
  republish(): void;
}

export function makeCodeChangeWorkspace(): CodeChangeWorkspace {
  const workspace = makeValidationWorkspace();
  const proposed = ChangeRequestSchema.parse({
    ...changeCase.value,
    change_id: "CHG-20261102T090000-b002",
    patch_path: "patches/CHG-20261102T090000-b002.patch",
  });
  const approved = ChangeRequestSchema.parse({
    ...changeCase.value,
    files_changed: ["Makefile", "src/Model/rhs.cpp"],
    semantic_level: "numerical_implementation",
    semantic_floor: "numerical_implementation",
    floor_categories: ["pure_engineering", "numerical_implementation"],
    risk: "high",
    status: "approved",
    approval_ref: "call-change-submit-533",
    approved_at: "2026-11-02T09:02:00Z",
  });
  const base = BuildRecordSchema.parse({
    ...buildCase.value,
    build_id: verificationCase.value.base_build_id,
    change_id: null,
    patch_sha256: null,
    dirty_paths: [],
    make_argv: ["make", "shud", "SUNDIALS_DIR=/opt/sundials"],
    binary_path: "builds/BUILD-20261102T090000-f6a7/shud",
    stdout_path: "builds/BUILD-20261102T090000-f6a7/make.stdout.log",
    stderr_path: "builds/BUILD-20261102T090000-f6a7/make.stderr.log",
  });
  const candidate = BuildRecordSchema.parse({
    ...buildCase.value,
    rhs_openmp: true,
    make_argv: ["make", "shud", "SUNDIALS_DIR=/opt/sundials", "SHUD_ENABLE_OPENMP_RHS=1"],
    compiler: "clang 19.0.0",
    binary_sha256: "2222222222222222222222222222222222222222222222222222222222222222",
  });
  const failed = VerificationCaseSchema.parse({
    ...verificationCase.value,
    status: "failed",
    observed: {
      ...verificationCase.value.observed,
      candidate_sha256: "3333333333333333333333333333333333333333333333333333333333333333",
    },
    failure_reason: "The candidate SHA256 differs from the serial baseline.",
    compatibility_verdict: "incompatible",
    reviewer_notes: ["The hashes differ at N=1.", "No parallel-correctness conclusion follows."],
  });
  const passed = VerificationCaseSchema.parse({
    ...verificationCase.value,
    vc_id: "VC-20261102T090000-a001",
    reviewer_notes: ["The hashes match at N=1.", "No performance measurement was made."],
  });
  // Deliberately no TaskCard, patch or build artifacts: rendering is not closure evaluation.
  const report = {
    ...workspace.fixture.report,
    change_ids: [proposed.change_id, approved.change_id],
    verification_ids: [failed.vc_id, passed.vc_id],
  };
  workspace.fixture.stacks[0].build_id = base.build_id;
  workspace.fixture.stacks[1].build_id = candidate.build_id;
  const changes = [proposed, approved];
  const verifications = [failed, passed];
  const builds = [base, candidate];
  const facts = [
    ...changes.map((value) => ({
      kind: "change" as const,
      id: value.change_id,
      path: `changes/${value.change_id}.json`,
      value,
    })),
    ...verifications.map((value) => ({
      kind: "verification" as const,
      id: value.vc_id,
      path: `verifications/${value.vc_id}.json`,
      value,
    })),
    ...builds.map((value) => ({
      kind: "build" as const,
      id: value.build_id,
      path: `builds/${value.build_id}/build-record.json`,
      value,
    })),
  ];
  function republish() {
    workspace.publishFixture();
    workspace.publish(workspace.reportPath, report);
    for (const fact of facts) workspace.publish(fact.path, fact.value);
  }
  republish();
  return { ...workspace, report, changes, verifications, builds, facts, republish };
}

/** Snapshot real files and namespace without traversing symlinks or opening special targets. */
export function snapshotTree(root: string) {
  return realFs
    .readdirSync(root, { recursive: true, encoding: "utf8" })
    .sort()
    .map((relative) => {
      const path = join(root, relative);
      const stat = realFs.lstatSync(path, { bigint: true });
      return {
        relative,
        mode: stat.mode,
        ino: stat.ino,
        mtime: stat.mtimeNs,
        bytes: stat.isFile() ? realFs.readFileSync(path) : null,
        link: stat.isSymbolicLink() ? realFs.readlinkSync(path) : null,
      };
    });
}

export function writeSentinel(workspace: CodeChangeWorkspace, relative: string, text: string) {
  const path = join(workspace.cwd, relative);
  realFs.mkdirSync(dirname(path), { recursive: true });
  realFs.writeFileSync(path, text);
}

/** Used only with the fixture's unique canonical headings, never to validate trusted origins. */
export function section(markdown: string, id: number): string {
  const start = markdown.indexOf(`\n## ${id}. `);
  if (start === -1) throw new Error(`Missing section ${id}`);
  const body = markdown.indexOf("\n\n", start) + 2;
  const next = markdown.indexOf(`\n## ${id + 1}. `, body);
  return markdown.slice(body, next === -1 ? undefined : next).trimEnd();
}
