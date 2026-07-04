import path from "node:path";
import type { PolicyGateToolCall, PolicyRule } from "./policy-gate-core";

export const DATA_RAW_WRITE_DENY_RULE_ID = "policy-gate-spike.data_raw_write_forbidden" as const;
export const DATA_RAW_WRITE_GUARD_CLASS = "authority" as const;
export const DATA_RAW_WRITE_RULE_REF =
  "openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md" as const;

const BASH_TOOL_IDS = new Set(["bash"]);
const REDIRECT_WRITE_OPERATORS = new Set([">", ">>", ">|", "1>", "1>>", "2>", "2>>", "&>", "&>>"]);
const SEGMENT_SEPARATORS = new Set([";", "&&", "||", "|"]);
const ANY_RAW_PATH_MUTATION_COMMANDS = new Set([
  "chmod",
  "chown",
  "mkdir",
  "rm",
  "rmdir",
  "touch",
  "truncate"
]);
const DESTINATION_RAW_PATH_COMMANDS = new Set(["cp", "install", "ln"]);
const ANY_ENDPOINT_RAW_PATH_COMMANDS = new Set(["mv"]);
const WRAPPER_COMMANDS = new Set(["command", "doas", "env", "nice", "nohup", "sudo", "time"]);
const SHELL_COMMANDS = new Set(["bash", "sh", "zsh"]);

export const DATA_RAW_WRITE_DENY_RULE: PolicyRule = {
  ruleId: DATA_RAW_WRITE_DENY_RULE_ID,
  guard_class: DATA_RAW_WRITE_GUARD_CLASS,
  description: "Deny bash mutations targeting protected data/raw paths.",
  evaluate(call) {
    if (!BASH_TOOL_IDS.has(call.toolId)) {
      return { decision: "allow" };
    }

    const command = extractBashCommand(call.input);
    if (!command) {
      return { decision: "allow" };
    }

    const target = findProtectedDataRawWriteTarget(command);
    if (!target) {
      return { decision: "allow" };
    }

    return {
      decision: "deny",
      reason: `bash command attempts to mutate protected raw data path: ${target}`,
      remediation: {
        next_action: "adjust_scope",
        hint:
          "Write generated or edited data under a governed task workspace path instead of data/raw.",
        ref: DATA_RAW_WRITE_RULE_REF
      }
    };
  }
};

export function extractBashCommand(input: unknown): string | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }

  const record = input as Record<string, unknown>;
  if (typeof record.command === "string") {
    return record.command;
  }
  if (typeof record.cmd === "string") {
    return record.cmd;
  }
  return undefined;
}

export function findProtectedDataRawWriteTarget(command: string): string | undefined {
  const tokens = tokenizeShellCommand(command);
  const redirectTarget = findRedirectWriteTarget(tokens);
  if (redirectTarget) {
    return redirectTarget;
  }

  for (const segment of splitCommandSegments(tokens)) {
    const mutationTarget = findMutationCommandTarget(segment);
    if (mutationTarget) {
      return mutationTarget;
    }
  }

  return undefined;
}

export function makeDataRawPolicyGateContext() {
  return {
    rules: [DATA_RAW_WRITE_DENY_RULE]
  };
}

export type DataRawWritePolicyCall = PolicyGateToolCall;

function findRedirectWriteTarget(tokens: readonly string[]): string | undefined {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!REDIRECT_WRITE_OPERATORS.has(token)) {
      continue;
    }

    const target = tokens[index + 1];
    if (target && isProtectedDataRawPath(target)) {
      return target;
    }
  }

  return undefined;
}

function splitCommandSegments(tokens: readonly string[]): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];

  for (const token of tokens) {
    if (SEGMENT_SEPARATORS.has(token)) {
      if (current.length > 0) {
        segments.push(current);
        current = [];
      }
      continue;
    }
    current.push(token);
  }

  if (current.length > 0) {
    segments.push(current);
  }

  return segments;
}

function findMutationCommandTarget(segment: readonly string[]): string | undefined {
  const commandIndex = findCommandTokenIndex(segment);
  if (commandIndex === undefined) {
    return undefined;
  }

  const command = path.posix.basename(segment[commandIndex]);
  const args = segment.slice(commandIndex + 1);
  if (ANY_RAW_PATH_MUTATION_COMMANDS.has(command)) {
    return args.find(isProtectedDataRawPath);
  }
  if (DESTINATION_RAW_PATH_COMMANDS.has(command)) {
    return findDestinationRawPathTarget(args);
  }
  if (ANY_ENDPOINT_RAW_PATH_COMMANDS.has(command)) {
    return args.find(isProtectedDataRawPath);
  }
  if (command === "dd") {
    return findDdOutputTarget(args);
  }
  if (command === "tee") {
    return args.find((arg) => !arg.startsWith("-") && isProtectedDataRawPath(arg));
  }
  if (command === "sed" && args.some((arg) => arg === "-i" || arg.startsWith("-i"))) {
    return args.find(isProtectedDataRawPath);
  }
  if (SHELL_COMMANDS.has(command)) {
    const shellCommand = findShellCommandArgument(args);
    return shellCommand ? findProtectedDataRawWriteTarget(shellCommand) : undefined;
  }

  return undefined;
}

