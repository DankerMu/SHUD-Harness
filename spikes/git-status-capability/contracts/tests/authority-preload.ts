const actualFs = await import("node:fs");
const actualChildProcess = await import("node:child_process");
const actualFfi = await import("bun:ffi");
const originalOpenSync = actualFs.openSync;
const originalReadFileSync = actualFs.readFileSync;
const originalWriteFileSync = actualFs.writeFileSync;
const originalDlopen = actualFfi.dlopen;
const originalNodeSpawn = actualChildProcess.spawn;
const originalNodeSpawnSync = actualChildProcess.spawnSync;

type GuardState = { phase: "admission" | "post_admission"; events: string[] };
const state: GuardState = { phase: "admission", events: [] };
(globalThis as Record<PropertyKey, unknown>)[Symbol.for("shud.contract.authorityGuard")] = state;

function absolutePath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/");
}

function decodedCString(value: unknown): string | undefined {
  if (!Buffer.isBuffer(value)) return undefined;
  const end = value.indexOf(0);
  return value.subarray(0, end < 0 ? value.length : end).toString("utf8");
}

function deny(operation: string, target?: unknown): never {
  state.events.push(`${operation}:${typeof target === "string" ? target : ""}`);
  throw new Error(`CONTRACT_TEST_AUTHORITY_DENIED:${operation}`);
}

function guardAbsolute(operation: string, target: unknown): void {
  if (state.phase === "post_admission" && absolutePath(target)) deny(operation, target);
}

const guardedFs = {
  ...actualFs,
  openSync(path: Parameters<typeof actualFs.openSync>[0], ...args: unknown[]) {
    guardAbsolute("node_open", path);
    return (originalOpenSync as (...values: unknown[]) => number)(path, ...args);
  },
  readFileSync(path: Parameters<typeof actualFs.readFileSync>[0], ...args: unknown[]) {
    guardAbsolute("node_read", path);
    return (originalReadFileSync as (...values: unknown[]) => unknown)(path, ...args);
  },
  writeFileSync(path: Parameters<typeof actualFs.writeFileSync>[0], ...args: unknown[]) {
    if (state.phase === "post_admission") deny("node_write", path);
    return (originalWriteFileSync as (...values: unknown[]) => void)(path, ...args);
  }
};
const guardedChildProcess = {
  ...actualChildProcess,
  spawn(...args: unknown[]) {
    if (state.phase === "post_admission") deny("node_spawn");
    return (originalNodeSpawn as (...values: unknown[]) => unknown)(...args);
  },
  spawnSync(...args: unknown[]) {
    if (state.phase === "post_admission") deny("node_spawn");
    return (originalNodeSpawnSync as (...values: unknown[]) => unknown)(...args);
  },
  exec: () => deny("node_exec"),
  execSync: () => deny("node_exec"),
  execFile: () => deny("node_exec_file"),
  execFileSync: () => deny("node_exec_file"),
  fork: () => deny("node_fork")
};
(globalThis as Record<PropertyKey, unknown>)[Symbol.for("shud.contract.guardedFs")] = guardedFs;
(globalThis as Record<PropertyKey, unknown>)[Symbol.for("shud.contract.guardedChildProcess")] = guardedChildProcess;

const guardedDlopen = (path: string, symbols: Record<string, unknown>) => {
  const library = (originalDlopen as (...args: unknown[]) => any)(path, symbols);
  const guardedSymbols: Record<string, (...args: unknown[]) => unknown> = {};
  for (const [name, symbol] of Object.entries(library.symbols as Record<string, (...args: unknown[]) => unknown>)) {
    guardedSymbols[name] = (...args: unknown[]) => {
      if (state.phase === "post_admission" && (name === "open" || name === "openat")) {
        const candidate = decodedCString(args[name === "open" ? 0 : 1]);
        if (candidate?.startsWith("/")) deny(`ffi_${name}`, candidate);
      }
      return symbol(...args);
    };
  }
  return new Proxy(library, {
    get(target, property, receiver) {
      return property === "symbols" ? guardedSymbols : Reflect.get(target, property, receiver);
    }
  });
};
(globalThis as Record<PropertyKey, unknown>)[Symbol.for("shud.contract.guardedDlopen")] = guardedDlopen;

const originalBunFile = Bun.file.bind(Bun);
const originalBunWrite = Bun.write.bind(Bun);
const originalBunSpawn = Bun.spawn.bind(Bun);
const originalBunSpawnSync = Bun.spawnSync.bind(Bun);

(Bun as any).file = (path: Parameters<typeof Bun.file>[0], ...args: unknown[]) => {
  guardAbsolute("bun_file", path);
  return (originalBunFile as (...values: unknown[]) => ReturnType<typeof Bun.file>)(path, ...args);
};
(Bun as any).write = (path: Parameters<typeof Bun.write>[0], ...args: unknown[]) => {
  if (state.phase === "post_admission") deny("bun_write", path);
  return (originalBunWrite as (...values: unknown[]) => ReturnType<typeof Bun.write>)(path, ...args);
};
(Bun as any).spawn = (...args: unknown[]) => {
  if (state.phase === "post_admission") deny("bun_spawn");
  return (originalBunSpawn as (...values: unknown[]) => ReturnType<typeof Bun.spawn>)(...args);
};
(Bun as any).spawnSync = (...args: unknown[]) => {
  if (state.phase === "post_admission") deny("bun_spawn");
  return (originalBunSpawnSync as (...values: unknown[]) => ReturnType<typeof Bun.spawnSync>)(...args);
};
