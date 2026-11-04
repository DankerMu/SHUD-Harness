import { dirname, join } from "node:path";
import { makeCodeChangeWorkspace } from "../report-code-change-test-harness.ts";
import { realFs } from "../report-validation-test-harness.ts";

// Published SHA-256 vectors, independent of the production descriptor hasher.
export const ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export function makeCodeChangeValidationWorkspace() {
  const workspace = makeCodeChangeWorkspace();
  for (const record of workspace.verifications) {
    record.artifact_refs = [
      `evidence/${record.vc_id}/base.bin`,
      `evidence/${record.vc_id}/candidate.bin`,
    ];
    record.observed.base_sha256 = ABC_SHA256;
    record.observed.candidate_sha256 = record.status === "failed" ? EMPTY_SHA256 : ABC_SHA256;
    for (const [index, relative] of record.artifact_refs.entries()) {
      const path = join(workspace.cwd, relative);
      realFs.mkdirSync(dirname(path), { recursive: true });
      realFs.writeFileSync(path, index === 1 && record.status === "failed" ? "" : "abc");
    }
  }
  workspace.republish();
  return workspace;
}
