#!/usr/bin/env sh
# Prepare only an independent checkout and input copy; never run the solver.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)
exec node --input-type=module - "$ROOT" "$@" <<'NODE'
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { devNull } from 'node:os';
import { isDeepStrictEqual } from 'node:util';

const [harness, ...args] = process.argv.slice(2);
const pin = '9a422e5eb708df7d2f8b4066a3083a031d679a82';
const rootShud = join(harness, 'SHUD');
const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']) {
  delete env[key];
}

function git(directory, ...arguments_) {
  return execFileSync('git', ['-C', directory, '-c', `core.hooksPath=${devNull}`, ...arguments_], {
    env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000, maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

function stat(path) {
  try { return fs.lstatSync(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function within(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

function physicalWorkspace(path) {
  if (stat(path)) {
    const physical = fs.realpathSync(path);
    if (!fs.statSync(physical).isDirectory()) throw new Error(`non-directory workspace ancestor: ${path}`);
    return physical;
  }
  return join(physicalWorkspace(dirname(path)), basename(path));
}

function checkAncestors(path) {
  const parent = dirname(path);
  if (parent !== path) checkAncestors(parent);
  const value = stat(path);
  if (value && !value.isDirectory()) throw new Error(`unsafe/non-directory destination ancestor: ${path}`);
}

function snapshot(directory, contents, prefix = '') {
  const result = [];
  for (const name of fs.readdirSync(directory).sort()) {
    const path = join(directory, name);
    const key = join(prefix, name);
    const value = fs.lstatSync(path);
    if (value.isDirectory()) {
      result.push([key, 'directory'], ...snapshot(path, contents, key));
    } else if (contents) {
      if (!value.isFile()) throw new Error(`source must contain only ordinary files/directories: ${path}`);
      result.push([key, sha256(fs.readFileSync(path))]);
    } else {
      result.push([key, value.isSymbolicLink() ? fs.readlinkSync(path) : 'file']);
    }
  }
  return result;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function rootState() {
  const gitDir = git(rootShud, 'rev-parse', '--absolute-git-dir');
  const dotGit = join(rootShud, '.git');
  return {
    head: git(rootShud, 'rev-parse', 'HEAD'),
    status: git(rootShud, 'status', '--porcelain', '--untracked-files=all'),
    diff: git(rootShud, 'diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD'),
    gitDir,
    inventory: snapshot(gitDir, false),
    gitlink: fs.lstatSync(dotGit).isFile() ? fs.readFileSync(dotGit).toString('hex') : null,
  };
}

// Latin-1 is a lossless byte mapping, not a text normalization step.
function replaceLine(original, index, text) {
  const lines = original.toString('latin1').split('\n');
  const ending = lines[index].endsWith('\r') ? '\r' : '';
  lines[index] = Buffer.from(text).toString('latin1') + ending;
  return Buffer.from(lines.join('\n'), 'latin1');
}

let workspace;
let outputsStarted = false;
try {
  if ((args.length !== 1 && args.length !== 3) || !args[0]?.trim() ||
      args[0].startsWith('--') || (args.length === 3 && args[1] !== '--keliya')) {
    throw new Error('usage: shud-replay-prepare.sh <workspace> [--keliya <input-dir>]');
  }
  const selected = args.length === 3 ? args[2] : process.env.SHUD_REPLAY_KELIYA;
  if (!selected?.trim()) throw new Error('missing keliya source: use --keliya <dir> or SHUD_REPLAY_KELIYA');
  const source = fs.realpathSync(selected);
  if (!fs.statSync(source).isDirectory() || basename(source) !== 'keliya' || basename(dirname(source)) !== 'input') {
    throw new Error(`keliya source must be a basin/input/keliya directory: ${source}`);
  }
  const basin = dirname(dirname(source));
  const forcing = join(basin, 'forcing.trimmed');
  if (!stat(forcing)?.isDirectory()) throw new Error(`missing/unsafe forcing.trimmed directory: ${forcing}`);

  workspace = physicalWorkspace(isAbsolute(args[0]) ? args[0] : `${process.cwd()}${sep}${args[0]}`);
  checkAncestors(workspace);
  for (const protectedRoot of [basin, fs.realpathSync(rootShud), git(rootShud, 'rev-parse', '--absolute-git-dir')]) {
    if (within(protectedRoot, workspace) || within(workspace, protectedRoot)) {
      throw new Error(`workspace overlaps readonly source: ${protectedRoot}`);
    }
  }
  const checkout = join(workspace, 'repos', 'SHUD');
  const input = join(workspace, 'input', 'keliya');
  for (const destination of [checkout, input]) {
    checkAncestors(dirname(destination));
    if (stat(destination)) throw new Error(`destination already exists: ${destination}`);
  }

  const sourceBefore = snapshot(source, true);
  const forcingBefore = snapshot(forcing, true);
  if (stat(join(source, 'PREPARED.json'))) throw new Error('source already contains PREPARED.json');
  const cfgName = 'keliya.cfg.para';
  const forcName = 'keliya.tsd.forc';
  const cfg = fs.readFileSync(join(source, cfgName));
  const manifest = fs.readFileSync(join(source, forcName));
  const cfgLines = cfg.toString('latin1').split('\n');
  const ompLines = cfgLines.flatMap((line, index) => /^[ \t]*NUM_OPENMP(?:[ \t]|\r?$)/.test(line) ? [index] : []);
  if (ompLines.length !== 1) throw new Error('keliya.cfg.para must contain exactly one NUM_OPENMP line');
  const manifestText = new TextDecoder('utf-8', { fatal: true }).decode(manifest);
  const lines = manifestText.split(/\r?\n/);
  if (manifestText.includes('\0') || lines.length < 4 || lines[0].trim().split(/\s+/)[0] !== '32') {
    throw new Error('keliya.tsd.forc must declare 32 forcing references');
  }
  const header = lines[2].trim().split(/\s+/);
  const rows = lines.slice(3).filter((line) => line.trim()).map((line) => line.trim().split(/\s+/));
  if (header.at(-1) !== 'Filename' || rows.length !== 32 || rows.some((row) => row.length !== header.length)) {
    throw new Error('keliya.tsd.forc requires a Filename-final table with 32 matching rows');
  }
  const referencedFiles = new Set();
  for (const row of rows) {
    const filename = row.at(-1);
    const path = resolve(forcing, filename);
    if (isAbsolute(filename) || !within(forcing, path) || !stat(path)?.isFile()) {
      throw new Error(`missing/unsafe referenced forcing file: ${filename}`);
    }
    referencedFiles.add(fs.realpathSync(path));
  }
  if (referencedFiles.size !== 32) throw new Error('keliya.tsd.forc must reference 32 distinct forcing files');
  const rewritten = {
    [cfgName]: replaceLine(cfg, ompLines[0], 'NUM_OPENMP\t1'),
    [forcName]: replaceLine(manifest, 1, forcing),
  };
  const prepared = {
    source,
    files: {
      [cfgName]: { before_sha256: sha256(cfg), after_sha256: sha256(rewritten[cfgName]) },
      [forcName]: { before_sha256: sha256(manifest), after_sha256: sha256(rewritten[forcName]) },
    },
  };
  const rootBefore = rootState();
  const failures = [];
  try {
    outputsStarted = true;
    fs.mkdirSync(dirname(checkout), { recursive: true });
    git(workspace, 'clone', '--local', '--no-hardlinks', '--', rootShud, checkout);
    git(checkout, 'checkout', '--detach', pin);
    const dotGit = join(checkout, '.git');
    if (git(checkout, 'rev-parse', 'HEAD') !== pin ||
        git(checkout, 'rev-parse', '--abbrev-ref', 'HEAD') !== 'HEAD' ||
        git(checkout, 'status', '--porcelain', '--untracked-files=all') !== '' ||
        git(checkout, 'rev-parse', '--absolute-git-dir') !== dotGit ||
        !fs.lstatSync(dotGit).isDirectory() || fs.realpathSync(dotGit) !== dotGit) {
      throw new Error('prepared SHUD checkout is not independent, clean and detached at the full replay pin');
    }
    fs.mkdirSync(dirname(input), { recursive: true });
    fs.cpSync(source, input, { recursive: true, force: false, errorOnExist: true });
    for (const [name, value] of Object.entries(rewritten)) fs.writeFileSync(join(input, name), value);
    fs.writeFileSync(join(input, 'PREPARED.json'), JSON.stringify(prepared, null, 2) + '\n', { flag: 'wx' });
  } catch (error) {
    failures.push(error.message);
  }
  for (const [label, before, observe] of [
    ['root SHUD', rootBefore, rootState],
    ['keliya source', sourceBefore, () => snapshot(source, true)],
    ['forcing source', forcingBefore, () => snapshot(forcing, true)],
  ]) {
    try {
      if (!isDeepStrictEqual(observe(), before)) throw new Error(`${label} changed during preparation`);
    } catch (error) {
      failures.push(`${label} preservation: ${error.message}`);
    }
  }
  if (failures.length) throw new Error(failures.join('\n'));
  console.log(`shud:replay: prepared ${checkout} at ${pin}; input ${input}`);
} catch (error) {
  console.error(`shud:replay: ${error.message}`);
  if (outputsStarted) console.error(`shud:replay: failed scratch output retained at ${workspace}`);
  process.exitCode = 1;
}
NODE
