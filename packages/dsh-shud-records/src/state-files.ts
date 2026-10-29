import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as io from "node:fs/promises";

export function readJson(path: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw new Error(`Cannot read state file ${path}`, { cause: error });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`Invalid JSON in state file ${path}`, { cause: error });
  }
}

export function writeJsonSync(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  let open = true;
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    open = false;
    fs.renameSync(temporary, path);
  } catch (error) {
    const failures = [error];
    if (open) {
      try {
        fs.closeSync(fd);
      } catch (cleanup) {
        failures.push(cleanup);
      }
    }
    try {
      fs.rmSync(temporary, { force: true });
    } catch (cleanup) {
      failures.push(cleanup);
    }
    if (failures.length > 1)
      throw new AggregateError(failures, `Atomic write cleanup failed: ${path}`, { cause: error });
    throw error;
  }
}

export function writeJson(path: string, value: unknown): Promise<void> {
  return writeBytes(path, `${JSON.stringify(value)}\n`);
}

export async function writeBytes(path: string, bytes: string | Uint8Array): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await io.open(temporary, "wx", 0o600);
  let open = true;
  try {
    await file.writeFile(bytes);
    await file.sync();
    await file.close();
    open = false;
    await io.rename(temporary, path);
  } catch (error) {
    const failures = [error];
    if (open) {
      try {
        await file.close();
      } catch (cleanup) {
        failures.push(cleanup);
      }
    }
    try {
      await io.rm(temporary, { force: true });
    } catch (cleanup) {
      failures.push(cleanup);
    }
    if (failures.length > 1)
      throw new AggregateError(failures, `Atomic write cleanup failed: ${path}`, { cause: error });
    throw error;
  }
}
