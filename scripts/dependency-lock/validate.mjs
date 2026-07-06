#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEPENDENCY_SECTIONS = [
  ["dependencies", "runtime"],
  ["devDependencies", "dev"],
  ["peerDependencies", "peer"],
  ["optionalDependencies", "optional"],
];

const TYPE_RANK = {
  optional: 0,
  peer: 1,
  dev: 2,
  runtime: 3,
};

const ALLOWED_TYPES = new Set(["runtime", "dev", "peer", "optional"]);
const ALLOWED_SOURCES = new Set(["npm", "git", "local"]);
const EXPECTED_SUBMODULES = ["SHUD", "rSHUD", "AutoSHUD", "zero"];
const EXPECTED_SUBMODULE_SET = new Set(EXPECTED_SUBMODULES);
const ZERO_COMMIT = "13e25c116c62411e6ee8a0ad67a6c53dc7c376c6";
const READ_ONLY_GIT_ENV = {
  GIT_OPTIONAL_LOCKS: "0",
  GIT_NO_LAZY_FETCH: "1",
};

function usage() {
  return `Usage: node scripts/dependency-lock/validate.mjs [options]

Validates dependency-lock.initial.json against the root Bun lock graph,
package-manager identity, and current submodule checkout evidence.

Options:
  --repo-root <path>          Repository root. Defaults to this script's repo root.
  --lockfile <path>           Bun lockfile. Defaults to <repo-root>/bun.lock.
  --dependency-lock <path>    DependencyLock JSON. Defaults to <repo-root>/dependency-lock.initial.json.
  --help                      Show this help.

Derivation:
  The expected package list is derived from bun.lock's workspaces section.
  For every workspace, dependencies/devDependencies/peerDependencies/optionalDependencies
  are scanned, workspace:* and workspace-local package names are ignored, and each
  remaining direct external package is resolved through bun.lock's packages table.
  Repeated declarations use dependency_type precedence runtime > dev > peer > optional.
  Registry packages are source=npm; git/file-like specs resolve to git/local.
  Submodule evidence is read from .gitmodules and git submodule status.
`;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--repo-root" || arg === "--lockfile" || arg === "--dependency-lock") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${arg} requires a value`);
      }
      options[arg.slice(2).replace(/-/g, "_")] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function stripJsonTrailingCommas(text) {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }

    if (char === ",") {
      let nextIndex = index + 1;
      while (nextIndex < text.length && /\s/.test(text[nextIndex])) {
        nextIndex += 1;
      }
      if (text[nextIndex] === "}" || text[nextIndex] === "]") {
        continue;
      }
    }

    output += char;
  }

  return output;
}

function readJson(filePath) {
  const text = readFileSync(filePath, "utf8");
  return JSON.parse(text);
}

