import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCheck } from "../lib/checker";
import { CATALOG_V1, FLOOR_V1 } from "../lib/frozen";
import {
  enumerateSourceCandidates,
  validateContract,
  validateDependencyCatalog,
  validateDecision,
  validateFinalBundle,
  validatePlatformBundle,
  validateRowEvidence,
  validateSourceInputRecord,
  validateSupplyFiles
} from "../lib/schema";
import { materialFrame } from "./frame-fixture";

const contractRoot = join(import.meta.dir, "..");
const repositoryRoot = join(contractRoot, "..", "..", "..");
const shaA = "01".repeat(32);
const shaB = "ab".repeat(32);

function outcome(text: string): Record<string, string> {
  const rejected = /^rejected\(([^)]+)\)$/.exec(text);
  return rejected ? { kind: "rejected", code: rejected[1]! } : { kind: text };
}

async function oracleTables(): Promise<{ rows: Map<string, string>; floors: string[][] }> {
  const design = await readFile(join(repositoryRoot, "openspec/changes/m2-capability-observer-spike/design.md"), "utf8");
  const rows = new Map<string, string>();
  const floors: string[][] = [];
  for (const line of design.split("\n")) {
    const row = /^\| `((?:BAS|STG|UNT|ATR|CFG|IDX|LAY|NES|CAP|HLP|PRT|LIM|LIF|DET)-\d{3})` \|.*\| `([^`]+)` \| `([^`]+)` \|$/.exec(line);
    if (row) {
      expect(row[2]).toBe(row[3]);
      rows.set(row[1]!, row[2]!);
    }
    const floor = /^\| `F132-(\d{2})`.*\| `([^`]+)` \| ([0-9.]+) \/ ([0-9.]+) \| (.*) \|$/.exec(line);
    if (floor) floors.push([`F132-${floor[1]}`, floor[2]!, floor[3]!, floor[4]!, floor[5]!.replaceAll("`", "")]);
  }
  return { rows, floors };
}

function validRow(): Record<string, unknown> {
  return {
    schema_version: "shud.git-status-capability.row-evidence.v1", platform: "macos", row_id: "BAS-001",
    observation_id: shaA, checkout_capability_identity: shaB, git_state_generation_digest: shaA, frame_digest: shaB,
    frame_binding: {
      row_id: "BAS-001", observation_id: shaA, checkout_capability_identity: shaB, git_state_generation_digest: shaA,
      frame_length: 1024, frame_digest: shaB, payload_length: 768, payload_digest: shaA
    },
    expected_outcome: { kind: "clean" }, observer_outcome: { kind: "clean" }, producing_boundary: "observer",
    row_verdict: "pass", oracle_digest: shaA, oracle_verdict: "pass",
    tripwire_verdicts: { ambient_path: true, subprocess: true, protected_write: true }, protection_set_equal: true,
    cleanup: { verdict: "pass", descriptors_restored: true, processes_reaped: true, secondary_errors: [] },
    resource_record: { boundary_class: "below", declared_limit: "none", within_limits: true },
    source_input_record_sha256: shaB
  };
}

function admittedPaths() {
  return [{ path: "a.txt", git_mode: "100644" }, { path: "bin/run", git_mode: "100755" }];
}

function encoder(identity: string) {
  return { identity, result: { source_input_digest: shaA, manifest_digest: shaB, entry_count: 2, admitted_paths: admittedPaths() } };
}

function validSourceRecord(): Record<string, unknown> {
  return {
    schema_version: "shud.git-status-capability.source-input-record.v1", source_sha: "01".repeat(20),
    source_input_digest: shaA, manifest_digest: shaB, entry_count: 2, admitted_paths: admittedPaths(),
    primary_encoder: encoder("source-input-primary-v1"), witness_encoder: encoder("source-input-witness-v1"),
    command_receipt: {
      argv: [
        "spikes/git-status-capability/verify.sh", "source-input-digest", "--version", "1", "--source-sha", "01".repeat(20),
        "--manifest", "spikes/git-status-capability/contracts/source-input-v1.paths", "--primary", "source-input-primary-v1",
        "--witness", "source-input-witness-v1", "--record", "/external-evidence-root/source-input-record.json", "--create"
      ],
      version: "1", exit_code: 0
    }
  };
}

