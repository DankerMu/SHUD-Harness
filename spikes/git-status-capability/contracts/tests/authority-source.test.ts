import { describe, test } from "bun:test";
import { expectMutationRejected } from "./authority-test-helpers";

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
});
