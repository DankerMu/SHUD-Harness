import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CATALOG_IDS,
  CATALOG_V1,
  FLOOR_V1,
  INGESTION_LIMITS,
  OBSERVER_LIMITS,
  OWNERSHIP_V1,
  REJECTION_CODES,
  TOOLCHAIN
} from "../lib/frozen";
import { validateContract, validateDependencyCatalog } from "../lib/schema";

const root = join(import.meta.dir, "..");

function clone<T>(value: T): T {
  return structuredClone(value);
}

async function contract(): Promise<Record<string, any>> {
  return JSON.parse(await readFile(join(root, "contract-v1.json"), "utf8"));
}

describe("frozen catalog v1 contract", () => {
  test("contains the independently enumerated exact 174 mandatory IDs and outcomes", () => {
    const counts = { BAS: 6, STG: 12, UNT: 9, ATR: 5, CFG: 21, IDX: 20, LAY: 4, NES: 13, CAP: 17, HLP: 17, PRT: 12, LIM: 26, LIF: 8, DET: 4 };
    const expectedIds = Object.entries(counts).flatMap(([prefix, count]) =>
      Array.from({ length: count }, (_, index) => `${prefix}-${String(index + 1).padStart(3, "0")}`)
    );
    expect(CATALOG_IDS).toEqual(expectedIds);
    expect(CATALOG_V1).toHaveLength(174);
    expect(new Set(CATALOG_V1.map((row) => row.id)).size).toBe(174);
    expect(CATALOG_V1.find((row) => row.id === "BAS-001")?.macos_expected).toEqual({ kind: "clean" });
    expect(CATALOG_V1.find((row) => row.id === "STG-012")?.linux_expected).toEqual({ kind: "dirty" });
    expect(CATALOG_V1.find((row) => row.id === "CFG-018")?.macos_expected).toEqual({ kind: "rejected", code: "CONFIG_BOOLEAN_INVALID" });
    expect(CATALOG_V1.find((row) => row.id === "LIM-026")?.linux_expected).toEqual({ kind: "rejected", code: "LIMIT_OUTPUT_BYTES" });
    for (const row of CATALOG_V1) {
      expect(row.macos_expected).toEqual(row.linux_expected);
      expect(Object.keys(row).sort()).toEqual(["id", "linux_expected", "macos_expected"]);
    }
  });

  test("freezes the exact 25-floor bijection and exact independent owners", () => {
    const floorRows = [
      "IDX-012", "IDX-013", "IDX-014", "IDX-015", "NES-008", "NES-009", "NES-010", "NES-011", "NES-012", "NES-013",
      "IDX-016", "IDX-017", "IDX-018", "IDX-019", "IDX-020", "HLP-008", "HLP-009", "HLP-010", "HLP-011", "HLP-012",
      "HLP-013", "HLP-014", "HLP-015", "HLP-016", "HLP-017"
    ];
    expect(FLOOR_V1.map((item) => item.floor_id)).toEqual(Array.from({ length: 25 }, (_, index) => `F132-${String(index + 1).padStart(2, "0")}`));
    expect(FLOOR_V1.map((item) => item.row_id)).toEqual(floorRows);
    expect(new Set(FLOOR_V1.map((item) => item.row_id)).size).toBe(25);
    expect(OWNERSHIP_V1).toHaveLength(174);
    expect(new Set(OWNERSHIP_V1.map((item) => item.row_id))).toEqual(new Set(CATALOG_IDS));
    const partitionCounts = new Map<string, number>();
    for (const owner of OWNERSHIP_V1) partitionCounts.set(`${owner.fixture_owner}/${owner.native_owner}`, (partitionCounts.get(`${owner.fixture_owner}/${owner.native_owner}`) ?? 0) + 1);
    expect(Object.fromEntries(partitionCounts)).toEqual({ "2.1/4.2": 21, "2.2/4.3": 32, "2.3/4.4": 20, "2.3/4.5": 14, "2.3/4.6": 3, "2.4/4.6": 46, "2.5/4.7": 38 });
  });

  test("freezes four state layers, all limits, stable codes, and tool versions", async () => {
    const value = await contract();
    expect(validateContract(value)).toBe(true);
    expect(value.state_model).toEqual({
      observer_outcome: ["clean", "dirty", "rejected(code)"], expected_platforms: ["macos", "linux"], row_verdict: ["pass", "fail"],
      run_status: ["valid_complete", "invalid"], terminal_decision: ["accepted", "rejected"],
      terminal_decision_rule: "present_if_and_only_if_run_status_valid_complete"
    });
    expect(value.ingestion_limits).toEqual(INGESTION_LIMITS);
    expect(value.observer_limits).toEqual(OBSERVER_LIMITS);
    expect(value.toolchain).toEqual(TOOLCHAIN);
    expect(value.rejection_codes).toEqual(REJECTION_CODES);
    expect(value.source_input_digest_v1.domain_prefix).toBe("SHUD-HARNESS\0GIT-STATUS-CAPABILITY\0SOURCE-INPUT-DIGEST\0V1\0");
    expect(Object.values(value.schemas).every((schema: any) => schema.additional_properties === false)).toBe(true);
  });

  test("fails closed for missing, extra, duplicate, future, skipped, or platform-conditional catalog rows", async () => {
    const valid = await contract();
    const mutations = [
      (value: any) => value.catalog.pop(),
      (value: any) => value.catalog.push({ id: "FUT-001", macos_expected: { kind: "clean" }, linux_expected: { kind: "clean" } }),
      (value: any) => value.catalog.push(clone(value.catalog[0])),
      (value: any) => value.catalog[0].skip = true,
      (value: any) => value.catalog[0].platform = "macos",
      (value: any) => value.catalog[0].optional = true
    ];
    for (const mutate of mutations) {
      const changed = clone(valid);
      mutate(changed);
      expect(validateContract(changed)).toBe(false);
    }
  });

  test("fails closed for floor merge/gap/owner drift and ownership overlap/gap", async () => {
    const valid = await contract();
    const mutations = [
      (value: any) => value.floor_crosswalk.pop(),
      (value: any) => value.floor_crosswalk[1].row_id = value.floor_crosswalk[0].row_id,
      (value: any) => value.floor_crosswalk[0].fixture_owner = "2.4",
      (value: any) => value.ownership.pop(),
      (value: any) => value.ownership.push(clone(value.ownership[0])),
      (value: any) => value.ownership[0].native_owner = "4.7"
    ];
    for (const mutate of mutations) {
      const changed = clone(valid);
      mutate(changed);
      expect(validateContract(changed)).toBe(false);
    }
  });

  test("strict schemas reject missing and unknown fields", async () => {
    const valid = await contract();
    const missing = clone(valid);
    delete missing.state_model;
    const unknown = clone(valid);
    unknown.future = true;
    const nestedUnknown = clone(valid);
    nestedUnknown.catalog[0].skip = false;
    expect(validateContract(missing)).toBe(false);
    expect(validateContract(unknown)).toBe(false);
    expect(validateContract(nestedUnknown)).toBe(false);
  });
});