function validFrame(): Record<string, unknown> {
  return materialFrame();
}

describe("round-1 invariant closure", () => {
  test("exhaustively binds all 174 outcomes to the reviewed OpenSpec table", async () => {
    const oracle = await oracleTables();
    expect(oracle.rows.size).toBe(174);
    expect(CATALOG_V1).toHaveLength(174);
    for (const row of CATALOG_V1) {
      expect(row.macos_expected).toEqual(outcome(oracle.rows.get(row.id)!));
      expect(row.linux_expected).toEqual(outcome(oracle.rows.get(row.id)!));
    }
  });

  test("exhaustively binds all 25 floor oracle/owner tuples to OpenSpec", async () => {
    const oracle = await oracleTables();
    expect(oracle.floors).toHaveLength(25);
    expect(FLOOR_V1.map((item) => [item.floor_id, item.row_id, item.fixture_owner, item.native_owner, item.oracle])).toEqual(oracle.floors);
  });

  test("row evidence binds its frozen platform slot, replay identities, and verdict iff", () => {
    expect(validateRowEvidence(validRow())).toBe(true);
    for (const mutate of [
      (row: any) => { row.expected_outcome = { kind: "dirty" }; },
      (row: any) => { row.row_verdict = "fail"; },
      (row: any) => { delete row.observation_id; },
      (row: any) => { row.oracle_verdict = "fail"; },
      (row: any) => { row.tripwire_verdicts = {}; },
      (row: any) => { row.frame_digest = "short"; },
      (row: any) => { delete row.frame_binding.payload_length; },
      (row: any) => { row.frame_binding.observation_id = shaB; },
      (row: any) => { row.frame_binding.frame_digest = shaA; },
      (row: any) => { row.frame_binding.payload_digest = "short"; },
      (row: any) => { row.frame_binding.payload_length = row.frame_binding.frame_length + 1; }
    ]) {
      const row = structuredClone(validRow()); mutate(row); expect(validateRowEvidence(row)).toBe(false);
    }
  });

  test("schema public CLI accepts one strict generation-bound frame and rejects nested drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "shud-frame-schema-"));
    try {
      const cases: Array<[boolean, (frame: any) => void]> = [
        [true, () => {}],
        [false, (frame) => { delete frame.index.shared_index; }],
        [false, (frame) => { frame.index.future = true; }],
        [false, (frame) => { frame.index.entry_count = "2"; }],
        [false, (frame) => { frame.head_tree = "01".repeat(20); }],
        [false, (frame) => { frame.effective_config.entries[0].origin = "/absolute/config"; }],
        [false, (frame) => { frame.nested_state[0].gitlink.stage = 5; }]
      ];
      for (let index = 0; index < cases.length; index += 1) {
        const [expectedValid, mutate] = cases[index]!;
        const frame = structuredClone(validFrame()); mutate(frame);
        const path = join(root, `${index}.json`); await writeFile(path, JSON.stringify(frame));
        let stdout = ""; let stderr = "";
        const exit = await runCheck(["--input", path, "--kind", "schema"], { stdout: (chunk) => stdout += chunk, stderr: (chunk) => stderr += chunk });
        expect(exit).toBe(expectedValid ? 0 : 2);
        expect(expectedValid ? stderr : stdout).toBe("");
        if (!expectedValid) expect(JSON.parse(stderr).code).toBe("CONTRACT_SCHEMA_INVALID");
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("source record binds path/mode sets, two independent equal results, and exact receipt", () => {
    expect(validateSourceInputRecord(validSourceRecord())).toBe(true);
    for (const mutate of [
      (record: any) => { record.admitted_paths[0].git_mode = "100600"; },
      (record: any) => { record.witness_encoder.result.source_input_digest = shaB; },
      (record: any) => { record.witness_encoder.identity = record.primary_encoder.identity; },
      (record: any) => { record.command_receipt = {}; },
      (record: any) => { record.command_receipt.argv[12] = "--verify-record"; },
      (record: any) => { record.command_receipt.argv[14] = "--no-write"; },
      (record: any) => { record.command_receipt.argv.splice(8, 2); },
      (record: any) => { record.command_receipt.version = "opaque"; },
      (record: any) => { record.command_receipt.exit_code = 1; }
    ]) {
      const record = structuredClone(validSourceRecord()); mutate(record); expect(validateSourceInputRecord(record)).toBe(false);
    }
  });

  test("complete bundle cardinalities and cross-slot identities are closed while invalid has no decision", async () => {
    const generic = JSON.parse(await readFile(join(contractRoot, "fixtures/valid/generic.json"), "utf8"));
    expect(validatePlatformBundle(generic.platform_bundle)).toBe(true);
    expect(validateFinalBundle(generic.final_bundle)).toBe(true);
    expect(validateDecision(generic.decision)).toBe(true);
    for (const mutate of [
      (bundle: any) => { bundle.rows[0].platform = "linux"; },
      (bundle: any) => { bundle.rows[0].source_input_record_sha256 = shaA; },
      (bundle: any) => { bundle.rows[1].observation_id = bundle.rows[0].observation_id; },
      (bundle: any) => { bundle.rows[1].frame_digest = bundle.rows[0].frame_digest; },
      (bundle: any) => { bundle.rows[0].frame_binding.payload_digest = "short"; }
    ]) {
      const bundle = structuredClone(generic.platform_bundle); mutate(bundle); expect(validatePlatformBundle(bundle)).toBe(false);
    }
    const invalidPlatform = structuredClone(generic.platform_bundle);
    invalidPlatform.run_status = "invalid"; invalidPlatform.rows = []; invalidPlatform.first_cause = "EVIDENCE_MISSING"; invalidPlatform.all_failure_codes = ["EVIDENCE_MISSING"];
    expect(validatePlatformBundle(invalidPlatform)).toBe(true);
    const invalidFinal = structuredClone(generic.final_bundle);
    invalidFinal.run_status = "invalid"; delete invalidFinal.terminal_decision; invalidFinal.first_cause = "PLATFORM_MISSING"; invalidFinal.all_failure_codes = ["PLATFORM_MISSING"];
    expect(validateFinalBundle(invalidFinal)).toBe(true);
    for (const mutate of [
      (bundle: any) => { delete bundle.repository_gates["GATE-SOURCE-INPUT"]; },
      (bundle: any) => { bundle.repository_gates["GATE-SOURCE-INPUT"].argv[12] = "--record"; },
      (bundle: any) => { bundle.repository_gates["GATE-SOURCE-INPUT"].argv[14] = "--create"; },
      (bundle: any) => { bundle.repository_gates["GATE-SOURCE-INPUT"].tool_version = "opaque"; },
      (bundle: any) => { bundle.repository_gates["GATE-SOURCE-INPUT"].exit_code = 1; }
    ]) {
      const bundle = structuredClone(generic.final_bundle); mutate(bundle); expect(validateFinalBundle(bundle)).toBe(false);
    }
    const duplicateSlot = structuredClone(generic.decision); duplicateSlot.rows[1] = duplicateSlot.rows[0];
    expect(validateDecision(duplicateSlot)).toBe(false);
  });

  test("raw __proto__ remains an own key and fails every strict public schema", async () => {
    const root = await mkdtemp(join(tmpdir(), "shud-proto-"));
    try {
      const generic = JSON.parse(await readFile(join(contractRoot, "fixtures/valid/generic.json"), "utf8"));
      const values: Record<string, unknown> = {
        catalog: JSON.parse(await readFile(join(contractRoot, "contract-v1.json"), "utf8")),
        dependency_graph: JSON.parse(await readFile(join(contractRoot, "../dependency-graph-catalog.json"), "utf8")),
        schema: generic.schema, source_input_record: generic.source_input_record, row_evidence: generic.row_evidence,
        platform_bundle: generic.platform_bundle, final_bundle: generic.final_bundle, decision: generic.decision
      };
      for (const [kind, value] of Object.entries(values)) {
        const text = JSON.stringify(value).replace(/}$/, ',"__proto__":{"polluted":true}}');
        const inputPath = join(root, `${kind}.json`); await writeFile(inputPath, text);
        let stdout = ""; let stderr = "";
        const exit = await runCheck(["--input", inputPath, "--kind", kind as any], { stdout: (chunk) => stdout += chunk, stderr: (chunk) => stderr += chunk });
        expect(exit).toBe(2); expect(stdout).toBe(""); expect(JSON.parse(stderr).code).toBe("CONTRACT_SCHEMA_INVALID");
      }
      expect(({} as any).polluted).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("source candidates include spike evidence names and conditionally include the workflow", async () => {
    const root = await mkdtemp(join(tmpdir(), "shud-candidates-"));
    try {
      await cp(join(repositoryRoot, "spikes"), join(root, "spikes"), { recursive: true });
      await cp(join(repositoryRoot, "openspec"), join(root, "openspec"), { recursive: true });
      await writeFile(join(root, "spikes/git-status-capability/contracts/evidence/source.ts"), "source\n", { flag: "w" }).catch(async () => {
        const { mkdir } = await import("node:fs/promises"); await mkdir(join(root, "spikes/git-status-capability/contracts/evidence"), { recursive: true });
        await writeFile(join(root, "spikes/git-status-capability/contracts/evidence/source.ts"), "source\n");
      });
      let paths = await enumerateSourceCandidates(root);
      expect(paths).toContain("spikes/git-status-capability/contracts/evidence/source.ts");
      expect(paths).not.toContain(".github/workflows/git-status-capability-spike.yml");
      const { mkdir } = await import("node:fs/promises"); await mkdir(join(root, ".github/workflows"), { recursive: true });
      await writeFile(join(root, ".github/workflows/git-status-capability-spike.yml"), "name: spike\n");
      paths = await enumerateSourceCandidates(root);
      expect(paths).toContain(".github/workflows/git-status-capability-spike.yml");
      expect(paths.some((path) => path.startsWith("openspec/changes/m2-capability-observer-spike/evidence/"))).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("source digest descriptor is exact and supply graph carries activated features", async () => {
    const contract = JSON.parse(await readFile(join(contractRoot, "contract-v1.json"), "utf8"));
    for (const field of ["frame_fields", "synthetic_literal_path", "domain_prefix", "entry_order"]) {
      const changed = structuredClone(contract); changed.source_input_digest_v1[field] = field === "frame_fields" ? [] : "drift";
      expect(validateContract(changed)).toBe(false);
    }
    const graph = JSON.parse(await readFile(join(contractRoot, "..", "dependency-graph-catalog.json"), "utf8"));
    expect(validateDependencyCatalog(graph)).toBe(true);
    for (const target of Object.values(graph.target_graphs) as any[]) {
      expect(target.activated_features.length).toBe(target.packages.length);
      expect(target.activated_features.every((item: any) => typeof item.package === "string" && Array.isArray(item.features))).toBe(true);
    }
    const changed = structuredClone(graph); changed.target_graphs["aarch64-apple-darwin"].activated_features[0].features.push("drift");
    const changedTarget = changed.target_graphs["aarch64-apple-darwin"];
    changedTarget.graph_digest = createHash("sha256").update(JSON.stringify({ packages: changedTarget.packages, edges: changedTarget.edges, activated_features: changedTarget.activated_features })).digest("hex");
    expect(validateDependencyCatalog(changed)).toBe(false);
  });

  test("Cargo manifest is exact and rejects extra tables or dependency drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "shud-supply-"));
    try {
      await cp(join(contractRoot, ".."), root, { recursive: true });
      await expect(validateSupplyFiles(root)).resolves.toBeUndefined();
      for (const suffix of ["\n[features]\ndefault = []\n", "\n[dependencies.serde]\nversion = \"=1.0.0\"\n"]) {
        const cargo = join(root, "native/Cargo.toml"); const original = await readFile(cargo, "utf8"); await writeFile(cargo, original + suffix);
        await expect(validateSupplyFiles(root)).rejects.toMatchObject({ code: "CONTRACT_SCHEMA_INVALID" }); await writeFile(cargo, original);
      }
      const lockPath = join(root, "native/Cargo.lock");
      await writeFile(lockPath, `${await readFile(lockPath, "utf8")}\n# drift\n`);
      await expect(validateSupplyFiles(root)).rejects.toMatchObject({ code: "CONTRACT_SCHEMA_INVALID" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
