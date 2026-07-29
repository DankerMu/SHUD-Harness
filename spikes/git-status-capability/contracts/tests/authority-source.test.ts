import { describe, expect, test } from "bun:test";
import {
  expectMutationRejected, expectSchemaFailure, expectSuccess, invoke, invokeAuthority, loadAuthority, withJson
} from "./authority-test-helpers";

const sourceCommand = [
  "spikes/git-status-capability/verify.sh", "source-input-digest", "--version", "1", "--source-sha", "<SOURCE_SHA>",
  "--manifest", "spikes/git-status-capability/contracts/source-input-v1.paths", "--primary", "source-input-primary-v1",
  "--witness", "source-input-witness-v1", "--record", "<EXTERNAL_EVIDENCE_ROOT>/source-input-record.json", "--create"
];

function strictSourceRecord(record: any): any {
  record.admitted_modes = record.admitted_paths.map(() => "100644");
  record.primary_result = {
    status: "ok", source_input_digest_matches: true, manifest_digest_matches: true,
    entry_count_matches: true, admitted_set_matches: true
  };
  record.witness_result = structuredClone(record.primary_result);
  record.command_receipt = { argv: sourceCommand, version: "1", exit_code: 0 };
  return record;
}

const setPeers = [
  (value: any, changed: string) => { value.source_record.source_sha = changed; },
  (value: any, changed: string) => { value.platforms.macos.source_commit = changed; },
  (value: any, changed: string) => { value.platforms.linux.source_commit = changed; },
  (value: any, changed: string) => { value.decision.base_sha = changed; }
];

describe("cross-record source authority", () => {
  test("rejects every independent and synchronized strict-subset source identity forgery", async () => {
    const changed = "b".repeat(40);
    for (let mask = 1; mask < (1 << setPeers.length) - 1; mask += 1) {
      await expectMutationRejected((value) => {
        for (let index = 0; index < setPeers.length; index += 1) {
          if ((mask & (1 << index)) !== 0) setPeers[index]!(value, changed);
        }
      });
    }
  });

  test("rejects unknown, missing, and unsafe source authority fields", async () => {
    const mutations: Array<(value: any) => void> = [
      (value) => { delete value.source_record.source_sha; },
      (value) => { value.source_record.unknown = true; },
      (value) => { value.source_record.admitted_paths[0] = "../escape"; },
      (value) => { value.source_record.entry_count = 1; },
      (value) => { delete value.platforms.linux; },
      (value) => { value.platforms.macos.unknown = true; },
      (value) => { value.decision.unknown = true; },
      (value) => { value.unknown = true; }
    ];
    for (const mutate of mutations) await expectMutationRejected(mutate);
  });

  test("standalone and nested routes share one exact source-record contract", async () => {
    const authority = await loadAuthority();
    strictSourceRecord(authority.source_record);
    await withJson(authority.source_record, async (path) => {
      expectSuccess(await invoke(["--input", path, "--kind", "source_input_record"]), "source_input_record");
    });
    await withJson(authority, async (path) => expectSuccess(await invokeAuthority(path), "authority_set"));

    const mutations: Array<(record: any) => void> = [
      (record) => { record.primary_encoder = "forged-primary"; },
      (record) => { record.witness_encoder = "forged-witness"; },
      (record) => { record.primary_result.status = "failed"; },
      (record) => { record.witness_result.source_input_digest_matches = false; },
      (record) => { record.primary_result.manifest_digest_matches = false; },
      (record) => { record.witness_result.entry_count_matches = false; },
      (record) => { record.primary_result.admitted_set_matches = false; },
      (record) => { record.source_input_digest = "not-a-digest"; },
      (record) => { record.manifest_digest = "not-a-digest"; },
      (record) => { record.entry_count += 1; },
      (record) => { record.admitted_paths[0] = "../escape"; },
      (record) => { record.admitted_modes[0] = "100600"; },
      (record) => { record.admitted_modes.pop(); },
      (record) => { record.admitted_paths.reverse(); record.admitted_modes.reverse(); },
      (record) => { record.command_receipt.argv[1] = "forged-command"; },
      (record) => { record.command_receipt.version = "2"; },
      (record) => { record.command_receipt.exit_code = 1; },
      (record) => { record.command_receipt.extra = true; },
      (record) => { record.source_input_record_sha256 = "0".repeat(64); }
    ];
    for (const mutate of mutations) {
      const standalone = structuredClone(authority.source_record);
      mutate(standalone);
      await withJson(standalone, async (path) => expectSchemaFailure(await invoke(["--input", path, "--kind", "source_input_record"])));

      const nested = structuredClone(authority);
      mutate(nested.source_record);
      await withJson(nested, async (path) => expectSchemaFailure(await invokeAuthority(path)));
    }
  });

  test("the admitted path and mode pairs are sorted by raw UTF-8 path bytes", async () => {
    const authority = await loadAuthority();
    strictSourceRecord(authority.source_record);
    authority.source_record.admitted_paths = ["z.txt", "é.txt", "😀.txt"];
    authority.source_record.admitted_modes = ["100644", "100755", "100644"];
    authority.source_record.entry_count = 3;
    const expected = [...authority.source_record.admitted_paths].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
    expect(expected).toEqual(["z.txt", "é.txt", "😀.txt"]);
    await withJson(authority.source_record, async (path) => {
      expectSuccess(await invoke(["--input", path, "--kind", "source_input_record"]), "source_input_record");
    });
  });
});
