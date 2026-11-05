import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { snapshotTree } from "../../packages/dsh-shud-records/src/report-code-change-test-harness.ts";

const script = fileURLToPath(new URL("./shud-replay.sh", import.meta.url));

const missingCases = [
  ["explicit workspace", "workspace", "argument"],
  ["blank workspace", "workspace", "blank-argument"],
  ["extra workspace argument", "workspace", "extra-argument"],
  ["missing key", "DMXAPI_KEY", "missing"],
  ["blank key", "DMXAPI_KEY", "blank"],
  ["missing binary", "SHUD_BIN", "missing"],
  ["relative binary", "SHUD_BIN", "relative"],
  ["nonexistent binary", "SHUD_BIN", "nonexistent"],
  ["nonexecutable binary", "SHUD_BIN", "nonexecutable"],
  ["directory binary", "SHUD_BIN", "directory"],
  ["missing SUNDIALS root", "SUNDIALS_ROOT", "missing"],
  ["relative SUNDIALS root", "SUNDIALS_ROOT", "relative"],
  ["nonexistent SUNDIALS root", "SUNDIALS_ROOT", "nonexistent"],
  ["file SUNDIALS root", "SUNDIALS_ROOT", "file"],
  ["missing keliya source", "SHUD_REPLAY_KELIYA", "missing"],
  ["blank keliya source", "SHUD_REPLAY_KELIYA", "blank"],
  ["nonexistent keliya source", "SHUD_REPLAY_KELIYA", "nonexistent"],
  ["missing design document", "P1e design", "design"],
] as const;

test.each(missingCases)(
  "%s exits 1 before preparation, profile installation or session writes",
  (_label, prerequisite, invalid) => {
    const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "shud-replay-preflight-")));
    try {
      const cwd = join(root, "unrelated cwd");
      const workspace = join(root, "scratch workspace");
      const home = join(root, "private-home");
      const sundials = join(root, "sundials");
      const keliya = join(root, "basin", "input", "keliya");
      const forcing = join(root, "basin", "forcing.trimmed");
      const temporary = join(root, "tmp");
      const ordinaryFile = join(root, "not-executable");
      for (const directory of [cwd, workspace, home, sundials, keliya, forcing, temporary]) {
        fs.mkdirSync(directory, { recursive: true });
      }
      fs.mkdirSync(join(home, "sessions", "existing"), { recursive: true });
      fs.writeFileSync(join(home, "sessions", "existing", "sentinel"), "retain session bytes\n");
      fs.writeFileSync(join(workspace, "sentinel"), "retain workspace bytes\n");
      fs.writeFileSync(ordinaryFile, "ordinary file, not a solver\n", { mode: 0o600 });
      fs.writeFileSync(
        join(keliya, "keliya.cfg.para"),
        "START\t12053\nEND\t12143\nNUM_OPENMP\t8\n",
      );
      fs.writeFileSync(
        join(keliya, "keliya.tsd.forc"),
        `1 19510101\n${forcing}\nID Lon Lat X Y Z Filename\n1 80 35 0 0 1000 station.csv\n`,
      );
      fs.writeFileSync(join(forcing, "station.csv"), "abc");
      // Deliberately never inherit the real model credential, user profile or Git configuration.
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: root,
        TMPDIR: temporary,
        DSH_HOME: home,
        DMXAPI_KEY: "constructed-preflight-only",
        SHUD_BIN: process.execPath,
        SUNDIALS_ROOT: sundials,
        SHUD_REPLAY_KELIYA: keliya,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_OPTIONAL_LOCKS: "0",
      };
      let args = [workspace];
      if (invalid === "argument") args = [];
      else if (invalid === "blank-argument") args = [" \t "];
      else if (invalid === "extra-argument") args = [workspace, "unexpected"];
      else if (invalid === "missing") delete env[prerequisite];
      else if (invalid === "blank") env[prerequisite] = " \t ";
      else if (invalid === "relative") env[prerequisite] = ".";
      else if (invalid === "nonexistent") env[prerequisite] = join(root, "does-not-exist");
      else if (invalid === "directory") env[prerequisite] = sundials;
      else if (invalid === "nonexecutable" || invalid === "file") env[prerequisite] = ordinaryFile;
      let entry = script;
      if (invalid === "design") {
        entry = join(root, "isolated-harness/scripts/runtime/shud-replay.sh");
        fs.mkdirSync(dirname(entry), { recursive: true });
        fs.copyFileSync(script, entry);
      }

      const before = snapshotTree(root);
      const result = spawnSync("sh", [entry, ...args], {
        cwd,
        env,
        encoding: "utf8",
        timeout: 10_000,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
      });
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(new RegExp(prerequisite, "iu"));
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("constructed-preflight-only");
      // This includes namespaces, bytes, modes, inode and mtime, not source-text inspection.
      expect(snapshotTree(root)).toEqual(before);
      expect(fs.existsSync(join(workspace, "repos"))).toBe(false);
      expect(fs.existsSync(join(workspace, "input"))).toBe(false);
      expect(fs.readdirSync(join(home, "sessions"))).toEqual(["existing"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
