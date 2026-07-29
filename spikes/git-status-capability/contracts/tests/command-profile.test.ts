import { describe, test } from "bun:test";
import { expectMutationRejected } from "./authority-test-helpers";

describe("exact ordered 17-gate command profile", () => {
  test("rejects missing, extra, duplicate, reordered gates and every ordinal mutation", async () => {
    const structural: Array<(value: any) => void> = [
      (value) => { value.command_profile.pop(); },
      (value) => { value.command_profile.push(structuredClone(value.command_profile[0])); },
      (value) => { value.command_profile.push({ id: "GATE-EXTRA", ordinal: 18, stages: [] }); },
      (value) => { [value.command_profile[0], value.command_profile[1]] = [value.command_profile[1], value.command_profile[0]]; }
    ];
    for (const mutate of structural) await expectMutationRejected(mutate);
    for (let index = 0; index < 17; index += 1) {
      await expectMutationRejected((value) => { value.command_profile[index].ordinal += 1; });
    }
  });

  test("rejects stage omission/addition and every argv/tool/version/environment mutation", async () => {
    for (let gateIndex = 0; gateIndex < 17; gateIndex += 1) {
      await expectMutationRejected((value) => { value.command_profile[gateIndex].stages.pop(); });
      await expectMutationRejected((value) => { value.command_profile[gateIndex].stages.push(structuredClone(value.command_profile[gateIndex].stages[0])); });
      const stageCount = gateIndex === 12 ? 2 : 1;
      for (let stageIndex = 0; stageIndex < stageCount; stageIndex += 1) {
        await expectMutationRejected((value) => { value.command_profile[gateIndex].stages[stageIndex].argv[0] += "-forged"; });
        await expectMutationRejected((value) => { value.command_profile[gateIndex].stages[stageIndex].tool += "-forged"; });
        await expectMutationRejected((value) => { value.command_profile[gateIndex].stages[stageIndex].version += "-forged"; });
        await expectMutationRejected((value) => { value.command_profile[gateIndex].stages[stageIndex].environment.reverse(); });
      }
    }
  });

  test("freezes GATE-UNTRACKED as one gate with exactly two ordered stages", async () => {
    await expectMutationRejected((value) => { value.command_profile[12].stages.shift(); });
    await expectMutationRejected((value) => { value.command_profile[12].stages.reverse(); });
    await expectMutationRejected((value) => { value.command_profile[12].stages[1].argv.push("extra"); });
    await expectMutationRejected((value) => { value.command_profile[12].stages[1].version = "2"; });
  });
});
