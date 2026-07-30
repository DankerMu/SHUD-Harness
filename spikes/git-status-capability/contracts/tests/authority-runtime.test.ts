import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AUTHORITY_PROOF_REGISTRY,
  AUTHORITY_PROOF_ROWS,
  AUTHORITY_PROOF_VERSION
} from "./authority-vocabulary";
import type { AuthorityDenialTarget } from "./authority-vocabulary";
import {
  checkPath,
  failure,
  success,
  validIdentityPath,
  validSourcePath
} from "./helpers";

const authorityPreloadPath = join(import.meta.dir, "authority-preload.ts");
const authorityControlPath = join(import.meta.dir, "authority-control.ts");
const systemLibraryPath = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";

type GuardedCommand = Readonly<{ exit: number; stdout: string; stderr: string }>;

function normalizedAuthorityTarget(path: string): string {
  const absolute = resolve(path);
  if (process.platform === "darwin") {
    for (const alias of ["/etc", "/tmp", "/var"] as const) {
      if (absolute === alias || absolute.startsWith(`${alias}/`)) return `/private${absolute}`;
    }
  }
  return absolute;
}

function denialTarget(
  target: AuthorityDenialTarget,
  input: string,
  replacement: string,
  writeSentinel: string
): string {
  switch (target) {
    case "input":
      return normalizedAuthorityTarget(input);
    case "replacement":
      return normalizedAuthorityTarget(replacement);
    case "write_sentinel":
      return normalizedAuthorityTarget(writeSentinel);
    case "library":
      return systemLibraryPath;
    case "none":
      return "";
  }
}

async function guardedCommand(args: readonly string[]): Promise<GuardedCommand> {
  const child = Bun.spawn(
    [process.execPath, "--preload", authorityPreloadPath, ...args],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env } }
  );
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ]);
  return { exit, stdout, stderr };
}

function controlArguments(
  kind: "source_input_record" | "source_identity_projection",
  input: string,
  control: string,
  replacement: string,
  workerSentinel: string,
  writeSentinel: string,
  spawnSentinel: string
): readonly string[] {
  return [
    authorityControlPath,
    kind,
    input,
    control,
    replacement,
    workerSentinel,
    writeSentinel,
    spawnSentinel
  ];
}

describe("source-ingress authority runtime proof", () => {
  test("both unchanged direct commands retain exact receipts and no denial under the active preload", async () => {
    expect(Bun.version).toBe("1.2.19");
    const root = await mkdtemp(join(tmpdir(), "shud-authority-direct-"));
    const replacement = join(root, "replacement.json");
    const workerSentinel = join(root, "worker.sentinel");
    const writeSentinel = join(root, "write.sentinel");
    const spawnSentinel = join(root, "spawn.sentinel");
    const replacementBytes = Buffer.from('{"replacement":"must-not-be-read"}');
    await writeFile(replacement, replacementBytes);
    try {
      for (const [kind, input] of [
        ["source_input_record", validSourcePath],
        ["source_identity_projection", validIdentityPath]
      ] as const) {
        expect(await guardedCommand([checkPath, "--input", input, "--kind", kind])).toEqual({
          exit: 0,
          stdout: success(kind),
          stderr: ""
        });
        const directPayload = { exit: 0, stdout: success(kind), stderr: "", events: [] as string[] };
        expect(await guardedCommand(controlArguments(
          kind,
          input,
          "direct_success",
          replacement,
          workerSentinel,
          writeSentinel,
          spawnSentinel
        ))).toEqual({
          exit: 0,
          stdout: `${JSON.stringify(directPayload)}\n`,
          stderr: ""
        });
        expect(await readFile(replacement)).toEqual(replacementBytes);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("runs every registry control after admission with no structural scanner and exact pre-side-effect denials", async () => {
    expect(AUTHORITY_PROOF_REGISTRY.version).toBe(AUTHORITY_PROOF_VERSION);
    expect(new Set(AUTHORITY_PROOF_ROWS.map((row) => row.id)).size).toBe(AUTHORITY_PROOF_ROWS.length);
    expect(new Set(AUTHORITY_PROOF_ROWS.map((row) => row.control)).size).toBe(AUTHORITY_PROOF_ROWS.length);

    const root = await mkdtemp(join(tmpdir(), "shud-authority-runtime-"));
    const replacement = join(root, "replacement.json");
    const replacementBytes = Buffer.from('{"replacement":"must-not-be-read"}');
    const inputBytes = await readFile(validSourcePath);
    await writeFile(replacement, replacementBytes);
    try {
      for (const row of AUTHORITY_PROOF_ROWS) {
        const workerSentinel = join(root, `${row.id}.worker.sentinel`);
        const writeSentinel = join(root, `${row.id}.write.sentinel`);
        const spawnSentinel = join(root, `${row.id}.spawn.sentinel`);
        const target = denialTarget(row.denialEvent.target, validSourcePath, replacement, writeSentinel);
        const expectedPayload = {
          exit: 2,
          stdout: "",
          stderr: failure("CONTRACT_SCHEMA_INVALID"),
          events: [
            `${row.denialEvent.operation}:${target}`,
            `control_error:CONTRACT_TEST_AUTHORITY_DENIED:${row.denialEvent.operation}`
          ]
        };
        expect(await guardedCommand(controlArguments(
          "source_input_record",
          validSourcePath,
          row.control,
          replacement,
          workerSentinel,
          writeSentinel,
          spawnSentinel
        ))).toEqual({
          exit: 0,
          stdout: `${JSON.stringify(expectedPayload)}\n`,
          stderr: ""
        });
        expect(await Bun.file(workerSentinel).exists()).toBe(row.sideEffects.workerEntrySentinel);
        expect(await Bun.file(writeSentinel).exists()).toBe(row.sideEffects.writeSentinel);
        expect(await Bun.file(spawnSentinel).exists()).toBe(row.sideEffects.spawnSentinel);
        expect((await readFile(validSourcePath)).equals(inputBytes)).toBe(row.sideEffects.inputUnchanged);
        expect((await readFile(replacement)).equals(replacementBytes)).toBe(row.sideEffects.replacementUnchanged);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
