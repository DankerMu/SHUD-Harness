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
const WRAPPER_OPTIONS_WITH_OPERANDS = new Map<string, ReadonlySet<string>>([
  ["env", new Set(["-u", "--unset"])],
  ["nice", new Set(["-n", "--adjustment"])]
]);
const SHELL_COMMANDS = new Set(["bash", "sh", "zsh"]);

type ShellToken = {
  value: string;
  fromOperator: boolean;
  quoted: boolean;
};

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
  const substitutionTarget = findCommandSubstitutionWriteTarget(command);
  if (substitutionTarget) {
    return substitutionTarget;
  }

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

function findRedirectWriteTarget(tokens: readonly ShellToken[]): string | undefined {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!isUnquotedOperatorToken(token, REDIRECT_WRITE_OPERATORS)) {
      continue;
    }

    const target = tokens[index + 1]?.value;
    if (target && isProtectedDataRawPath(target)) {
      return target;
    }
  }

  return undefined;
}

function splitCommandSegments(tokens: readonly ShellToken[]): ShellToken[][] {
  const segments: ShellToken[][] = [];
  let current: ShellToken[] = [];

  for (const token of tokens) {
    if (isUnquotedOperatorToken(token, SEGMENT_SEPARATORS)) {
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

function isUnquotedOperatorToken(token: ShellToken, operators: ReadonlySet<string>): boolean {
  return token.fromOperator && !token.quoted && operators.has(token.value);
}

function findMutationCommandTarget(segment: readonly ShellToken[]): string | undefined {
  const commandIndex = findCommandTokenIndex(segment);
  if (commandIndex === undefined) {
    return undefined;
  }

  const command = path.posix.basename(segment[commandIndex].value);
  const args = segment.slice(commandIndex + 1);
  if (ANY_RAW_PATH_MUTATION_COMMANDS.has(command)) {
    return findRawPathArgument(args);
  }
  if (DESTINATION_RAW_PATH_COMMANDS.has(command)) {
    return findDestinationRawPathTarget(args);
  }
  if (ANY_ENDPOINT_RAW_PATH_COMMANDS.has(command)) {
    return findRawPathArgument(args);
  }
  if (command === "dd") {
    return findDdOutputTarget(args);
  }
  if (command === "tee") {
    return args.find((arg) => !arg.value.startsWith("-") && isProtectedDataRawPath(arg.value))
      ?.value;
  }
  if (command === "sed" && args.some((arg) => arg.value === "-i" || arg.value.startsWith("-i"))) {
    return findRawPathArgument(args);
  }
  if (command === "curl") {
    return findCurlOutputTarget(args);
  }
  if (SHELL_COMMANDS.has(command)) {
    const shellCommand = findShellCommandArgument(args);
    return shellCommand ? findProtectedDataRawWriteTarget(shellCommand) : undefined;
  }

  return undefined;
}

function findCommandTokenIndex(segment: readonly ShellToken[]): number | undefined {
  let index = 0;
  while (index < segment.length) {
    const token = segment[index];
    if (isAssignment(token)) {
      index += 1;
      continue;
    }

    const command = path.posix.basename(token.value);
    if (WRAPPER_COMMANDS.has(command)) {
      index += 1;
      while (index < segment.length && segment[index].value.startsWith("-")) {
        const option = segment[index].value;
        index += 1;
        if (wrapperOptionConsumesOperand(command, option) && index < segment.length) {
          index += 1;
        }
      }
      continue;
    }

    return index;
  }

  return undefined;
}

function wrapperOptionConsumesOperand(command: string, option: string): boolean {
  return WRAPPER_OPTIONS_WITH_OPERANDS.get(command)?.has(option) ?? false;
}

function findRawPathArgument(args: readonly ShellToken[]): string | undefined {
  return args.find((arg) => isProtectedDataRawPath(arg.value))?.value;
}

function lastNonOptionArgument(args: readonly ShellToken[]): string | undefined {
  const target = args.filter((arg) => !arg.value.startsWith("-")).at(-1)?.value;
  return target && isProtectedDataRawPath(target) ? target : undefined;
}

function findDestinationRawPathTarget(args: readonly ShellToken[]): string | undefined {
  const targetDirectory = findTargetDirectoryArgument(args);
  if (targetDirectory !== undefined) {
    return isProtectedDataRawPath(targetDirectory) ? targetDirectory : undefined;
  }

  return lastNonOptionArgument(args);
}

function findTargetDirectoryArgument(args: readonly ShellToken[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index].value;
    if (arg === "-t" || arg === "--target-directory") {
      return args[index + 1]?.value ?? "";
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

function findDdOutputTarget(args: readonly ShellToken[]): string | undefined {
  for (const arg of args) {
    if (!arg.value.startsWith("of=")) {
      continue;
    }

    const target = arg.value.slice("of=".length);
    if (isProtectedDataRawPath(target)) {
      return target;
    }
  }

  return undefined;
}

function findCurlOutputTarget(args: readonly ShellToken[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index].value;
    if (arg === "-o" || arg === "--output") {
      const target = args[index + 1]?.value;
      if (target && isProtectedDataRawPath(target)) {
        return target;
      }
      continue;
    }
    if (arg.startsWith("--output=")) {
      const target = arg.slice("--output=".length);
      if (isProtectedDataRawPath(target)) {
        return target;
      }
      continue;
    }

    const shortOptionTarget = findCurlShortOutputTarget(args, index);
    if (shortOptionTarget) {
      return shortOptionTarget;
    }
  }

  return undefined;
}

function findCurlShortOutputTarget(
  args: readonly ShellToken[],
  index: number
): string | undefined {
  const arg = args[index].value;
  if (!arg.startsWith("-") || arg.startsWith("--") || arg.length < 3) {
    return undefined;
  }

  const optionCluster = arg.slice(1);
  const outputOptionIndex = optionCluster.indexOf("o");
  if (outputOptionIndex === -1) {
    return undefined;
  }

  const attachedTarget = optionCluster.slice(outputOptionIndex + 1);
  const target = attachedTarget.length > 0 ? attachedTarget : args[index + 1]?.value;
  return target && isProtectedDataRawPath(target) ? target : undefined;
}

function findShellCommandArgument(args: readonly ShellToken[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index].value;
    if (arg === "--") {
      continue;
    }
    if (arg === "-c") {
      return args[index + 1]?.value;
    }
    if (arg.startsWith("-") && !arg.startsWith("--") && arg.includes("c")) {
      return args[index + 1]?.value;
    }
  }

  return undefined;
}

function isAssignment(token: ShellToken): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token.value);
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

function tokenizeShellCommand(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let current = "";
  let currentQuoted = false;
  let quote: "'" | '"' | undefined;
  let index = 0;

  const flush = () => {
    if (current.length > 0) {
      tokens.push({ value: current, fromOperator: false, quoted: currentQuoted });
      current = "";
      currentQuoted = false;
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
      currentQuoted = true;
      index += 1;
      continue;
    }

    if (char === "\n" || char === "\r") {
      flush();
      tokens.push({ value: ";", fromOperator: true, quoted: false });
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
      tokens.push({ value: operator, fromOperator: true, quoted: false });
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

function findCommandSubstitutionWriteTarget(command: string): string | undefined {
  let quote: "'" | '"' | undefined;
  let index = 0;

  while (index < command.length) {
    const char = command[index];

    if (char === "\\") {
      index += 2;
      continue;
    }

    if (quote === "'") {
      if (char === "'") {
        quote = undefined;
      }
      index += 1;
      continue;
    }

    if (char === "'" && !quote) {
      quote = "'";
      index += 1;
      continue;
    }

    if (char === `"`) {
      quote = quote === `"` ? undefined : `"`;
      index += 1;
      continue;
    }

    if (char === "$" && command[index + 1] === "(") {
      const substitution = readCommandSubstitution(command, index + 1);
      if (!substitution) {
        return undefined;
      }

      const target = findProtectedDataRawWriteTarget(substitution.content);
      if (target) {
        return target;
      }
      index = substitution.endIndex + 1;
      continue;
    }

    if (char === "`") {
      const substitution = readBacktickCommandSubstitution(command, index);
      if (!substitution) {
        return undefined;
      }

      const target = findProtectedDataRawWriteTarget(substitution.content);
      if (target) {
        return target;
      }
      index = substitution.endIndex + 1;
      continue;
    }

    index += 1;
  }

  return undefined;
}

function readCommandSubstitution(
  command: string,
  openParenIndex: number
): { content: string; endIndex: number } | undefined {
  let quote: "'" | '"' | undefined;
  let depth = 1;
  let index = openParenIndex + 1;

  while (index < command.length) {
    const char = command[index];

    if (char === "\\") {
      index += 2;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = undefined;
      }
      index += 1;
      continue;
    }

    if (char === "'" || char === `"`) {
      quote = char;
      index += 1;
      continue;
    }

    if (char === "(") {
      depth += 1;
      index += 1;
      continue;
    }

    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return {
          content: command.slice(openParenIndex + 1, index),
          endIndex: index
        };
      }
    }

    index += 1;
  }

  return undefined;
}

function readBacktickCommandSubstitution(
  command: string,
  openBacktickIndex: number
): { content: string; endIndex: number } | undefined {
  let content = "";
  let index = openBacktickIndex + 1;

  while (index < command.length) {
    const char = command[index];

    if (char === "\\") {
      const next = command[index + 1];
      if (next !== undefined) {
        content += `${char}${next}`;
        index += 2;
        continue;
      }
    }

    if (char === "`") {
      return {
        content,
        endIndex: index
      };
    }

    content += char;
    index += 1;
  }

  return undefined;
}

function readShellOperator(command: string, index: number): string | undefined {
  for (const operator of ["&>>", "&&", "||", ">>", ">|", "1>>", "2>>", "&>", "1>", "2>", ">", "|", ";"]) {
    if (command.startsWith(operator, index)) {
      return operator;
    }
  }

  return undefined;
}
