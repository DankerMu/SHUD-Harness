import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  fileList,
  makeSensitivityHarness,
  type SensitivityHarness,
} from "./sensitivity/test-harness.ts";

const script = fileURLToPath(new URL("./shud-sensitivity-prepare.ts", import.meta.url));

let h: SensitivityHarness;
beforeEach(() => {
  h = makeSensitivityHarness();
});
afterEach(() => h.dispose());

/** Direct `node` entry; `root` routes through the exported CLI with a constructed harness root. */
function cli(args: string[], env: NodeJS.ProcessEnv, root?: string) {
  const argv = root
    ? [
        "--input-type=module",
        "-e",
        `import { runSensitivityPrepareCli } from ${JSON.stringify(new URL(`file://${script}`).href)};` +
          `process.exitCode = await runSensitivityPrepareCli(process.argv.slice(1), { root: ${JSON.stringify(root)} });`,
        ...args,
      ]
    : [script, ...args];
  const result = spawnSync(process.execPath, argv, {
    cwd: h.root,
    env,
    encoding: "utf8",
    timeout: 60_000,
    killSignal: "SIGKILL",
  });
  expect(result.error).toBeUndefined();
  return result;
}

function without(name: string): NodeJS.ProcessEnv {
  const env = { ...h.env };
  delete env[name];
  return env;
}

type Case = {
  name: string;
  item: RegExp;
  args?: (h: SensitivityHarness) => string[];
  env?: (h: SensitivityHarness) => NodeJS.ProcessEnv;
  harnessRoot?: boolean;
  existingWorkspace?: boolean;
};

const CASES: Case[] = [
  { name: "missing workspace argument", item: /workspace argument/u, args: () => [] },
  { name: "missing record argument", item: /record path argument/u, args: (x) => [x.workspace] },
  { name: "unset SHUD_BIN", item: /SHUD_BIN/u, env: () => without("SHUD_BIN") },
  {
    name: "relative SHUD_BIN",
    item: /SHUD_BIN/u,
    env: (x) => ({ ...x.env, SHUD_BIN: "bin/shud" }),
    existingWorkspace: true,
  },
  {
    name: "non-executable SHUD_BIN",
    item: /SHUD_BIN/u,
    env: (x) => {
      fs.chmodSync(x.shudBin, 0o644);
      return x.env;
    },
  },
  {
    name: "non-regular SHUD_BIN",
    item: /SHUD_BIN/u,
    env: (x) => ({ ...x.env, SHUD_BIN: join(x.root, "bin") }),
    existingWorkspace: true,
  },
  { name: "unset DMXAPI_KEY", item: /DMXAPI_KEY/u, env: () => without("DMXAPI_KEY") },
  {
    name: "empty DMXAPI_KEY",
    item: /DMXAPI_KEY/u,
    env: (x) => ({ ...x.env, DMXAPI_KEY: "  " }),
    existingWorkspace: true,
  },
  { name: "missing SHUD/input/ccw", item: /SHUD\/input\/ccw/u, harnessRoot: true },
];

test.each(CASES)(
  "$name exits 1 naming the item before any workspace, record or DSH_HOME change",
  (c) => {
    if (c.harnessRoot) fs.rmSync(h.source, { recursive: true });
    if (c.existingWorkspace) fs.mkdirSync(h.workspace);
    const args = c.args ? c.args(h) : [h.workspace, h.record];
    const env = c.env ? c.env(h) : h.env;
    const result = cli(args, env, c.harnessRoot ? h.root : undefined);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toMatch(/^shud:sensitivity: /u);
    expect(result.stderr).toMatch(c.item);
    if (c.existingWorkspace) expect(fs.readdirSync(h.workspace)).toEqual([]);
    else expect(fs.existsSync(h.workspace)).toBe(false);
    expect(fs.readdirSync(h.evidence)).toEqual([]);
    expect(fileList(h.dshHome)).toEqual(["sentinel"]);
  },
);

test("CLI prepares the constructed harness and exits 0 with the record written", () => {
  const result = cli([h.workspace, h.record], h.env, h.root);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  const record = JSON.parse(fs.readFileSync(h.record, "utf8")) as { copy_sha256: object };
  expect(Object.keys(record.copy_sha256)).toEqual(fileList(join(h.workspace, "input/ccw")));
  expect(fileList(h.dshHome)).toEqual(["sentinel"]);
});

test("CLI reports an occupied workspace path with exit 1", () => {
  fs.mkdirSync(join(h.workspace, "analyses"), { recursive: true });
  const result = cli([h.workspace, h.record], h.env, h.root);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`Occupied workspace path: ${join(h.workspace, "analyses")}`);
  expect(fs.readdirSync(h.workspace)).toEqual(["analyses"]);
});
