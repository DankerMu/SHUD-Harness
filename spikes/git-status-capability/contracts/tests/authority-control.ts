import type { SourceInputKind } from "../lib/schemas";

type Control =
  | "node_absolute_open"
  | "node_url_open"
  | "node_buffer_open"
  | "fs_alias_url_open"
  | "ffi_absolute_open"
  | "node_replacement_read"
  | "node_promises_read"
  | "fs_promises_read"
  | "node_promises_property_read"
  | "fs_promises_property_read"
  | "bun_replacement_read"
  | "bun_url_read"
  | "node_write"
  | "bun_write"
  | "node_spawn"
  | "bun_spawn"
  | "production_path";

type GuardState = { phase: "admission" | "post_admission"; events: string[] };
const state = (globalThis as Record<PropertyKey, unknown>)[
  Symbol.for("shud.contract.authorityGuard")
] as GuardState | undefined;
if (!state) throw new Error("CONTRACT_TEST_AUTHORITY_PRELOAD_MISSING");

const [kind, input, control, replacement, sentinel] = Bun.argv.slice(2) as [
  SourceInputKind, string, Control, string, string
];

async function attemptForbiddenOperation(): Promise<void> {
  const childScript = `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "spawned")`;
  switch (control) {
    case "node_absolute_open": {
      const fs = await import("node:fs");
      const descriptor = fs.openSync(input, fs.constants.O_RDONLY);
      fs.closeSync(descriptor);
      return;
    }
    case "node_url_open": {
      const fs = await import("node:fs");
      const { pathToFileURL } = await import("node:url");
      const descriptor = fs.openSync(pathToFileURL(input), fs.constants.O_RDONLY);
      fs.closeSync(descriptor);
      return;
    }
    case "node_buffer_open": {
      const fs = await import("node:fs");
      const descriptor = fs.openSync(Buffer.from(input), fs.constants.O_RDONLY);
      fs.closeSync(descriptor);
      return;
    }
    case "fs_alias_url_open": {
      const fs = await import("fs");
      const { pathToFileURL } = await import("node:url");
      const descriptor = fs.openSync(pathToFileURL(input), fs.constants.O_RDONLY);
      fs.closeSync(descriptor);
      return;
    }
    case "ffi_absolute_open": {
      const libraryPath = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";
      const fs = await import("node:fs");
      const { dlopen } = await import("bun:ffi");
      const library = dlopen(libraryPath, { open: { args: ["cstring", "i32"], returns: "i32" } });
      try {
        const descriptor = library.symbols.open(Buffer.from(`${input}\0`), fs.constants.O_RDONLY);
        if (descriptor >= 0) fs.closeSync(descriptor);
      } finally {
        library.close();
      }
      return;
    }
    case "node_replacement_read": {
      const fs = await import("node:fs");
      fs.readFileSync(replacement);
      return;
    }
    case "node_promises_read": {
      const fs = await import("node:fs/promises");
      await fs.readFile(replacement);
      return;
    }
    case "fs_promises_read": {
      const fs = await import("fs/promises");
      await fs.readFile(replacement);
      return;
    }
    case "node_promises_property_read": {
      const fs = await import("node:fs");
      await fs.promises.readFile(replacement);
      return;
    }
    case "fs_promises_property_read": {
      const fs = await import("fs");
      await fs.promises.readFile(replacement);
      return;
    }
    case "bun_replacement_read":
      await Bun.file(replacement).text();
      return;
    case "bun_url_read": {
      const { pathToFileURL } = await import("node:url");
      await Bun.file(pathToFileURL(replacement)).text();
      return;
    }
    case "node_write": {
      const fs = await import("node:fs");
      fs.writeFileSync(sentinel, "written");
      return;
    }
    case "bun_write":
      await Bun.write(sentinel, "written");
      return;
    case "node_spawn": {
      const childProcess = await import("node:child_process");
      childProcess.spawnSync(process.execPath, ["-e", childScript]);
      return;
    }
    case "bun_spawn":
      await Bun.spawn([process.execPath, "-e", childScript]).exited;
      return;
    case "production_path":
      return;
  }
}

let stdout = "";
let stderr = "";
const { runCheckForTest } = await import("../lib/checker");
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