function findCommandTokenIndex(segment: readonly string[]): number | undefined {
  let index = 0;
  while (index < segment.length) {
    const token = segment[index];
    if (isAssignment(token)) {
      index += 1;
      continue;
    }

    const command = path.posix.basename(token);
    if (WRAPPER_COMMANDS.has(command)) {
      index += 1;
      while (index < segment.length && segment[index].startsWith("-")) {
        index += 1;
      }
      continue;
    }

    return index;
  }

  return undefined;
}

function lastNonOptionArgument(args: readonly string[]): string | undefined {
  const target = args.filter((arg) => !arg.startsWith("-")).at(-1);
  return target && isProtectedDataRawPath(target) ? target : undefined;
}

function findDestinationRawPathTarget(args: readonly string[]): string | undefined {
  const targetDirectory = findTargetDirectoryArgument(args);
  if (targetDirectory !== undefined) {
    return isProtectedDataRawPath(targetDirectory) ? targetDirectory : undefined;
  }

  return lastNonOptionArgument(args);
}

function findTargetDirectoryArgument(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-t" || arg === "--target-directory") {
      return args[index + 1] ?? "";
    }
    if (arg.startsWith("--target-directory=")) {
      return arg.slice("--target-directory=".length);
    }
    if (arg.startsWith("-t") && !arg.startsWith("--") && arg.length > 2) {
      return arg.slice(2);
    }
  }

  return undefined;
}

function findDdOutputTarget(args: readonly string[]): string | undefined {
  for (const arg of args) {
    if (!arg.startsWith("of=")) {
      continue;
    }

    const target = arg.slice("of=".length);
    if (isProtectedDataRawPath(target)) {
      return target;
    }
  }

  return undefined;
}

function findShellCommandArgument(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "-c") {
      return args[index + 1];
    }
    if (arg.startsWith("-") && !arg.startsWith("--") && arg.includes("c")) {
      return args[index + 1];
    }
  }

  return undefined;
}

function isAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function isProtectedDataRawPath(candidate: string): boolean {
  const normalized = path.posix.normalize(candidate.replace(/^file:\/\//, ""));
  const withoutDotPrefix = normalized.replace(/^\.\/+/, "");
  return (
    withoutDotPrefix === "data/raw" ||
    withoutDotPrefix.startsWith("data/raw/") ||
    withoutDotPrefix.endsWith("/data/raw") ||
    withoutDotPrefix.includes("/data/raw/")
  );
}

function tokenizeShellCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let index = 0;

  const flush = () => {
    if (current.length > 0) {
      tokens.push(current);
      current = "";
    }
  };

  while (index < command.length) {
    const char = command[index];

    if (quote) {
      if (char === "\\") {
        const next = command[index + 1];
        if (next !== undefined) {
          current += next;
          index += 2;
          continue;
        }
      }
      if (char === quote) {
        quote = undefined;
        index += 1;
        continue;
      }
      current += char;
      index += 1;
      continue;
    }

    if (char === "'" || char === `"`) {
      quote = char;
      index += 1;
      continue;
    }

    if (char === "\n" || char === "\r") {
      flush();
      tokens.push(";");
      index += 1;
      continue;
    }

    if (/\s/.test(char)) {
      flush();
      index += 1;
      continue;
    }

    const operator = readShellOperator(command, index);
    if (operator) {
      flush();
      tokens.push(operator);
      index += operator.length;
      continue;
    }

    if (char === "\\") {
      const next = command[index + 1];
      if (next !== undefined) {
        current += next;
        index += 2;
        continue;
      }
    }

    current += char;
    index += 1;
  }

  flush();
  return tokens;
}

function readShellOperator(command: string, index: number): string | undefined {
  for (const operator of ["&>>", "&&", "||", ">>", ">|", "1>>", "2>>", "&>", "1>", "2>", ">", "|", ";"]) {
    if (command.startsWith(operator, index)) {
      return operator;
    }
  }

  return undefined;
}
