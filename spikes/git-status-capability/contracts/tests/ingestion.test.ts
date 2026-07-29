import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INGESTION_LIMITS, OBSERVER_LIMITS, CATALOG_V1 } from "../lib/frozen";
import {
  ContractError,
  ingestJson,
  ingestJsonAgainstLimits,
  type ContractErrorCode,
  type IngestionLimit,
  type InputKind
} from "../lib/ingestion";
import { runCheck } from "../lib/checker";
import { encodeSourceInputFrame } from "../lib/source-frame";

const fixtures = join(import.meta.dir, "..", "fixtures");
const kinds = Object.keys(INGESTION_LIMITS) as InputKind[];
const encoder = new TextEncoder();

const canonicalInputPaths: Partial<Record<InputKind, string>> = {
  catalog: join(import.meta.dir, "..", "contract-v1.json"),
  dependency_graph: join(import.meta.dir, "..", "..", "dependency-graph-catalog.json"),
  authority_set: join(fixtures, "valid", "authority-set-v1.json")
};

function checkArgs(path: string, kind: InputKind): string[] {
  const args = ["--input", path, "--kind", kind];
  if (kind === "authority_set") args.push("--repository-root", join(import.meta.dir, "..", "..", "..", ".."));
  return args;
}

async function validInput(kind: InputKind): Promise<Record<string, any>> {
  const canonical = canonicalInputPaths[kind];
  if (canonical) return JSON.parse(await readFile(canonical, "utf8"));
  const registry = JSON.parse(await readFile(join(fixtures, "valid", "generic.json"), "utf8"));
  return registry[kind];
}

function codeOf(run: () => unknown): ContractErrorCode | undefined {
  try { run(); } catch (error) { return error instanceof ContractError ? error.code : undefined; }
  return undefined;
}

function isolated(limit: IngestionLimit, field: keyof IngestionLimit): IngestionLimit {
  return {
    bytes: field === "bytes" ? limit.bytes : Number.MAX_SAFE_INTEGER,
    depth: field === "depth" ? limit.depth : Number.MAX_SAFE_INTEGER,
    nodes: field === "nodes" ? limit.nodes : Number.MAX_SAFE_INTEGER,
    items: field === "items" ? limit.items : Number.MAX_SAFE_INTEGER
  };
}

function bytesAt(length: number): Uint8Array {
  return encoder.encode(`{}${" ".repeat(length - 2)}`);
}

function depthAt(depth: number): Uint8Array {
  return encoder.encode(`${"[".repeat(depth - 1)}0${"]".repeat(depth - 1)}`);
}

function nodesAt(nodes: number): Uint8Array {
  return encoder.encode(`[${Array.from({ length: nodes - 1 }, () => "null").join(",")}]`);
}

function itemsAt(items: number): Uint8Array {
  return encoder.encode(`[${Array.from({ length: items }, () => "0").join(",")}]`);
}