describe("frozen dependency graph contract", () => {
  test("binds exact direct crates, target graphs, and graph digests", async () => {
    const value = JSON.parse(await readFile(join(root, "..", "dependency-graph-catalog.json"), "utf8"));
    expect(validateDependencyCatalog(value)).toBe(true);
    expect(value.direct_dependencies.map((item: any) => [item.name, item.version, item.features])).toEqual([
      ["cap-std", "4.0.2", []], ["gix-index", "0.54.0", ["sha1"]], ["gix-status", "0.33.0", ["sha1", "worktree-rewrites"]]
    ]);
    expect(Object.keys(value.target_graphs)).toEqual(["aarch64-apple-darwin", "x86_64-unknown-linux-gnu"]);
  });

  test("rejects floating, path, Git, wildcard, feature, predicate, edge, and digest drift", async () => {
    const valid = JSON.parse(await readFile(join(root, "..", "dependency-graph-catalog.json"), "utf8"));
    const mutations = [
      (value: any) => value.direct_dependencies[0].version = "*",
      (value: any) => value.direct_dependencies[0].source = "git+https://example.invalid/repo",
      (value: any) => value.direct_dependencies[0].source = "path+../crate",
      (value: any) => value.direct_dependencies[1].features.push("serde"),
      (value: any) => value.target_graphs["aarch64-apple-darwin"].allowed_target_predicates.push("cfg(future)"),
      (value: any) => value.target_graphs["aarch64-apple-darwin"].edges.pop(),
      (value: any) => value.target_graphs["x86_64-unknown-linux-gnu"].graph_digest = "0".repeat(64)
    ];
    for (const mutate of mutations) {
      const changed = clone(valid);
      mutate(changed);
      expect(validateDependencyCatalog(changed)).toBe(false);
    }
  });

  test("rejects self-rehashed package, edge, and predicate drift for both frozen targets", async () => {
    const valid = JSON.parse(await readFile(join(root, "..", "dependency-graph-catalog.json"), "utf8"));
    const rehash = (graph: any) => {
      graph.graph_digest = createHash("sha256").update(JSON.stringify({ packages: graph.packages, edges: graph.edges })).digest("hex");
    };
    for (const target of ["aarch64-apple-darwin", "x86_64-unknown-linux-gnu"]) {
      const mutations: Array<(graph: any) => void> = [
        (graph) => { graph.packages = []; graph.edges = []; graph.allowed_target_predicates = []; },
        (graph) => { graph.packages.pop(); },
        (graph) => { graph.edges.pop(); },
        (graph) => { graph.edges.push(graph.edges[0]); },
        (graph) => { graph.allowed_target_predicates[0] = "cfg(future)"; }
      ];
      for (const mutate of mutations) {
        const changed = clone(valid);
        const graph = changed.target_graphs[target];
        mutate(graph);
        rehash(graph);
        expect(validateDependencyCatalog(changed)).toBe(false);
      }
    }
  });
});
