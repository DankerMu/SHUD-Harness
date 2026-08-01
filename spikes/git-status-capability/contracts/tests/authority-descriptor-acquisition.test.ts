import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  RAW_ACQUISITION_MUTATIONS,
  expectedRawAcquisitionDenial,
  withCompiledRawAcquisitionMutation
} from "./authority-descriptor-acquisition-vocabulary";
import {
  structuralDescriptorGraphDenials,
  withCompiledProductionTree,
  type MutatedProductionTree
} from "./authority-descriptor-vocabulary";

async function runMissedOpenCounter(tree: MutatedProductionTree): Promise<Readonly<{
  baseline: number;
  afterOpen: number;
  afterClose: number;
  rawOpen: number;
  mediatedOpen: number;
}>> {
  const probePath = join(tree.root, "raw-acquisition-runtime-probe.ts");
  await writeFile(probePath, `
import { mock } from "bun:test";
import * as originalFs from "node:fs";
import { readdir } from "node:fs/promises";
const originalOpenSync = originalFs.openSync;
const descriptorDirectory = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";

async function descriptorCount(): Promise<number> {
  return (await readdir(descriptorDirectory)).length;
}
let rawOpen = 0;
mock.module("node:fs", () => ({
  ...originalFs,
  openSync(...args: Parameters<typeof originalFs.openSync>) {
    rawOpen += 1;
    return originalOpenSync(...args);
  }
}));
const capabilities = await import("./lib/capabilities");
let mediatedOpen = 0;
capabilities.installDescriptorPrimitiveMediator((operation, invoke) => {
  if (operation === "open_root") mediatedOpen += 1;
  return invoke();
});
const owner = new capabilities.ContractCapabilities();
Bun.gc(true);
const baseline = await descriptorCount();
const descriptor = owner.openRoot("/", "admission");
const afterOpen = await descriptorCount();
owner.close(descriptor, "unretained");
Bun.gc(true);
const afterClose = await descriptorCount();
console.log(JSON.stringify({ baseline, afterOpen, afterClose, rawOpen, mediatedOpen }));
`);
  const child = Bun.spawn([process.execPath, probePath], { stdout: "pipe", stderr: "pipe" });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ]);
  expect(exit).toBe(0);
  expect(stderr).toBe("");
  return JSON.parse(stdout) as Readonly<{
    baseline: number;
    afterOpen: number;
    afterClose: number;
    rawOpen: number;
    mediatedOpen: number;
  }>;
}

describe("closed raw acquisition graph", () => {
  test("the complete copied lib graph has one canonical raw acquisition route", async () => {
    await withCompiledProductionTree(undefined, async (tree) => {
      expect(await structuralDescriptorGraphDenials(tree)).toEqual([]);
    });
  });

  test("every import, loader, cache, resolver, and cross-lib raw acquisition mutation compiles red", async () => {
    for (const mutation of RAW_ACQUISITION_MUTATIONS) {
      await withCompiledRawAcquisitionMutation(mutation, async (tree) => {
        expect(await structuralDescriptorGraphDenials(tree)).toContain(expectedRawAcquisitionDenial(mutation));
      });
    }
  });

  test("a copied require loader leaks an independently observable raw fd while mediation sees one canonical receipt", async () => {
    await withCompiledRawAcquisitionMutation("acquisition_open_sync_require_loader", async (tree) => {
      expect(await structuralDescriptorGraphDenials(tree)).toContain("raw_open_root_not_handle");
      const receipt = await runMissedOpenCounter(tree);
      expect(receipt.rawOpen).toBe(1);
      expect(receipt.mediatedOpen).toBe(1);
      expect(receipt.afterOpen).toBe(receipt.baseline + 2);
      expect(receipt.afterClose).toBe(receipt.baseline + 1);
    });
  });
});