describe("bounded fail-closed JSON ingestion", () => {
  test("accepts every per-kind byte bound and rejects bound plus one before parsing", () => {
    for (const kind of kinds) {
      const limit = INGESTION_LIMITS[kind];
      expect(ingestJson(bytesAt(limit.bytes), kind)).toEqual({});
      expect(codeOf(() => ingestJson(bytesAt(limit.bytes + 1), kind))).toBe("CONTRACT_BYTES_LIMIT");
    }
  });

  test("accepts and rejects every declared depth bound at the strict parser seam", () => {
    for (const kind of kinds) {
      const limit = isolated(INGESTION_LIMITS[kind], "depth");
      expect(ingestJsonAgainstLimits(depthAt(INGESTION_LIMITS[kind].depth), limit)).toBeDefined();
      expect(codeOf(() => ingestJsonAgainstLimits(depthAt(INGESTION_LIMITS[kind].depth + 1), limit))).toBe("CONTRACT_JSON_DEPTH_LIMIT");
    }
  });

  test("accepts and rejects every declared node bound at the strict parser seam", () => {
    for (const kind of kinds) {
      const limit = isolated(INGESTION_LIMITS[kind], "nodes");
      expect(ingestJsonAgainstLimits(nodesAt(INGESTION_LIMITS[kind].nodes), limit)).toBeDefined();
      expect(codeOf(() => ingestJsonAgainstLimits(nodesAt(INGESTION_LIMITS[kind].nodes + 1), limit))).toBe("CONTRACT_JSON_NODE_LIMIT");
    }
  });

  test("accepts and rejects every declared item bound at the strict parser seam", () => {
    for (const kind of kinds) {
      const limit = isolated(INGESTION_LIMITS[kind], "items");
      expect(ingestJsonAgainstLimits(itemsAt(INGESTION_LIMITS[kind].items), limit)).toBeDefined();
      expect(codeOf(() => ingestJsonAgainstLimits(itemsAt(INGESTION_LIMITS[kind].items + 1), limit))).toBe("CONTRACT_JSON_ITEM_LIMIT");
    }
  });

  test("returns exact stable codes for invalid UTF-8, malformed, trailing, duplicate, deep, wide, and schema-invalid JSON", async () => {
    const cases: Array<[string, ContractErrorCode]> = [
      ["utf8.json", "CONTRACT_UTF8_INVALID"],
      ["malformed.json", "CONTRACT_JSON_MALFORMED"],
      ["trailing.json", "CONTRACT_JSON_MALFORMED"],
      ["duplicate-key.json", "CONTRACT_JSON_DUPLICATE_KEY"]
    ];
    for (const [name, expected] of cases) {
      const bytes = new Uint8Array(await readFile(join(fixtures, "invalid", name)));
      expect(codeOf(() => ingestJson(bytes, "schema"))).toBe(expected);
    }
    expect(codeOf(() => ingestJsonAgainstLimits(depthAt(3), { bytes: 100, depth: 2, nodes: 100, items: 100 }))).toBe("CONTRACT_JSON_DEPTH_LIMIT");
    expect(codeOf(() => ingestJsonAgainstLimits(itemsAt(3), { bytes: 100, depth: 10, nodes: 100, items: 2 }))).toBe("CONTRACT_JSON_ITEM_LIMIT");
    expect(codeOf(() => ingestJson(encoder.encode("{}"), "schema", () => false))).toBe("CONTRACT_SCHEMA_INVALID");
  });

  test("error CLI emits exit 2, empty stdout, exactly one bounded JSON stderr record, and no partial success", async () => {
    let stdout = "";
    let stderr = "";
    const exit = await runCheck(["--input", join(fixtures, "invalid", "duplicate-key.json"), "--kind", "schema"], {
      stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; }
    });
    expect(exit).toBe(2);
    expect(stdout).toBe("");
    expect(stderr.split("\n").filter(Boolean)).toHaveLength(1);
    expect(stderr.length).toBeLessThan(512);
    expect(JSON.parse(stderr)).toEqual({ schema_version: "shud.git-status-capability.contract-error.v1", status: "error", code: "CONTRACT_JSON_DUPLICATE_KEY" });
  });

  test("each frozen input kind accepts its valid fixture and emits one bounded success receipt", async () => {
    const temporary = await mkdtemp(join(realpathSync(tmpdir()), "shud-contract-valid-kinds-"));
    try {
      for (const kind of kinds) {
        const path = canonicalInputPaths[kind] ?? join(temporary, `${kind}.json`);
        if (!canonicalInputPaths[kind]) await writeFile(path, JSON.stringify(await validInput(kind)));
        let stdout = "";
        let stderr = "";
        const exit = await runCheck(checkArgs(path, kind), {
          stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; }
        });
        expect(exit).toBe(0);
        expect(stderr).toBe("");
        expect(stdout.split("\n").filter(Boolean)).toHaveLength(1);
        expect(JSON.parse(stdout)).toEqual({ schema_version: "shud.git-status-capability.contract-check-receipt.v1", status: "ok", input_kind: kind });
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("each frozen input kind rejects missing, unknown, wrong-version, type, enum, and illegal state fields with one stable CLI error", async () => {
    const temporary = await mkdtemp(join(realpathSync(tmpdir()), "shud-contract-kinds-"));
    try {
      for (const kind of kinds) {
        const valid = await validInput(kind);
        const mutations: Array<[string, (value: Record<string, any>) => void]> = [
          ["missing", (value) => { delete value.schema_version; }],
          ["unknown", (value) => { value.unknown_field = true; }],
          ["wrong-version", (value) => { value.schema_version = "shud.git-status-capability.future.v2"; }]
        ];
        const kindMutations: Partial<Record<InputKind, Array<[string, (value: Record<string, any>) => void]>>> = {
          catalog: [["wrong-type", (value) => { value.catalog_version = "1"; }]],
          authority_set: [["wrong-source", (value) => { value.source_record.source_sha = "0".repeat(40); }]],
          dependency_graph: [["wrong-type", (value) => { value.lockfile_version = "4"; }]],
          schema: [["schema-open", (value) => { value.additional_properties = true; }]],
          source_input_record: [
            ["wrong-type", (value) => { value.entry_count = "2"; }],
            ["unsafe-path", (value) => { value.admitted_paths[0] = "../escape"; }]
          ],
          row_evidence: [
            ["wrong-platform", (value) => { value.platform = "windows"; }],
            ["wrong-outcome", (value) => { value.observer_outcome = { kind: "unknown" }; }],
            ["wrong-verdict", (value) => { value.row_verdict = "accepted"; }]
          ],
          platform_bundle: [
            ["wrong-status", (value) => { value.run_status = "accepted"; }],
            ["target-mismatch", (value) => { value.target = "x86_64-unknown-linux-gnu"; }]
          ],
          final_bundle: [["wrong-hash", (value) => { value.raw_evidence_digest = "invalid"; }]],
          decision: [["wrong-platforms", (value) => { value.platforms = ["macos"]; }]]
        };
        mutations.push(...(kindMutations[kind] ?? []));
        for (const [name, mutate] of mutations) {
          const changed = structuredClone(valid);
          mutate(changed);
          const path = join(temporary, `${kind}-${name}.json`);
          await writeFile(path, JSON.stringify(changed));
          let stdout = "";
          let stderr = "";
          const exit = await runCheck(checkArgs(path, kind), {
            stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; }
          });
          expect(exit).toBe(2);
          expect(stdout).toBe("");
          expect(stderr.split("\n").filter(Boolean)).toHaveLength(1);
          expect(JSON.parse(stderr)).toEqual({
            schema_version: "shud.git-status-capability.contract-error.v1",
            status: "error",
            code: "CONTRACT_SCHEMA_INVALID"
          });
        }
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});

describe("inclusive observer limits and synthetic-only source frame", () => {
  test("freezes every inclusive observer ceiling and exact/bound-plus-one row pair", () => {
    expect(OBSERVER_LIMITS).toEqual({
      frame_bytes: 8_388_608, index_bytes: 6_291_456, index_entries: 50_000, path_bytes: 512, path_depth: 16,
      nested_repositories: 16, traversal_entries: 200_000, hashed_bytes: 268_435_456, wall_time_ms: 10_000,
      cpu_time_ms: 5_000, threads: 4, memory_bytes: 536_870_912, output_bytes: 262_144
    });
    const expectedPairs = [
      ["LIM-001", "LIM-002", "LIMIT_FRAME_BYTES"], ["LIM-003", "LIM-004", "LIMIT_INDEX_BYTES"],
      ["LIM-005", "LIM-006", "LIMIT_INDEX_ENTRIES"], ["LIM-007", "LIM-008", "LIMIT_PATH_BYTES"],
      ["LIM-009", "LIM-010", "LIMIT_PATH_DEPTH"], ["LIM-011", "LIM-012", "LIMIT_NESTED_REPOSITORIES"],
      ["LIM-013", "LIM-014", "LIMIT_TRAVERSAL_ENTRIES"], ["LIM-015", "LIM-016", "LIMIT_HASHED_BYTES"],
      ["LIM-017", "LIM-018", "LIMIT_WALL_TIME"], ["LIM-019", "LIM-020", "LIMIT_CPU_TIME"],
      ["LIM-021", "LIM-022", "LIMIT_THREADS"], ["LIM-023", "LIM-024", "LIMIT_MEMORY"],
      ["LIM-025", "LIM-026", "LIMIT_OUTPUT_BYTES"]
    ];
    for (const [exact, exceeded, code] of expectedPairs) {
      expect(CATALOG_V1.find((row) => row.id === exact)?.macos_expected).toEqual({ kind: "clean" });
      expect(CATALOG_V1.find((row) => row.id === exceeded)?.macos_expected).toEqual({ kind: "rejected", code });
    }
  });

  test("synthetic frame bytes and SHA-256 reproduce independently from fixed literals", async () => {
    const prefix = Buffer.from("SHUD-HARNESS\0GIT-STATUS-CAPABILITY\0SOURCE-INPUT-DIGEST\0V1\0", "ascii");
    const entries = [
      { path: "a.txt", mode: 0o100644, content: Buffer.from("alpha\n") },
      { path: "bin/run", mode: 0o100755, content: Buffer.from([0, 1, 2, 255]) },
      { path: "unicode/β.txt", mode: 0o100644, content: Buffer.from("water\n") }
    ].sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
    const count = Buffer.alloc(4); count.writeUInt32BE(entries.length);
    const pieces = [prefix, count];
    for (const entry of entries) {
      const path = Buffer.from(entry.path);
      const pathLength = Buffer.alloc(4); pathLength.writeUInt32BE(path.length);
      const mode = Buffer.alloc(4); mode.writeUInt32BE(entry.mode);
      const contentLength = Buffer.alloc(8); contentLength.writeBigUInt64BE(BigInt(entry.content.length));
      pieces.push(pathLength, path, mode, contentLength, entry.content);
    }
    const expected = Buffer.concat(pieces);
    const frame = await readFile(join(import.meta.dir, "..", "goldens", "source-input-v1.synthetic.frame"));
    const literal = (await readFile(join(import.meta.dir, "..", "goldens", "source-input-v1.synthetic.sha256"), "utf8")).trim();
    expect(frame).toEqual(expected);
    expect(encodeSourceInputFrame([
      { path: "unicode/β.txt", gitMode: "100644", content: Buffer.from("water\n") },
      { path: "a.txt", gitMode: "100644", content: Buffer.from("alpha\n") },
      { path: "bin/run", gitMode: "100755", content: Buffer.from([0, 1, 2, 255]) }
    ])).toEqual(expected);
    expect(createHash("sha256").update(expected).digest("hex")).toBe("069f34220c6059b162d9bf16cada6a345eb5d9b3235bd813dde4d72402a2e4dd");
    expect(literal).toBe("069f34220c6059b162d9bf16cada6a345eb5d9b3235bd813dde4d72402a2e4dd");
  });

  test("source frame encoder rejects duplicate, absolute, escape, and unsupported-mode inputs", () => {
    expect(() => encodeSourceInputFrame([
      { path: "same", gitMode: "100644", content: new Uint8Array() },
      { path: "same", gitMode: "100755", content: new Uint8Array() }
    ])).toThrow("SOURCE_PATH_DUPLICATE");
    for (const path of ["/absolute", "../escape", "dot/./path", "back\\slash"]) {
      expect(() => encodeSourceInputFrame([{ path, gitMode: "100644", content: new Uint8Array() }])).toThrow("SOURCE_PATH_INVALID");
    }
    expect(() => encodeSourceInputFrame([{ path: "valid", gitMode: "100600" as "100644", content: new Uint8Array() }])).toThrow("SOURCE_MODE_INVALID");
  });
});
