#!/usr/bin/env node
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

function usage() {
  return `Usage: node scripts/dependency-lock/validate.mjs [options]

Validates dependency-lock.initial.json packages against the root Bun lock graph.

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

function validateLockfileIdentity(dependencyLock, lockfilePath) {
  const errors = [];
  const packageManager = dependencyLock.package_manager;
  if (!isRecord(packageManager)) {
    return ["DependencyLock.package_manager must be an object"];
  }
  if (packageManager.name !== "bun") {
    errors.push(`DependencyLock.package_manager.name must be bun, got ${packageManager.name}`);
  }
  if (packageManager.lockfile_sha256 !== sha256(lockfilePath)) {
    errors.push(
      `DependencyLock.package_manager.lockfile_sha256 mismatch: expected ${sha256(lockfilePath)}, got ${packageManager.lockfile_sha256}`,
    );
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

  const lock = readBunLock(lockfilePath);
  const dependencyLock = readJson(dependencyLockPath);

  const expectedResult = collectExpectedPackages(lock);
  const actualResult = collectActualPackages(dependencyLock);
  const identityErrors = validateLockfileIdentity(dependencyLock, lockfilePath);
  const compareErrors = comparePackages(expectedResult.expected, actualResult.actual);
  const errors = [...expectedResult.errors, ...actualResult.errors, ...identityErrors, ...compareErrors];

  if (errors.length > 0) {
    console.error("DependencyLock package validation failed:");
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
