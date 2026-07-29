import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "..", "..", "..", "..");
const designPath = join(repositoryRoot, "openspec", "changes", "m2-capability-observer-spike", "design.md");
const contractPath = join(import.meta.dir, "..", "contract-v1.json");

const SPEC_DERIVED_DIGESTS = {
  catalog: "749cc4480ed54bc6dac2d3115845c7646f363845a7031fe2831c9c0c2bdd2b5d",
  floor_crosswalk: "db9bbcf7d01779906c49519806fa0b7b50f6ef5393ddffb30a08b2036ce8fd14",
  ownership: "1f613d0a452695cd09294414480bb8f5c3fac4aea69ba12ac6d797752cc9b772",
  command_profile: "f7adf7c64b2a44e055e27fc62ba224388bf125b8fa49dad17adcd156e06b90c8"
} as const;

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function outcome(literal: string): Record<string, string> {
  if (literal === "clean" || literal === "dirty") return { kind: literal };
  const match = /^rejected\(([A-Z0-9_]+)\)$/.exec(literal);
  if (!match) throw new Error(`unrecognized design outcome: ${literal}`);
  return { kind: "rejected", code: match[1]! };
}

function parseCatalog(design: string): unknown[] {
  return [...design.matchAll(/^\| `([A-Z]{3}-\d{3})` \|[^\n]*?\| `([^`]+)` \| `([^`]+)` \|$/gm)].map((match) => ({
    id: match[1]!, macos_expected: outcome(match[2]!), linux_expected: outcome(match[3]!)
  }));
}

function parseFloors(design: string): unknown[] {
  return [...design.matchAll(/^\| `(F132-\d{2})`[^|]*\| `([A-Z]{3}-\d{3})` \| ([0-9.]+) \/ ([0-9.]+) \| (.+) \|$/gm)].map((match) => ({
    floor_id: match[1]!, row_id: match[2]!, fixture_owner: match[3]!, native_owner: match[4]!,
    oracle: match[5]!.replaceAll("`", "")
  }));
}

function expandRange(token: string): string[] {
  const range = /^([A-Z]{3})-(\d{3})\.\.(\d{3})$/.exec(token);
  if (!range) return [token];
  return Array.from({ length: Number(range[3]) - Number(range[2]) + 1 }, (_, index) =>
    `${range[1]}-${String(Number(range[2]) + index).padStart(3, "0")}`);
}

function parseOwnership(design: string, catalogIds: string[]): unknown[] {
  const owners = new Map<string, { fixture_owner: string; native_owner: string }>();
  for (const match of design.matchAll(/^\| ((?:`[^`]+`(?:, )?)+) \| ([0-9.]+) \| ([0-9.]+) \| \d+ \|$/gm)) {
    for (const token of [...match[1]!.matchAll(/`([^`]+)`/g)].map((item) => item[1]!)) {
      for (const id of expandRange(token)) owners.set(id, { fixture_owner: match[2]!, native_owner: match[3]! });
    }
  }
  return catalogIds.map((row_id) => ({ row_id, ...owners.get(row_id) }));
}

describe("independent complete design oracle", () => {
  test("covers every catalog outcome, floor mapping/owner, row owner, and all 17 gates", async () => {
    const design = await readFile(designPath, "utf8");
    const value = JSON.parse(await readFile(contractPath, "utf8"));
    const catalog = parseCatalog(design);
    const floors = parseFloors(design);
    const ownership = parseOwnership(design, catalog.map((row: any) => row.id));
    expect(catalog).toHaveLength(174);
    expect(floors).toHaveLength(25);
    expect(ownership).toHaveLength(174);
    expect(ownership.every((entry: any) => entry.fixture_owner && entry.native_owner)).toBe(true);
    expect(value.catalog).toEqual(catalog);
    expect(value.floor_crosswalk).toEqual(floors);
    expect(value.ownership).toEqual(ownership);
    expect(value.command_profile).toHaveLength(17);
    for (const key of Object.keys(SPEC_DERIVED_DIGESTS) as Array<keyof typeof SPEC_DERIVED_DIGESTS>) {
      expect(digest(value[key])).toBe(SPEC_DERIVED_DIGESTS[key]);
    }
  });

  test("the independent digests expose synchronized contract and implementation drift", async () => {
    const changed = JSON.parse(await readFile(contractPath, "utf8"));
    changed.catalog[0].macos_expected = { kind: "dirty" };
    changed.catalog[0].linux_expected = { kind: "dirty" };
    changed.floor_crosswalk[0].fixture_owner = "2.4";
    changed.ownership[0].fixture_owner = "2.4";
    changed.command_profile[0].stages[0].argv[0] = "forged";
    for (const key of Object.keys(SPEC_DERIVED_DIGESTS) as Array<keyof typeof SPEC_DERIVED_DIGESTS>) {
      expect(digest(changed[key])).not.toBe(SPEC_DERIVED_DIGESTS[key]);
    }
  });
});