function readBunLock(filePath) {
  const text = readFileSync(filePath, "utf8");
  return JSON.parse(stripJsonTrailingCommas(text));
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(record, key) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function parsePackageDescriptor(name, entry) {
  if (!Array.isArray(entry) || typeof entry[0] !== "string") {
    return { error: `lock package ${name} does not have a Bun descriptor tuple` };
  }

  const descriptor = entry[0];
  const prefix = `${name}@`;
  if (!descriptor.startsWith(prefix)) {
    return { error: `lock package ${name} descriptor ${descriptor} does not start with ${prefix}` };
  }

  const version = descriptor.slice(prefix.length);
  if (!version) {
    return { error: `lock package ${name} descriptor does not contain a resolved version` };
  }

  return { descriptor, version };
}

function resolvePackage(packagesTable, name) {
  const directEntry = hasOwn(packagesTable, name) ? [[name, packagesTable[name]]] : [];
  const descriptorMatches = Object.entries(packagesTable).filter(([, entry]) => {
    return Array.isArray(entry) && typeof entry[0] === "string" && entry[0].startsWith(`${name}@`);
  });
  const matches = directEntry.length > 0 ? directEntry : descriptorMatches;

  if (matches.length === 0) {
    return { error: `lock packages table has no resolved entry for ${name}` };
  }
  if (matches.length > 1) {
    const keys = matches.map(([key]) => key).sort().join(", ");
    return { error: `lock packages table has multiple resolved entries for ${name}: ${keys}` };
  }

  const parsed = parsePackageDescriptor(name, matches[0][1]);
  if (parsed.error) {
    return parsed;
  }

  return parsed;
}

function inferSource(spec, descriptor) {
  const values = [String(spec), descriptor];
  if (values.some((value) => /^(?:file|link|portal):/.test(value))) {
    return "local";
  }
  if (values.some((value) => /^(?:git|github|gitlab|bitbucket)(?:\+|:)/.test(value) || value.includes("github.com"))) {
    return "git";
  }
  return "npm";
}

function addExpectedPackage(expected, item) {
  const existing = expected.get(item.name);
  if (!existing) {
    expected.set(item.name, {
      name: item.name,
      version: item.version,
      dependency_type: item.dependency_type,
      source: item.source,
      locations: [item.location],
    });
    return null;
  }

  existing.locations.push(item.location);
  if (existing.version !== item.version) {
    return `${item.name} resolves to both ${existing.version} and ${item.version}`;
  }
  if (existing.source !== item.source) {
    return `${item.name} resolves to both source=${existing.source} and source=${item.source}`;
  }
  if (TYPE_RANK[item.dependency_type] > TYPE_RANK[existing.dependency_type]) {
    existing.dependency_type = item.dependency_type;
  }
  return null;
}

function collectExpectedPackages(lock) {
  const errors = [];
  if (!isRecord(lock.workspaces)) {
    return { expected: new Map(), errors: ["bun.lock must contain a workspaces object"] };
  }
  if (!isRecord(lock.packages)) {
    return { expected: new Map(), errors: ["bun.lock must contain a packages object"] };
  }

  const workspaceNames = new Set();
  for (const [workspacePath, workspace] of Object.entries(lock.workspaces)) {
    if (!isRecord(workspace)) {
      errors.push(`workspace ${workspacePath || "<root>"} is not an object`);
      continue;
    }
    if (typeof workspace.name === "string") {
      workspaceNames.add(workspace.name);
    }
  }

  const expected = new Map();
  for (const [workspacePath, workspace] of Object.entries(lock.workspaces).sort(([left], [right]) => left.localeCompare(right))) {
    if (!isRecord(workspace)) {
      continue;
    }

    for (const [section, dependencyType] of DEPENDENCY_SECTIONS) {
      const dependencies = workspace[section];
      if (dependencies === undefined) {
        continue;
      }
      if (!isRecord(dependencies)) {
        errors.push(`workspace ${workspacePath || "<root>"} ${section} must be an object`);
        continue;
      }

      for (const name of Object.keys(dependencies).sort()) {
        const spec = dependencies[name];
        if (workspaceNames.has(name) || String(spec).startsWith("workspace:")) {
          continue;
        }

        const resolved = resolvePackage(lock.packages, name);
        if (resolved.error) {
          errors.push(`${workspacePath || "<root>"} ${section}.${name}: ${resolved.error}`);
          continue;
        }

        const addError = addExpectedPackage(expected, {
          name,
          version: resolved.version,
          dependency_type: dependencyType,
          source: inferSource(spec, resolved.descriptor),
          location: `${workspacePath || "<root>"} ${section}.${name}`,
        });
        if (addError) {
          errors.push(addError);
        }
      }
    }
  }

  if (expected.size === 0) {
    errors.push("expected direct external dependency set is empty");
  }

  return { expected, errors };
}

function collectActualPackages(dependencyLock) {
  const errors = [];
  if (!Array.isArray(dependencyLock.packages) || dependencyLock.packages.length === 0) {
    return {
      actual: new Map(),
      errors: ["DependencyLock.packages must be a non-empty array"],
    };
  }

  const actual = new Map();
  dependencyLock.packages.forEach((pkg, index) => {
    const label = `DependencyLock.packages[${index}]`;
    if (!isRecord(pkg)) {
      errors.push(`${label} must be an object`);
      return;
    }
    for (const field of ["name", "version", "dependency_type", "source"]) {
      if (typeof pkg[field] !== "string" || pkg[field].length === 0) {
        errors.push(`${label}.${field} must be a non-empty string`);
      }
    }
    if (typeof pkg.dependency_type === "string" && !ALLOWED_TYPES.has(pkg.dependency_type)) {
      errors.push(`${label}.dependency_type has invalid value ${pkg.dependency_type}`);
    }
    if (typeof pkg.source === "string" && !ALLOWED_SOURCES.has(pkg.source)) {
      errors.push(`${label}.source has invalid value ${pkg.source}`);
    }
    if (typeof pkg.name === "string") {
      if (actual.has(pkg.name)) {
        errors.push(`duplicate DependencyLock package entry: ${pkg.name}`);
      } else {
        actual.set(pkg.name, {
          name: pkg.name,
          version: pkg.version,
          dependency_type: pkg.dependency_type,
          source: pkg.source,
        });
      }
    }
  });

  return { actual, errors };
}

function comparePackages(expected, actual) {
  const errors = [];
  const expectedNames = [...expected.keys()].sort();
  const actualNames = [...actual.keys()].sort();

  for (const name of expectedNames) {
    if (!actual.has(name)) {
      const item = expected.get(name);
      errors.push(
        `missing package: ${name} (expected version=${item.version}, dependency_type=${item.dependency_type}, source=${item.source})`,
      );
    }
  }

  for (const name of actualNames) {
    if (!expected.has(name)) {
      const item = actual.get(name);
      errors.push(
        `extra package: ${name} (actual version=${item.version}, dependency_type=${item.dependency_type}, source=${item.source})`,
      );
    }
  }

  for (const name of expectedNames) {
    if (!actual.has(name)) {
      continue;
    }
    const expectedItem = expected.get(name);
    const actualItem = actual.get(name);
    for (const field of ["version", "dependency_type", "source"]) {
      if (actualItem[field] !== expectedItem[field]) {
        errors.push(`${field} mismatch for ${name}: expected ${expectedItem[field]}, got ${actualItem[field]}`);
      }
    }
  }

  return errors;
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function toPosixRelativePath(fromPath, toPath) {
  return path.relative(fromPath, toPath).split(path.sep).join("/");
}

function parsePackageManager(packageJson) {
  if (!isRecord(packageJson)) {
    return { errors: ["package.json root must be an object"] };
  }

  const packageManager = packageJson.packageManager;
  if (typeof packageManager !== "string" || packageManager.length === 0) {
    return { errors: ["package.json#packageManager must be a non-empty string"] };
  }

  const separatorIndex = packageManager.lastIndexOf("@");
  if (separatorIndex <= 0 || separatorIndex === packageManager.length - 1) {
    return { errors: [`package.json#packageManager must use <name>@<version>, got ${packageManager}`] };
  }

  return {
    packageManager: {
      name: packageManager.slice(0, separatorIndex),
      version: packageManager.slice(separatorIndex + 1),
    },
    errors: [],
  };
}

function validateLockfileIdentity(dependencyLock, packageJson, repoRoot, lockfilePath) {
  const errors = [];
  const parsedPackageManager = parsePackageManager(packageJson);
  errors.push(...parsedPackageManager.errors);

  const packageManager = dependencyLock.package_manager;
  if (!isRecord(packageManager)) {
    errors.push("DependencyLock.package_manager must be an object");
    return errors;
  }

  if (parsedPackageManager.packageManager) {
    if (packageManager.name !== parsedPackageManager.packageManager.name) {
      errors.push(
        `DependencyLock.package_manager.name mismatch: expected ${parsedPackageManager.packageManager.name} from package.json#packageManager, got ${packageManager.name}`,
      );
    }
    if (packageManager.version !== parsedPackageManager.packageManager.version) {
      errors.push(
        `DependencyLock.package_manager.version mismatch: expected ${parsedPackageManager.packageManager.version} from package.json#packageManager, got ${packageManager.version}`,
      );
    }
  }

  const expectedLockfilePath = toPosixRelativePath(repoRoot, lockfilePath);
  if (packageManager.lockfile_path !== expectedLockfilePath) {
    errors.push(
      `DependencyLock.package_manager.lockfile_path mismatch: expected ${expectedLockfilePath}, got ${packageManager.lockfile_path}`,
    );
  }

  const expectedLockfileSha256 = sha256(lockfilePath);
  if (packageManager.lockfile_sha256 !== expectedLockfileSha256) {
    errors.push(
      `DependencyLock.package_manager.lockfile_sha256 mismatch: expected ${expectedLockfileSha256}, got ${packageManager.lockfile_sha256}`,
    );
  }
  return errors;
}

function parseGitmodules(text) {
  const errors = [];
  const entries = new Map();
  let current = null;

  for (const [lineIndex, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }

    const sectionMatch = line.match(/^\[submodule "(.+)"\]$/);
    if (sectionMatch) {
      const name = sectionMatch[1];
      if (entries.has(name)) {
        errors.push(`duplicate .gitmodules submodule section: ${name}`);
      }
      current = { name };
      entries.set(name, current);
      continue;
    }

    const assignmentMatch = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/);
    if (!assignmentMatch) {
      errors.push(`.gitmodules line ${lineIndex + 1} is not a supported assignment or submodule section`);
      continue;
    }
    if (!current) {
      errors.push(`.gitmodules line ${lineIndex + 1} appears before any submodule section`);
      continue;
    }

    const [, key, value] = assignmentMatch;
    if (key === "path" || key === "url") {
      if (hasOwn(current, key)) {
        errors.push(`.gitmodules submodule ${current.name} has duplicate ${key}`);
      }
      current[key] = value;
    }
  }

  for (const name of EXPECTED_SUBMODULES) {
    const entry = entries.get(name);
    if (!entry) {
      errors.push(`missing .gitmodules submodule: ${name}`);
      continue;
    }
    if (typeof entry.path !== "string" || entry.path.length === 0) {
      errors.push(`.gitmodules submodule ${name} must have a non-empty path`);
    }
    if (typeof entry.url !== "string" || entry.url.length === 0) {
      errors.push(`.gitmodules submodule ${name} must have a non-empty url`);
    }
  }

  for (const name of [...entries.keys()].sort()) {
    if (!EXPECTED_SUBMODULE_SET.has(name)) {
      errors.push(`extra .gitmodules submodule: ${name}`);
    }
  }

  return { entries, errors };
}

function gitOutput(args, repoRoot) {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...READ_ONLY_GIT_ENV,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function parseGitSubmoduleStatus(output) {
  const errors = [];
  const statusByPath = new Map();

  for (const rawLine of output.split(/\r?\n/)) {
    if (rawLine.trim().length === 0) {
      continue;
    }

    const statusChar = [" ", "+", "-", "U"].includes(rawLine[0]) ? rawLine[0] : " ";
    const rest = statusChar === " " && rawLine[0] !== " " ? rawLine : rawLine.slice(1);
    const match = rest.trimStart().match(/^([0-9a-f]{40})\s+([^\s]+)(?:\s|$)/);
    if (!match) {
      errors.push(`git submodule status line is not parseable: ${rawLine}`);
      continue;
    }

    const [, commit, submodulePath] = match;
    if (statusByPath.has(submodulePath)) {
      errors.push(`duplicate git submodule status path: ${submodulePath}`);
      continue;
    }
    statusByPath.set(submodulePath, { commit, statusChar });
  }

  return { statusByPath, errors };
}

function collectDependencyLockSubmodules(dependencyLock) {
  const errors = [];
  if (!Array.isArray(dependencyLock.submodules)) {
    return { submodules: new Map(), errors: ["DependencyLock.submodules must be an array"] };
  }

  const submodules = new Map();
  dependencyLock.submodules.forEach((submodule, index) => {
    const label = `DependencyLock.submodules[${index}]`;
    if (!isRecord(submodule)) {
      errors.push(`${label} must be an object`);
      return;
    }

    for (const field of ["name", "commit"]) {
      if (typeof submodule[field] !== "string" || submodule[field].length === 0) {
        errors.push(`${label}.${field} must be a non-empty string`);
      }
    }
    if (typeof submodule.commit === "string" && !/^[0-9a-f]{40}$/.test(submodule.commit)) {
      errors.push(`${label}.commit must be a 40-character lowercase git commit`);
    }
    if (submodule.dirty !== false) {
      const name = typeof submodule.name === "string" ? submodule.name : `<index ${index}>`;
      errors.push(`DependencyLock.submodule ${name} dirty must be false`);
    }

    if (typeof submodule.name === "string") {
      if (submodules.has(submodule.name)) {
        errors.push(`duplicate DependencyLock submodule entry: ${submodule.name}`);
      } else {
        submodules.set(submodule.name, {
          name: submodule.name,
          commit: submodule.commit,
          dirty: submodule.dirty,
        });
      }
    }
  });

  for (const name of EXPECTED_SUBMODULES) {
    if (!submodules.has(name)) {
      errors.push(`missing submodule: ${name}`);
    }
  }

  for (const name of [...submodules.keys()].sort()) {
    if (!EXPECTED_SUBMODULE_SET.has(name)) {
      errors.push(`extra submodule: ${name}`);
    }
  }

  return { submodules, errors };
}

function submoduleWorktreeIsDirty(repoRoot, submodulePath) {
  const status = gitOutput(["status", "--porcelain=v1", "--untracked-files=all"], path.join(repoRoot, submodulePath));
  return status.trim().length > 0;
}

function validateSubmodules(dependencyLock, repoRoot) {
  const errors = [];
  const dependencyLockResult = collectDependencyLockSubmodules(dependencyLock);
  errors.push(...dependencyLockResult.errors);

  const gitmodulesPath = path.join(repoRoot, ".gitmodules");
  const gitmodulesResult = parseGitmodules(readFileSync(gitmodulesPath, "utf8"));
  errors.push(...gitmodulesResult.errors);

  let statusResult = { statusByPath: new Map(), errors: [] };
  try {
    statusResult = parseGitSubmoduleStatus(gitOutput(["submodule", "status"], repoRoot));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`git submodule status failed: ${message}`);
  }
  errors.push(...statusResult.errors);

  for (const name of EXPECTED_SUBMODULES) {
    const record = dependencyLockResult.submodules.get(name);
    const gitmodule = gitmodulesResult.entries.get(name);
    if (!record || !gitmodule || typeof gitmodule.path !== "string" || gitmodule.path.length === 0) {
      continue;
    }

    const status = statusResult.statusByPath.get(gitmodule.path);
    if (!status) {
      errors.push(`git submodule status missing path for ${name}: ${gitmodule.path}`);
      continue;
    }
    if (status.statusChar !== " ") {
      errors.push(`git submodule status for ${name} must be clean at ${gitmodule.path}, got ${status.statusChar}`);
    }
    if (record.commit !== status.commit) {
      errors.push(`submodule commit mismatch for ${name}: expected ${status.commit} from git submodule status, got ${record.commit}`);
    }

    try {
      if (submoduleWorktreeIsDirty(repoRoot, gitmodule.path)) {
        errors.push(`submodule worktree is dirty for ${name}: ${gitmodule.path}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`git status failed for submodule ${name} at ${gitmodule.path}: ${message}`);
    }
  }

  for (const submodulePath of [...statusResult.statusByPath.keys()].sort()) {
    const matchingEntry = [...gitmodulesResult.entries.values()].find((entry) => entry.path === submodulePath);
    if (!matchingEntry) {
      errors.push(`git submodule status has path not declared in .gitmodules: ${submodulePath}`);
    }
  }

  const zero = dependencyLockResult.submodules.get("zero");
  if (zero && zero.commit !== ZERO_COMMIT) {
    errors.push(`zero submodule commit must be ${ZERO_COMMIT}, got ${zero.commit}`);
  }

  return errors;
}

function main() {
  const scriptPath = fileURLToPath(import.meta.url);
  const defaultRepoRoot = path.resolve(path.dirname(scriptPath), "..", "..");
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return 0;
  }

  const repoRoot = path.resolve(options.repo_root ?? defaultRepoRoot);
  const lockfilePath = path.resolve(options.lockfile ?? path.join(repoRoot, "bun.lock"));
  const dependencyLockPath = path.resolve(options.dependency_lock ?? path.join(repoRoot, "dependency-lock.initial.json"));
  const packageJsonPath = path.join(repoRoot, "package.json");

  const lock = readBunLock(lockfilePath);
  const dependencyLock = readJson(dependencyLockPath);
  const packageJson = readJson(packageJsonPath);

  const expectedResult = collectExpectedPackages(lock);
  const actualResult = collectActualPackages(dependencyLock);
  const identityErrors = validateLockfileIdentity(dependencyLock, packageJson, repoRoot, lockfilePath);
  const submoduleErrors = validateSubmodules(dependencyLock, repoRoot);
  const compareErrors = comparePackages(expectedResult.expected, actualResult.actual);
  const errors = [...expectedResult.errors, ...actualResult.errors, ...identityErrors, ...submoduleErrors, ...compareErrors];

  if (errors.length > 0) {
    console.error("DependencyLock validation failed:");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    return 1;
  }

  console.log(
    `DependencyLock package list valid: ${expectedResult.expected.size} direct external workspace dependencies match ${path.relative(
      repoRoot,
      dependencyLockPath,
    )}.`,
  );
  console.log(`DependencyLock submodules valid: ${EXPECTED_SUBMODULES.join(", ")} match .gitmodules and git submodule status.`);
  console.log(
    "Derivation: bun.lock workspaces direct dependency sections -> ignore workspace-local deps -> resolve versions from bun.lock packages table.",
  );
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`DependencyLock package validation crashed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
