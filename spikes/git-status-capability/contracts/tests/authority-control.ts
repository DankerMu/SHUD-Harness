import { runCheckForTest } from "../lib/checker";
import type { SourceInputKind } from "../lib/schemas";

type Control =
  | "node_absolute_open"
  | "ffi_absolute_open"
  | "node_replacement_read"
  | "bun_replacement_read"
  | "node_write"
  | "bun_write"
  | "node_spawn"
  | "bun_spawn";

type GuardState = { phase: "admission" | "post_admission"; events: string[] };
const state = (globalThis as Record<PropertyKey, unknown>)[
  Symbol.for("shud.contract.authorityGuard")
] as GuardState | undefined;
if (!state) throw new Error("CONTRACT_TEST_AUTHORITY_PRELOAD_MISSING");
const guardedDlopen = (globalThis as Record<PropertyKey, unknown>)[
  Symbol.for("shud.contract.guardedDlopen")
] as ((path: string, symbols: Record<string, unknown>) => any) | undefined;
if (!guardedDlopen) throw new Error("CONTRACT_TEST_FFI_GUARD_MISSING");
const guardedFs = (globalThis as Record<PropertyKey, unknown>)[
  Symbol.for("shud.contract.guardedFs")
] as typeof import("node:fs") | undefined;
if (!guardedFs) throw new Error("CONTRACT_TEST_NODE_FS_GUARD_MISSING");
const guardedChildProcess = (globalThis as Record<PropertyKey, unknown>)[
  Symbol.for("shud.contract.guardedChildProcess")
] as typeof import("node:child_process") | undefined;
if (!guardedChildProcess) throw new Error("CONTRACT_TEST_NODE_CHILD_PROCESS_GUARD_MISSING");

const [kind, input, control, replacement, sentinel] = Bun.argv.slice(2) as [
  SourceInputKind, string, Control, string, string
];

async function attemptForbiddenOperation(): Promise<void> {
  const childScript = `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "spawned")`;
  switch (control) {
    case "node_absolute_open": {
      const descriptor = guardedFs.openSync(input, guardedFs.constants.O_RDONLY);
      guardedFs.closeSync(descriptor);
      return;
    }
    case "ffi_absolute_open": {
      const libraryPath = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";
      const library = guardedDlopen(libraryPath, { open: { args: ["cstring", "i32"], returns: "i32" } });
      try {
        const descriptor = library.symbols.open(Buffer.from(`${input}\0`), guardedFs.constants.O_RDONLY);
        if (descriptor >= 0) guardedFs.closeSync(descriptor);
      } finally {
        library.close();
      }
      return;
    }
    case "node_replacement_read": {
      guardedFs.readFileSync(replacement);
      return;
    }
    case "bun_replacement_read":
      await Bun.file(replacement).text();
      return;
    case "node_write": {
      guardedFs.writeFileSync(sentinel, "written");
      return;
    }
    case "bun_write":
      await Bun.write(sentinel, "written");
      return;
    case "node_spawn": {
      guardedChildProcess.spawnSync(process.execPath, ["-e", childScript]);
      return;
    }
    case "bun_spawn":
      await Bun.spawn([process.execPath, "-e", childScript]).exited;
      return;
  }
}

let stdout = "";
let stderr = "";
const exit = await runCheckForTest(
  ["--input", input, "--kind", kind],
  { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } },
  {
    afterAdmission: async () => {
      state.phase = "post_admission";
      try {
        await attemptForbiddenOperation();
      } catch (error) {
        state.events.push(`control_error:${error instanceof Error ? error.message : "unknown"}`);
        throw error;
      }
    }
  }
);

process.stdout.write(`${JSON.stringify({ exit, stdout, stderr, events: state.events })}\n`);
